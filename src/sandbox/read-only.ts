import path from "node:path";
import { splitShell } from "./remote";

/**
 * With no sandbox (Windows, bubblewrap missing), the AI's shell asks before each command. Two things keep that from
 * becoming dozens of boxes a task: commands that only read (ls, git status, grep) run without asking, and a "don't ask
 * again" answer covers a command prefix (npm test, git commit), never a whole interpreter. A text check, not a shell
 * parser: anything it can't read plainly is not read-only and gets no prefix, so it asks as before.
 */

/** Programs that only read, with the options that would make them write or run something else. */
const READERS: Record<string, RegExp | undefined> = {
  ls: undefined, pwd: undefined, cat: undefined, head: undefined, tail: undefined, wc: undefined, nl: undefined,
  grep: undefined, egrep: undefined, fgrep: undefined, rg: /^--pre(?:-glob)?(?:=|$)/,
  find: /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/,
  which: undefined, whereis: undefined, file: undefined, stat: undefined, du: undefined, df: undefined, tree: /^-o$/,
  echo: undefined, printf: undefined, basename: undefined, dirname: undefined, realpath: undefined, readlink: undefined,
  uname: undefined, whoami: undefined, id: undefined, date: undefined, hostname: undefined, true: undefined, false: undefined,
  sort: /^(?:-o|--output)/, cut: undefined, tr: undefined, diff: undefined, cmp: undefined, comm: undefined, jq: undefined,
  md5sum: undefined, sha1sum: undefined, sha256sum: undefined, shasum: undefined, uniq: undefined,
};

/** git subcommands that only read, and the options of any git command that write a file or run a program. */
const GIT_READERS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "grep", "branch", "remote", "tag"]);
const GIT_WRITES = /^--(?:output|ext-diff)(?:=|$)/;
/** git branch, remote and tag only list with these (anything else creates, renames or deletes). */
const GIT_LIST_ONLY: Record<string, RegExp> = {
  branch: /^(?:-a|-r|-v|-vv|--all|--list|--show-current|--no-color|--color)$/, remote: /^-v$/, tag: /^(?:-l|--list)$/,
};

/** Files a read must not print to the AI, project or not: keys, logins and .env files. */
const PRIVATE_NAME = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials(?:\.\w+)?)$/;

/** A word that points outside the project, or at something Casper can't see from the text ($HOME, ~, /etc, ..). */
function outside(word: string): boolean {
  const value = word.includes("=") && word.startsWith("-") ? word.slice(word.indexOf("=") + 1) : word;
  return value.startsWith("/") || value.startsWith("~") || value.includes("$") || value.split(/[\\/]/).includes("..") || /^[A-Za-z]:/.test(value);
}

function readerSegment(words: string[]): boolean {
  const [name, ...args] = words;
  if (!name || name.includes("=") || name.includes("/")) return false;
  if (args.some((arg) => outside(arg) || PRIVATE_NAME.test(arg))) return false;
  if (name === "git") {
    const [sub, ...rest] = args;
    if (!sub || !GIT_READERS.has(sub) || rest.some((arg) => GIT_WRITES.test(arg))) return false;
    const listOnly = GIT_LIST_ONLY[sub];
    return !listOnly || rest.every((arg) => listOnly.test(arg));
  }
  if (!(name in READERS)) return false;
  const writes = READERS[name];
  if (writes && args.some((arg) => writes.test(arg))) return false;
  // `uniq in out` writes its second file.
  if (name === "uniq" && args.filter((arg) => !arg.startsWith("-")).length > 1) return false;
  return true;
}

/** True when every command on the line only reads files in the project: no redirect, no substitution, no
 * background job, nothing outside the project or private. Pipes and && between readers are fine. */
export function readOnlyCommand(command: string): boolean {
  const text = command.trim();
  if (!text || /[<>`]|\$\(|(?:^|[^&])&(?!&)/.test(text)) return false;
  const line = splitShell(text);
  return line.segments.length > 0 && line.segments.every((segment) => readerSegment(segment.words));
}

/** Programs that run whatever follows them: never a prefix of their own. */
const NO_PREFIX = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python3", "node", "deno", "ruby", "perl", "php", "lua", "pwsh",
  "powershell", "cmd", "sudo", "doas", "env", "xargs", "eval", "exec", "nohup", "time", "timeout", "watch", "nice", "npx", "bunx", "pnpx", "uvx",
  "source", ".", "ssh", "scp", "sftp", "rsync", "nc", "telnet", "socat"]);
/** Tools whose second word is a subcommand: the prefix keeps it (git commit, npm test, cargo build). */
const SUBCOMMANDS = new Set(["git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "docker", "kubectl", "pip", "pip3", "uv", "poetry", "dotnet",
  "mvn", "gradle", "brew", "apt", "apt-get", "systemctl", "gh", "terraform", "helm", "make", "deno"]);
/** Subcommands that run any script or program: the prefix keeps the next word too (npm run build, uv run pytest). */
const RUNNERS = new Set(["run", "exec", "x", "dlx", "tool"]);

/** The prefix a "don't ask again" answer covers: `npm test`, `git commit`, `npm run build`, `pytest`. Undefined for
 * a line with more than one command, a redirect or a substitution, a VAR=value start or an interpreter: those are
 * remembered as the exact command only. */
export function commandPrefix(command: string): string | undefined {
  const line = splitShell(command.trim());
  if (!line.simple) return undefined;
  const words = line.segments[0]?.words ?? [];
  const name = words[0];
  if (!name || name.includes("=") || NO_PREFIX.has(path.basename(name))) return undefined;
  if (!SUBCOMMANDS.has(path.basename(name)) || !words[1] || words[1].startsWith("-")) return name;
  if (!RUNNERS.has(words[1])) return `${name} ${words[1]}`;
  return words[2] && !words[2].startsWith("-") ? `${name} ${words[1]} ${words[2]}` : undefined;
}

/** True when `command` is one plain command starting with the prefix's words. */
export function matchesPrefix(command: string, prefix: string): boolean {
  const line = splitShell(command.trim());
  if (!line.simple) return false;
  const words = line.segments[0]?.words ?? [];
  const wanted = prefix.split(" ");
  return wanted.every((word, index) => words[index] === word);
}
