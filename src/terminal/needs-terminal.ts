import path from "node:path";
import { commandStart, segmentTargets, splitShell } from "../sandbox/remote";

/**
 * Which commands need the person at the terminal: an editor, a pager, a monitor, a REPL, a password or y/n prompt, a
 * login flow, `docker exec -it`, an interactive ssh. Casper hands such a command its terminal (src/terminal/hand-over.ts)
 * instead of running it with no keyboard, where it fails or waits forever. Read from the command's words only; the AI
 * also gets one handed over by sending again a command that failed for want of a terminal (TERMINAL_NEEDED).
 *
 * "remote-sudo" is a plain ssh whose remote command uses sudo: it gets the terminal with -t, so sudo on the other machine
 * asks at its own prompt (Casper's hidden box is only for sudo on this machine).
 */
export type TerminalNeed = "interactive" | "remote-sudo";

/** Programs that are interactive whatever their arguments. */
const ALWAYS = new Set(["vi", "vim", "nvim", "view", "vimdiff", "nano", "pico", "micro", "joe", "mcedit", "htop", "btop", "atop", "nmtui",
  "mc", "ranger", "tig", "lazygit", "ncdu", "passwd", "su", "login", "visudo", "vipw", "vigr", "chsh", "chfn", "sudoedit", "ssh-copy-id", "mosh"]);
