import path from "node:path";
import { commandStart, segmentTargets, splitShell } from "../sandbox/remote";

/**
 * Which commands need the person at the terminal: an editor, a pager, a monitor, a REPL, a password or y/n prompt, a
 * login flow, `docker exec -it`, an interactive ssh. Casper hands such a command its terminal (src/terminal/hand-over.ts)
 * instead of running it with no keyboard, where it fails or waits forever. Read from the command's words only; the AI
 * also gets one handed over by sending again a command that failed for want of a terminal (TERMINAL_NEEDED).
 *
 * "remote-sudo" is a plain ssh whose remote command uses sudo: it gets the terminal with -t, so sudo on the other machine
 * asks at its own prompt (Casper's hidden box is only for sudo on this machine). Not `sudo -n` or `--non-interactive`,
 * which never ask, and no ssh with `-o BatchMode=yes`: the terminal stays Casper's and the AI reads the output.
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
/** Each sudo in a remote command, with the option words after it. */
const SUDO_RUN = /(?:^|[\s;&|(])sudo((?:\s+-\S*)*)(?=\s|$)/g;
/** sudo's short options that take a value: in `-nu root` the n counts, in `-un` the n is the user. */
const SUDO_VALUE = new Set("ugCDhprtTU");

/** Whether a sudo with these options may ask for a password: not with -n or --non-interactive. */
function sudoMayAsk(options: string): boolean {
  for (const word of options.trim().split(/\s+/).filter(Boolean)) {
    if (word === "--non-interactive") return false;
    if (word.startsWith("--")) continue;
    for (const letter of word.slice(1)) {
      if (letter === "n") return false;
      if (SUDO_VALUE.has(letter)) break;
    }
  }
  return true;
}

/** Whether a remote command runs a sudo that may ask on the other machine's terminal. */
function remoteSudoMayAsk(remote: string): boolean {
  return [...remote.matchAll(SUDO_RUN)].some((match) => sudoMayAsk(match[1] ?? ""));
}

/** `-o BatchMode=yes` (or `-oBatchMode yes`): ssh is told never to ask anything. */
const batchMode = (values: ReadonlyArray<[string, string]>) => values.some(([flag, value]) => flag === "-o" && /^\s*batchmode\s*[=\s]\s*yes\s*$/i.test(value));

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
    // BatchMode=yes: the AI asked for an ssh that never waits on a person, so nothing is handed over.
    if (!parsed.targets.length || batchMode(parsed.values)) return undefined;
    const remoteSudo = remoteSudoMayAsk(parsed.remote.join(" "));
    // `ssh -t host top`: the command asks for a terminal. A bare `ssh host` is often a reachability check, so it isn't.
    if (parsed.values.some(([flag]) => flag === "-t")) return remoteSudo ? "remote-sudo" : "interactive";
    if (remoteSudo) return "remote-sudo";
  }
  return undefined;
}

/**
 * The command with each heredoc's lines taken out (`<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF`, up to the end word alone on
 * its line): they are what the command reads, so a `/login` route in a file written with `cat <<EOF` is not the login
 * program. A command after the end word stays. `<<<` and `<<` inside `$(( ))` are not heredocs, nor is one in quotes or a
 * comment. Only for this check: splitShell keeps the lines, since `bash <<EOF` or `ssh host <<EOF` runs them.
 */
function withoutHeredocLines(command: string): { text: string; heredoc: boolean } {
  let text = "";
  let quote: string | undefined;
  let arithmetic = 0;
  let heredoc = false;
  const pending: Array<{ end: string; tabs: boolean }> = [];
  let index = 0;
  while (index < command.length) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === "\"" && next !== undefined) { text += char + next; index += 2; continue; }
      text += char; index++; continue;
    }
    if (char === "\\" && next !== undefined) { text += char + next; index += 2; continue; }
    if (char === "'" || char === "\"") { quote = char; text += char; index++; continue; }
    if (char === "#" && /^$|[\s;&|()]/.test(command[index - 1] ?? "")) {
      const stop = command.indexOf("\n", index);
      const end = stop < 0 ? command.length : stop;
      text += command.slice(index, end); index = end; continue;
    }
    if (char === "(" && next === "(") { arithmetic++; text += "(("; index += 2; continue; }
    if (char === ")" && next === ")" && arithmetic) { arithmetic--; text += "))"; index += 2; continue; }
    if (char === "<" && next === "<" && !arithmetic) {
      if (command[index + 2] === "<") { text += "<<<"; index += 3; continue; }
      let at = index + 2;
      const tabs = command[at] === "-";
      if (tabs) at++;
      while (command[at] === " " || command[at] === "\t") at++;
      // The end word, with its quotes and backslashes taken off: <<'EOF', <<"EOF" and <<\EOF all end at EOF.
      let end = "";
      let word = false;
      let wordQuote: string | undefined;
      for (; at < command.length; at++) {
        const letter = command[at]!;
        if (wordQuote) { if (letter === wordQuote) wordQuote = undefined; else end += letter; continue; }
        if (letter === "'" || letter === "\"") { wordQuote = letter; word = true; continue; }
        if (letter === "\\" && at + 1 < command.length) { end += command[++at]; word = true; continue; }
        if (/[\s;&|<>()]/.test(letter)) break;
        end += letter; word = true;
      }
      if (word) { pending.push({ end, tabs }); heredoc = true; }
      text += command.slice(index, at); index = at; continue;
    }
    if (char === "\n" && pending.length) {
      text += char; index++;
      // Each heredoc on the line reads its own lines in turn; one with no end word reads to the end, as bash does.
      for (const { end, tabs } of pending) {
        while (index < command.length) {
          const stop = command.indexOf("\n", index);
          const line = command.slice(index, stop < 0 ? command.length : stop);
          index = stop < 0 ? command.length : stop + 1;
          if ((tabs ? line.replace(/^\t+/, "") : line) === end) break;
        }
      }
      pending.length = 0;
      continue;
    }
    text += char; index++;
  }
  return { text, heredoc };
}

/** What `command` needs from the terminal, if anything: "interactive" wins over "remote-sudo". A pager, REPL or database
 * shell counts only as the whole command, with no pipe, input redirect or heredoc feeding or reading it. */
export function terminalNeed(command: string): TerminalNeed | undefined {
  const { text, heredoc } = withoutHeredocLines(command);
  const line = splitShell(text);
  const alone = !heredoc && line.segments.length === 1 && !/(?:^|[^<])<(?!<)|\|/.test(text);
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
