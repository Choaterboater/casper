/**
 * Commands auto mode's judge never decides (docs/adr/0002/47-auto-mode-judge.md): with no sandbox they always show
 * "Run this command?", whatever the judge would say, so a model mistake or words planted in a request or a file can't
 * run them unasked. A text check, read the same way as the host and routine checks (src/sandbox/remote.ts): every
 * command on the line, also inside `bash -c '…'`, `$(…)` and backticks. When Casper can't read such a command's target,
 * it asks.
 */
import path from "node:path";
import { isOutside } from "../platform/inside";
import { realpathLongest } from "../platform/project-paths";
import { commandSegments, commandStart, remoteTargets, splitShell } from "./remote";

export interface AskPlace { root: string; home: string }

/** Running as another user: sudo and the like. */
const PRIVILEGE = new Set(["sudo", "doas", "su", "pkexec", "runas", "gsudo"]);
/** Programs that download. */
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "aria2c", "http", "https", "xh", "invoke-webrequest", "iwr", "invoke-restmethod", "irm"]);
/** Programs that run what they read: a download piped into one runs code nobody looked at. */
const RUNNERS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash", "fish", "python", "python3", "python2", "node", "deno", "bun", "perl", "ruby", "php",
  "pwsh", "powershell", "iex", "invoke-expression", "source", "."]);
/** Disks, the machine itself and its services. */
const MACHINE = new Set(["dd", "fdisk", "sfdisk", "gdisk", "parted", "diskutil", "diskpart", "wipefs", "format", "format-volume", "clear-disk", "mount",
  "umount", "shutdown", "reboot", "halt", "poweroff", "stop-computer", "restart-computer", "systemctl", "launchctl", "crontab", "killall", "pkill",
  "set-executionpolicy", "visudo", "passwd", "useradd", "userdel", "usermod", "chsh", "apt", "apt-get", "dpkg", "yum", "dnf", "rpm", "pacman", "zypper",
  "apk", "snap"]);
/** Shared infrastructure and cloud accounts: anything they do reaches past this computer. */
const INFRASTRUCTURE = new Set(["aws", "gcloud", "gsutil", "az", "terraform", "tofu", "pulumi", "cdk", "kubectl", "helm", "oc", "eksctl", "doctl",
  "flyctl", "fly", "vercel", "netlify", "firebase", "heroku", "wrangler", "ansible", "ansible-playbook"]);
/** Of those, the ones that delete what they name: the project folder itself or its .git asks too. */
const DELETERS = new Set(["rm", "rmdir", "unlink", "shred", "srm", "trash", "mv", "remove-item", "del", "erase", "rd", "move-item"]);
/** Programs that delete, move, overwrite or change files named on the line: asked about when one is outside the project. */
const FILE_CHANGERS = new Set(["rm", "rmdir", "unlink", "shred", "srm", "trash", "mv", "cp", "ln", "truncate", "chmod", "chown", "chgrp", "install",
  "rsync", "tee", "touch", "mkdir", "find", "remove-item", "del", "erase", "rd", "move-item", "copy-item", "set-content", "out-file", "new-item"]);