/** Pagers and man: interactive when the whole command is the one program (`man ls | col -b` is not). */
const PAGERS = new Set(["less", "more", "most", "man"]);
/** REPLs: interactive with no script, file or code to run. */
const REPLS = new Set(["python", "python3", "node", "bun", "deno", "irb", "ghci", "lua", "sqlite3"]);
/** Database shells: interactive unless they are given a command or a file. */
const DB_SHELLS: Record<string, RegExp> = {
  psql: /^(?:-c|--command|-f|--file|-l|--list)(?:=|$)/, mysql: /^(?:-e|--execute|--batch|-B)(?:=|$)/, mariadb: /^(?:-e|--execute|--batch|-B)(?:=|$)/,
  mongosh: /^(?:--eval|-f|--file)(?:=|$)/, "redis-cli": /^-x$/,
};
const SUDO_WORD = /(?:^|[\s;&|(])sudo(?:\s|$)/;

const has = (words: readonly string[], pattern: RegExp) => words.some((word) => pattern.test(word));
/** A short flag alone or in a cluster: -it, -ti, -i -t. */
const shortFlag = (words: readonly string[], flag: string) => words.some((word) => /^-[A-Za-z]+$/.test(word) && word.slice(1).includes(flag));

function containerTty(args: readonly string[]): boolean {
  const options = args.filter((word) => word.startsWith("-"));
  return (shortFlag(options, "i") || options.includes("--interactive") || options.includes("--stdin")) && (shortFlag(options, "t") || options.includes("--tty"));
}

function segmentNeed(words: string[], alone: boolean): TerminalNeed | undefined {
  const start = commandStart(words);
  const program = words[start];
  if (!program) return undefined;
  // `command -v tmux` only asks where a program is.
  if (words.slice(0, start).some((word, at) => path.basename(word) === "command" && /^-[vV]$/.test(words[at + 1] ?? ""))) return undefined;
  const name = path.basename(program).replace(/\.exe$/i, "").toLowerCase();
  const args = words.slice(start + 1);
  const sub = args.filter((word) => !word.startsWith("-"));
  if (name === "emacs") return has(args, /^-{1,2}(?:batch|script|eval)$/) ? undefined : "interactive";
  if (ALWAYS.has(name)) return "interactive";
  if (PAGERS.has(name)) return alone ? "interactive" : undefined;
  if (name === "top") return alone && !has(args, /^-(?:[bl]|n\d*)$/) ? "interactive" : undefined;
  if (REPLS.has(name)) return alone && (name === "sqlite3" ? sub.length <= 1 : args.length === 0) ? "interactive" : undefined;
  const db = DB_SHELLS[name];
  if (db) return alone && !has(args, db) && (name !== "redis-cli" || sub.length === 0) ? "interactive" : undefined;
  if (name === "tmux") return !sub.length || ["attach", "a", "attach-session"].includes(sub[0]!) || (["new", "new-session"].includes(sub[0]!) && !shortFlag(args, "d")) ? "interactive" : undefined;
  if (name === "screen") return !args.length || has(args, /^-[rRx]$/) ? "interactive" : undefined;
  if (name === "crontab") return args.includes("-e") ? "interactive" : undefined;
  if (name === "git") {
    const [verb] = sub;
    if (verb === "rebase" && has(args, /^(?:-i|--interactive)$/)) return "interactive";
    return ["add", "checkout", "reset", "stash", "restore"].includes(verb ?? "") && has(args, /^(?:-p|--patch|-i|--interactive)$/) ? "interactive" : undefined;
  }
  if (name === "docker" || name === "podman" || name === "nerdctl") {
    const verb = sub[0] === "container" ? sub[1] : sub[0];
    if (verb === "attach") return "interactive";
    if ((verb === "exec" || verb === "run") && containerTty(args)) return "interactive";
    return verb === "login" && !has(args, /^(?:-p|--password|--password-stdin)(?:=|$)/) ? "interactive" : undefined;
  }
  if (name === "kubectl" || name === "oc") {
    const verb = sub[0];
    return verb === "attach" || ((verb === "exec" || verb === "run" || verb === "debug") && containerTty(args)) ? "interactive" : undefined;
  }
  if (name === "gh") return sub[0] === "auth" && sub[1] === "login" && !args.includes("--with-token") ? "interactive" : undefined;
  if (name === "npm") return sub[0] === "login" || sub[0] === "adduser" ? "interactive" : undefined;
  if (name === "aws") return sub.length === 1 && sub[0] === "configure" ? "interactive" : undefined;
  if (name === "gcloud") return sub[0] === "init" || (sub[0] === "auth" && sub[1] === "login" && !has(args, /^--cred-file/)) ? "interactive" : undefined;
  if (name === "apt" || name === "apt-get" || name === "dnf" || name === "yum") {
    return ["install", "remove", "purge", "upgrade", "full-upgrade", "dist-upgrade", "autoremove", "reinstall"].includes(sub[0] ?? "")
      && !has(args, /^(?:--yes|--assume-yes|-qq)$/) && !shortFlag(args, "y") ? "interactive" : undefined;
  }
  if (name === "ssh") {
    const parsed = segmentTargets(words);
    if (!parsed.targets.length) return undefined;
    const remoteSudo = SUDO_WORD.test(parsed.remote.join(" "));
    // `ssh -t host top`: the command asks for a terminal. A bare `ssh host` is often a reachability check, so it isn't.
    if (parsed.values.some(([flag]) => flag === "-t")) return remoteSudo ? "remote-sudo" : "interactive";
    if (remoteSudo) return "remote-sudo";
  }
  return undefined;
}

/** What `command` needs from the terminal, if anything: "interactive" wins over "remote-sudo". A pager, REPL or database
 * shell counts only as the whole command, with no pipe or input redirect feeding or reading it. */
export function terminalNeed(command: string): TerminalNeed | undefined {
  const line = splitShell(command);
  const alone = line.segments.length === 1 && !/(?:^|[^<])<(?!<)|\|/.test(command);
  let found: TerminalNeed | undefined;
  for (const segment of line.segments) {
    const need = segmentNeed(segment.words, alone);
    if (need === "interactive") return need;
    found ??= need;
  }
  return found;
}

/** What a command prints when it ran without a terminal and needed one. */
export const TERMINAL_NEEDED = /a terminal is required|not a (?:tty|terminal)\b|Inappropriate ioctl for device|input device is not a TTY|must be run (?:from|in) a terminal|requires? an? (?:interactive )?(?:terminal|tty)\b|stdin is not a tty|Input is not from a terminal|no tty present|(?:cannot|could not|can't|unable to) open \/dev\/tty|Pseudo-terminal will not be allocated|Output is not to a terminal/i;
