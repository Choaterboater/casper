import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { splitShell } from "./remote";

/**
 * With no sandbox (Windows, bubblewrap missing), the AI's shell asks before each command. Two things keep that from
 * becoming dozens of boxes a task: commands that only read (ls, git status, grep) run without asking, and a "don't ask
 * again" answer covers a command prefix (npm test, git commit), never a whole interpreter. A text check, not a shell
 * parser: anything it can't read plainly is not read-only and gets no prefix, so it asks as before. With no sandbox
 * nothing else stands behind it, so a glob, a link that leads out of the project and any option that runs a program
 * ask too.
 */

const FOLLOWS_GREP = /^-[A-Za-z]*R|^--dereference-recursive$/;

/** Programs that only read, with the options that would make them write or run something else. */
const READERS: Record<string, RegExp | undefined> = {
  ls: undefined, pwd: undefined, cat: undefined, head: undefined, tail: undefined, wc: undefined, nl: undefined,
  // grep -R and rg -L follow links inside folders, which can lead out of the project.
  grep: FOLLOWS_GREP, egrep: FOLLOWS_GREP, fgrep: FOLLOWS_GREP, rg: /^--(?:pre(?:-glob)?|hostname-bin|follow)(?:=|$)|^-[A-Za-z]*L/,
  find: /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/,
  which: undefined, whereis: undefined, file: undefined, stat: undefined, du: undefined, df: undefined, tree: /^-o$/,
  echo: undefined, printf: undefined, basename: undefined, dirname: undefined, realpath: undefined, readlink: undefined,
  uname: undefined, whoami: undefined, id: undefined, date: undefined, hostname: undefined, true: undefined, false: undefined,
  // sort -o writes and --compress-program runs a program; diff -r follows links inside folders.
  sort: /^-[A-Za-z]*o|^--(?:output|compress-program)(?:=|$)/, cut: undefined, tr: undefined, diff: /^-[A-Za-z]*r|^--recursive$/, cmp: undefined, comm: undefined,
  md5sum: undefined, sha1sum: undefined, sha256sum: undefined, shasum: undefined, uniq: undefined,
};

/** git subcommands that only read, and the options of any git command that write a file or run a program. */
const GIT_READERS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "grep", "branch", "remote", "tag"]);
/** --output writes; --ext-diff and -O / --open-files-in-pager (git grep -Osh runs sh on each match) run a program. */
const GIT_WRITES = /^--(?:output|ext-diff|open-files-in-pager)(?:=|$)|^-[A-Za-z]*O/;
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

/** True when an unquoted * ? [ or { would make the shell pick the files: `cat .en*` can't be checked by its text. */
function hasGlob(text: string): boolean {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) { if (char === quote) quote = undefined; else if (char === "\\" && quote === "\"") index++; continue; }
    if (char === "'" || char === "\"") quote = char;
    else if (char === "\\") index++;
    else if ("*?[{".includes(char)) return true;
  }
  return false;
}

/** A word naming a file that is really somewhere else: a link out of the project, or to a key or .env file. */
function leadsOut(word: string, root: string, realRoot: string): boolean {
  const value = word.includes("=") && word.startsWith("-") ? word.slice(word.indexOf("=") + 1) : word;
  if (!value) return false;
  const absolute = path.resolve(root, value);
  try { lstatSync(absolute); } catch { return false; }
  let real: string;
  try { real = realpathSync(absolute); } catch { return true; }
  const relative = path.relative(realRoot, real);
  return relative.startsWith("..") || path.isAbsolute(relative) || PRIVATE_NAME.test(real.split(path.sep).join("/"));
}

function readerSegment(words: string[], root?: string): boolean {
  const [name, ...args] = words;
  if (!name || name.includes("=") || name.includes("/")) return false;
  if (args.some((arg) => outside(arg) || PRIVATE_NAME.test(arg))) return false;
  if (root) {
    const realRoot = existsSync(root) ? realpathSync(root) : root;
    if (args.some((arg) => leadsOut(arg, root, realRoot))) return false;
  }
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
 * background job, no glob, nothing outside the project or private. Pipes and && between readers are fine. Given the
 * project `root`, a file that is a link (or sits in a linked folder) must really be in the project too. */
export function readOnlyCommand(command: string, root?: string): boolean {
  const text = command.trim();
  if (!text || /[<>`]|\$\(|(?:^|[^&])&(?!&)/.test(text) || hasGlob(text)) return false;
  const line = splitShell(text);
  return line.segments.length > 0 && line.segments.every((segment) => readerSegment(segment.words, root));
}

/** Programs that run whatever follows them: never a prefix of their own. Matched on the plain name, so python3.12,
 * node.exe and PowerShell.exe count too. */
const NO_PREFIX = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "py", "node", "deno", "ruby", "perl", "php", "lua", "pwsh",
  "powershell", "cmd", "sudo", "doas", "env", "xargs", "eval", "exec", "nohup", "time", "timeout", "watch", "nice", "npx", "bunx", "pnpx", "uvx",
  "source", ".", "ssh", "scp", "sftp", "rsync", "nc", "telnet", "socat", "awk", "gawk", "mawk", "nawk", "sed", "find", "osascript", "tsx",
  "ts-node", "cscript", "wscript", "mshta", "rundll32", "start", "command", "busybox", "stdbuf", "setsid", "caffeinate", "ionice", "script"]);
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
  if (!name || name.includes("=")) return undefined;
  const plain = plainName(name);
  if (NO_PREFIX.has(plain)) return undefined;
  if (!SUBCOMMANDS.has(plain) || !words[1]) return name;
  // `git -C sub commit`, `npm --prefix x test`, `cargo +nightly build`: an option first, so the exact command only.
  if (!/^[A-Za-z]/.test(words[1])) return undefined;
  if (!RUNNERS.has(words[1])) return `${name} ${words[1]}`;
  return words[2] && !words[2].startsWith("-") ? `${name} ${words[1]} ${words[2]}` : undefined;
}

/** A program's plain name: no folder, no .exe/.cmd/.bat/.ps1, no version (python3.12, node20), lower case. */
function plainName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/, "");
  return base.replace(/[\d.-]+$/, "") || base;
}

/** True when `command` is one plain command starting with the prefix's words. */
export function matchesPrefix(command: string, prefix: string): boolean {
  const line = splitShell(command.trim());
  if (!line.simple) return false;
  const words = line.segments[0]?.words ?? [];
  const wanted = prefix.split(" ");
  return wanted.every((word, index) => words[index] === word);
}