/** Why this command always asks, or undefined when the judge may decide it. */
export function alwaysAsks(command: string, place: AskPlace): string | undefined {
  // Process substitution (`bash <(curl …)`) and an open quote: nothing Casper can read safely.
  if (/[<>]\(/.test(command)) return "it runs what another command prints";
  const line = splitShell(command);
  if (!line.segments.length || hasOpenQuote(command)) return "Casper can't read it";
  if (remoteTargets(command, place.home).length) return "it reaches another machine";
  const segments = commandSegments(command);
  const names = segments.map((segment) => programOf(segment.words));
  if (names.some((name) => DOWNLOADERS.has(name)) && runsDownload(command, segments)) return "it runs something it downloads";
  let cwd: string | undefined = place.root;
  for (const segment of segments) {
    const start = commandStart(segment.words);
    const before = segment.words.slice(0, start).map((word) => path.basename(word).toLowerCase());
    const name = programOf(segment.words);
    const args = segment.words.slice(start + 1);
    if (before.includes("eval")) return "it runs text as a command";
    if (before.some((word) => PRIVILEGE.has(word)) || PRIVILEGE.has(name) || (name === "start-process" && args.some((arg) => /^runas$/i.test(arg))))
      return "it runs as another user";
    if (MACHINE.has(name) || /^mkfs(?:\.|$)|^newfs/.test(name)) return "it changes the computer itself, not the project";
    if (INFRASTRUCTURE.has(name)) return "it reaches shared infrastructure or a cloud account";
    const publish = publishes(name, args);
    if (publish) return publish;
    if (name === "git") { const git = gitDanger(args); if (git) return git; }
    if (name === "cd" || name === "set-location" || name === "pushd") { cwd = moveTo(cwd, args, place); continue; }
    if (FILE_CHANGERS.has(name) || name === "dd") {
      const outside = outsidePath(name, args, cwd, place);
      if (outside) return outside;
    }
  }
  for (const target of redirectTargets(command)) {
    const where = resolvePlace(target, place.root, place);
    if (where === undefined || isOutside(path.relative(realpathLongest(place.root), realpathLongest(where)))) return "it writes outside the project";
  }
  return undefined;
}

/** A download fed to a program that runs it: `curl … | sh`, `wget -O- … | python3`, `bash -c "$(curl …)"`,
 * `iex (irm …)`. A download and a test run on the same line (`curl localhost/health && bun test`) is not. */
function runsDownload(command: string, segments: ReturnType<typeof commandSegments>): boolean {
  const pieces = pipePieces(command);
  for (let at = 1; at < pieces.length; at++) {
    const before = pieces.slice(0, at).join("|");
    const runner = programOf(splitShell(pieces[at]!).segments[0]?.words ?? []);
    if (RUNNERS.has(runner) && commandSegments(before).some((segment) => DOWNLOADERS.has(programOf(segment.words)))) return true;
  }
  const fetched = /(?:\$\(|`|\()\s*(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i;
  return segments.some((segment) => RUNNERS.has(programOf(segment.words)) && segment.words.some((word) => fetched.test(word)))
    || /\b(?:iex|invoke-expression)\b[^|;]*\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring)\b/i.test(command);
}

/** A line split at its pipes (not ||), quotes respected. */
function pipePieces(command: string): string[] {
  const pieces: string[] = [];
  let quote: string | undefined, start = 0;
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!;
    if (quote) { if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === "\"") { quote = char; continue; }
    if (char === "|" && command[at + 1] !== "|" && command[at - 1] !== "|" && command[at - 1] !== ">") { pieces.push(command.slice(start, at)); start = at + 1; }
  }
  pieces.push(command.slice(start));
  return pieces;
}

function hasOpenQuote(text: string): boolean {
  let quote: string | undefined;
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (quote) { if (char === quote) quote = undefined; else if (char === "\\" && quote === "\"") at++; }
    else if (char === "\\") at++;
    else if (char === "'" || char === "\"") quote = char;
  }
  return quote !== undefined;
}

function programOf(words: readonly string[]): string {
  return path.basename(words[commandStart([...words])] ?? "").replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/** Publishing a package or release, or a change on GitHub beyond a pull request. */
function publishes(name: string, args: readonly string[]): string | undefined {
  const verb = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
  if (["npm", "pnpm", "yarn", "bun"].includes(name) && ["publish", "unpublish", "deprecate", "dist-tag", "owner", "access"].includes(verb ?? ""))
    return "it publishes a package";
  if (name === "cargo" && ["publish", "yank", "owner"].includes(verb ?? "")) return "it publishes a package";
  if (["twine", "flit", "gem"].includes(name) && ["upload", "publish", "push", "yank"].includes(verb ?? "")) return "it publishes a package";
  if (["python", "python3"].includes(name) && args.includes("twine")) return "it publishes a package";
  if (["poetry", "hatch", "uv"].includes(name) && verb === "publish") return "it publishes a package";
  if (["docker", "podman", "buildah"].includes(name) && ["push", "login"].includes(verb ?? "")) return "it publishes an image";
  if (name === "gh") {
    const words = args.filter((arg) => !arg.startsWith("-")).map((arg) => arg.toLowerCase());
    if (words[0] === "release" && ["create", "upload", "delete", "edit"].includes(words[1] ?? "")) return "it changes a GitHub release";
    if (words[0] === "repo" && ["create", "delete", "edit", "rename", "archive", "fork"].includes(words[1] ?? "")) return "it changes a GitHub repository";
    if (words[0] === "pr" && ["merge", "close", "review"].includes(words[1] ?? "")) return "it merges, closes or reviews a pull request";
    if (["secret", "variable", "auth", "ssh-key", "gpg-key", "workflow"].includes(words[0] ?? "")) return "it changes GitHub settings";
  }
  return undefined;
}

/** A force push, a deleted remote branch, or git work that throws away changes. */
function gitDanger(args: readonly string[]): string | undefined {
  const verb = args.find((arg) => !arg.startsWith("-"));
  const rest = args.slice(args.indexOf(verb ?? "") + 1);
  if (verb === "push") {
    if (rest.some((arg) => /^--(?:force|force-with-lease|force-if-includes|mirror|delete|prune)\b/.test(arg) || /^-[a-zA-Z]*[fd]/.test(arg)
      || /^[+:]/.test(arg) || /^[^-][^:]*:$/.test(arg))) return "it force-pushes or deletes on the remote";
  }
  if (verb === "reset" && rest.some((arg) => arg === "--hard" || arg === "--merge" || arg === "--keep")) return "it throws away changes (git reset --hard)";
  if (verb === "clean" && rest.some((arg) => /^-[a-zA-Z]*f/.test(arg) || arg === "--force")) return "it deletes untracked files (git clean)";
  if (verb === "stash" && ["drop", "clear"].includes(rest[0] ?? "")) return "it throws away a stash";
  if (verb === "branch" && rest.some((arg) => arg === "-D" || /^-[a-zA-Z]*D/.test(arg) || arg === "--force")) return "it deletes a branch";
  if ((verb === "checkout" && rest.includes("--")) || (verb === "restore" && !rest.some((arg) => arg === "--staged" || arg === "-S")))
    return "it throws away changes to files";
  if (["filter-branch", "filter-repo", "update-ref", "reflog", "gc", "prune"].includes(verb ?? "")) return "it rewrites or prunes the history";
  if (verb === "remote" && ["add", "set-url", "remove", "rm", "rename"].includes(rest[0] ?? "")) return "it changes where pushes go";
  if (verb === "config" && rest.some((arg) => arg === "--global" || arg === "--system")) return "it changes git's settings for every project";
  return undefined;
}

/** Where `cd` leads, or undefined when Casper can't tell. */
function moveTo(cwd: string | undefined, args: readonly string[], place: AskPlace): string | undefined {
  const target = args.find((arg) => !arg.startsWith("-"));
  if (cwd === undefined) return undefined;
  if (target === undefined) return place.home;
  return resolvePlace(target, cwd, place);
}

/** A path word as the shell reads it: `~` and $HOME are home; any other expansion, `~user` or a glob at its start is
 * unknown (undefined). A glob later on keeps the part before it. */
function resolvePlace(word: string, cwd: string, place: AskPlace): string | undefined {
  let text = word.replace(/^~(?=\/|\\|$)/, place.home).replace(/\$(?:\{HOME\}|HOME\b)|\$env:USERPROFILE/gi, place.home);
  if (/^~|[$`]|%[A-Za-z_]+%/.test(text)) return undefined;
  // A drive or share path off Windows, where this file is not read as one.
  if (path.sep === "/" && /^(?:[A-Za-z]:|\\\\)/.test(text)) return undefined;
  const glob = text.search(/[*?[{]/);
  if (glob === 0) return undefined;
  if (glob > 0) text = text.slice(0, glob);
  return path.resolve(cwd, text);
}

/** The first file-changing argument outside the project (or one Casper can't place), as a reason. */
function outsidePath(name: string, args: readonly string[], cwd: string | undefined, place: AskPlace): string | undefined {
  const root = realpathLongest(place.root);
  // Option values that are not paths are skipped by taking only words that look like paths or plain names.
  const operands = name === "dd" ? args.filter((arg) => /^(?:of|if)=/.test(arg)).map((arg) => arg.slice(3))
    : name === "chmod" || name === "chown" || name === "chgrp" ? args.filter((arg) => !arg.startsWith("-")).slice(1)
      // find's paths come before its first test (-name, -path, (, !); the patterns after them are not places.
      : name === "find" ? args.slice(0, firstTest(args))
      : args.filter((arg) => !arg.startsWith("-") || arg === "-");
  for (const operand of operands) {
    if (operand === "-") continue;
    if (cwd === undefined) return "it changes files where Casper can't tell";
    const where = resolvePlace(operand, cwd, place);
    if (where === undefined) return "it changes files where Casper can't tell";
    const relative = path.relative(root, realpathLongest(where));
    if (isOutside(relative)) return "it changes files outside the project";
    // The project itself, or its .git: as damaging as outside it.
    if ((relative === "" || relative.split(/[\\/]/)[0] === ".git") && DELETERS.has(name))
      return "it changes the project folder itself or its .git";
  }
  return undefined;
}

function firstTest(args: readonly string[]): number {
  const at = args.findIndex((arg) => /^[-(!]/.test(arg));
  return at < 0 ? args.length : at;
}

/** `> file`, `>> file`, `2> file`: the files a line writes by redirection, as typed (descriptor copies like 2>&1 left out). */
function redirectTargets(command: string): string[] {
  const targets: string[] = [];
  let quote: string | undefined;
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!;
    if (quote) { if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === "\"") { quote = char; continue; }
    if (char !== ">") continue;
    while (command[at + 1] === ">" || command[at + 1] === "|") at++;
    if (command[at + 1] === "&") { at++; if (/^\d|^-/.test(command.slice(at + 1))) continue; }
    const rest = command.slice(at + 1).trimStart();
    const word = /^(?:"([^"]*)"|'([^']*)'|([^\s;&|<>]+))/.exec(rest);
    const target = word?.[1] ?? word?.[2] ?? word?.[3];
    if (target && target !== "/dev/null" && !/^nul$/i.test(target)) targets.push(target);
  }
  return targets;
}
