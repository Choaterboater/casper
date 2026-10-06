import { splitShell } from "../sandbox/remote";

/** Words that run the command after them: `sudo git ...`, `nice -n 5 git ...`. */
const WRAPPERS = new Set(["sudo", "command", "exec", "env", "time", "nice", "nohup"]);
/** git's own options before the subcommand that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source", "--list-cmds"]);

/** The subcommand and its words when `words` runs git (any path to it, quoted or not), after wrappers and git's own options. */
function gitCall(words: string[]): { sub: string; args: string[] } | undefined {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    if (/^[A-Za-z_]\w*=/.test(word)) { index++; continue; }
    if (!WRAPPERS.has(word)) break;
    index++;
    while (index < words.length && words[index]!.startsWith("-")) index += word === "nice" && words[index] === "-n" ? 2 : 1;
  }
  const program = (words[index] ?? "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
  if (program !== "git") return undefined;
  for (index++; index < words.length && words[index]!.startsWith("-"); index++) if (GIT_VALUE_OPTIONS.has(words[index]!)) index++;
  const sub = words[index];
  return sub ? { sub, args: words.slice(index + 1) } : undefined;
}

/** Git commands a model's bash call may not run: each can set aside or throw away the user's uncommitted
 * work (the user may run them). Reads each command in a shell line (split on ; && || | & and newlines), with
 * quotes taken off, so `git -P clean`, `/usr/bin/git clean` and `\git clean` count too.
 * A lexical check, not a sandbox: an alias, a script or `sh -c` can still get past it. */
export function blockedGitCommand(command: string): string | undefined {
  for (const segment of splitShell(command).segments) {
    const call = gitCall(segment.words);
    if (!call) continue;
    const { sub, args } = call;
    const has = (...flags: string[]) => args.some((arg) => flags.includes(arg) || flags.some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`)));
    let blocked = false;
    switch (sub) {
      case "stash": blocked = !["list", "show"].includes(args[0] ?? ""); break;
      case "reset": blocked = has("--hard", "--merge", "--keep"); break;
      case "checkout": blocked = has("--", ".", "-f", "--force", "-p", "--patch") || args.some((arg) => arg.startsWith(":")); break;
      case "restore": blocked = !(args.length && args.every((arg) => arg === "--staged" || arg === "-S" || !arg.startsWith("-")) && has("--staged", "-S") && !has("--worktree", "-W")); break;
      case "switch": blocked = has("--discard-changes", "-f", "--force"); break;
      case "clean": blocked = !has("-n", "--dry-run"); break;
    }
    if (blocked) return `git ${sub}${args.length ? ` ${args.join(" ")}` : ""}`;
  }
  return undefined;
}

/** The refusal the AI sees for a blocked git command, from bash or the service tool alike. */
export function gitGuardReason(command: string): string | undefined {
  const risky = blockedGitCommand(command);
  return risky ? `Casper does not let the model run \`${risky}\`: it can set aside or discard the user's uncommitted work. Leave the working tree as it is, or ask the user to run it.` : undefined;
}
