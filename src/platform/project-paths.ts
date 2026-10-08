import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandSegments } from "../sandbox/remote";
import { isOutside } from "./inside";

/**
 * Where a path the AI's file tools name really points. One list of private paths is shared by the
 * file tool gate here and, later, the shell sandbox. The gate is a check before the tool runs, on
 * the resolved path (realpath of the longest part that exists), so a link anywhere in the path counts.
 * It is not a sandbox: a shell command can still read these files (see docs/SECURITY.md).
 */

/** Private places under your home folder: keys, logins and cloud credentials. */
export const PRIVATE_PATHS: readonly string[] = [
  ".ssh", ".aws", ".gnupg", ".config/gh", ".kube", ".docker/config.json", ".netrc", ".git-credentials", ".claude.json", ".mcp.json",
  ".claude/.credentials.json", ".casper/agent/auth.json", ".casper/mcp-consent.key", ".casper/packs.key", ".casper/network-logins.json", ".pi/agent/auth.json", "Library/Keychains",
  ".config/gcloud", ".azure", ".oci", ".terraform.d/credentials.tfrc.json", ".pgpass", ".npmrc", ".pypirc", ".config/hub",
  ".password-store", ".local/share/keyrings",
  // Casper's own: MCP servers (their tokens), profiles (each may hold an mcp.json) and every project's saved conversations.
  ".casper/mcp.json", ".casper/profiles", ".casper/agent/sessions",
  // The private ssh login's per-run socket folders (src/ssh/askpass.ts).
  ".casper/run",
  // Provider settings, which may hold provider keys.
  ".casper/agent/models.json", ".pi/agent/models.json",
];

/** Casper's own records: approvals, lab answers, remembered hosts, undo copies; MCP consent and skill trust; the packs
 * you added and their record. */
export const CASPER_PRIVATE_PATHS: readonly string[] = [".casper/projects", ".casper/mcp-consent.json", ".casper/skills-trust.json", ".casper/packs", ".casper/packs.json"];

/** Home files the AI may read but never change: Casper's and Pi's own state, shell start-up files, git's settings. */
export const PROTECTED_WRITE_PATHS: readonly string[] = [
  ".casper", ".pi", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin",
  ".config/fish", ".gitconfig", ".config/git", ".ssh",
];

export type PathClass = "inside" | "outside" | "linksOut" | "private" | "protected" | "gitInternal";

export interface PathContext {
  /** The project folder the session runs in. */
  root: string;
  home?: string;
  /** Pi's state folder (CASPER_AGENT_DIR): its auth.json is private too. */
  agentDir?: string;
  /** The project's sandbox.denyRead, as absolute paths: private to the file tools as well as to shell commands. */
  denyRead?: readonly string[];
}

const UNICODE_SPACES = /[  -   　]/g;

/** Git Bash, MSYS, Cygwin and WSL drive paths (/c/Users, /mnt/c/Users, /cygdrive/c/Users, /proc/cygdrive/c/Users) as
 * Windows names them (C:\Users). Pi's tools do this on Windows before opening a path, so the checks must too. */
export function windowsShellPath(input: string): string {
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("\\")) return input;
  const match = /^\/(?:mnt\/|(?:proc\/)?cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(input);
  return match ? `${match[1]!.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}` : input;
}

/** A Windows path that names a drive another way, as that drive's path: a drive's admin share (\\host\C$\Users,
 * \\?\UNC\host\C$\Users) and a device path (\\?\C:\Users, \\.\C:\Users), with either slash. Only for the private-place
 * checks: a share on another machine is not this drive, so a file is never opened by this name. */
function windowsDrivePath(input: string): string {
  if (process.platform !== "win32") return input;
  const match = /^[\\/]{2}(?:[?.][\\/]+(?:UNC[\\/]+)?)?(?:[^\\/]+[\\/]+([a-z])\$|([a-z]):)(?=[\\/]|$)[\\/]*(.*)$/is.exec(input);
  return match ? `${(match[1] ?? match[2])!.toUpperCase()}:\\${match[3]!.replaceAll("/", "\\")}` : input;
}

/** The absolute path a native tool will use for `input`: the same steps as Pi's resolveToCwd. */
export function resolveToolPath(input: string, cwd: string, home = os.homedir()): string {
  let normal = input.replace(UNICODE_SPACES, " ");
  if (normal.startsWith("@")) normal = normal.slice(1);
  if (process.platform === "win32") normal = windowsShellPath(normal);
  if (normal === "~") return home;
  if (normal.startsWith("~/") || (process.platform === "win32" && normal.startsWith("~\\"))) return path.join(home, normal.slice(2));
  if (/^file:\/\//.test(normal)) { try { return fileURLToPath(normal); } catch { /* keep as typed */ } }
  return path.resolve(cwd, normal);
}

/** Windows' own realpath also turns 8.3 short names (C:\Users\RUNNER~1) into the long ones. Node's JS realpath keeps
 * them, so ~/.ssh named through a short name would not match. Other systems keep the JS one. */
const realpath = process.platform === "win32" ? realpathSync.native : realpathSync;

/** realpath of the longest part of the path that exists, with the rest added back. */
export function realpathLongest(absolute: string): string {
  let current = path.resolve(absolute);
  const rest: string[] = [];
  for (;;) {
    try { return path.join(realpath(current), ...rest.reverse()); }
    catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(absolute);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

const same = (a: string, b: string) => process.platform === "win32" || process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** True when `child` is `parent` or inside it. */
export function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (!relative) return true;
  if (process.platform === "win32" || process.platform === "darwin") {
    const lower = path.relative(parent.toLowerCase(), child.toLowerCase());
    return !isOutside(lower);
  }
  return !isOutside(relative);
}

function variants(absolute: string): string[] {
  const drive = windowsDrivePath(absolute);
  return [...new Set([absolute, realpathLongest(absolute), ...(drive === absolute ? [] : [drive, realpathLongest(drive)])])];
}

/** Private places, each as typed (~/.ssh) and as its absolute paths. */
export interface PrivatePlace {
  shown: string;
  paths: string[];
  /** Why it is private, for the refusal: "keys and logins", or the project's own denyRead. */
  why: string;
  /** Whether a search of a folder that holds it is refused too. Not for a denyRead folder inside the project:
   * a search of the project still runs (the sandbox hides that folder from shell commands). */
  below: boolean;
  /** A part of the place that is not private, by its path inside the place (the browser's pictures under ~/.casper/projects). */
  open?: (inside: string) => boolean;
}

/** The browser tool's pictures, <project state>/browser/..., which it tells the AI to read. */
function browserPictures(inside: string): boolean {
  const parts = inside.split(/[\\/]/);
  return parts.length > 2 && parts[1] === "browser" && !parts.includes("..");
}

export function privatePlaces(context: PathContext): PrivatePlace[] {
  const home = context.home ?? os.homedir();
  const why = "keys and logins";
  const places: PrivatePlace[] = PRIVATE_PATHS.map((entry) => ({ shown: `~/${entry}`, paths: variants(path.join(home, entry)), why, below: true }));
  for (const entry of CASPER_PRIVATE_PATHS) {
    const absolute = path.join(home, entry);
    places.push({ shown: `~/${entry}`, paths: variants(absolute), why: "Casper's own records", below: true,
      ...(entry === ".casper/projects" ? { open: browserPictures } : {}) });
  }
  if (context.agentDir) {
    places.push({ shown: "Casper's login file (auth.json)", paths: variants(path.join(context.agentDir, "auth.json")), why, below: true });
    places.push({ shown: "Casper's provider settings (models.json)", paths: variants(path.join(context.agentDir, "models.json")), why, below: true });
    places.push({ shown: "Casper's saved conversations folder", paths: variants(path.join(context.agentDir, "sessions")), why: "Casper's own records", below: true });
  }
  for (const entry of context.denyRead ?? []) {
    const inside = within(context.root, entry);
    const relative = (from: string) => path.relative(from, entry).split(path.sep).join("/");
    const shown = inside ? relative(context.root) || "." : within(home, entry) ? `~/${relative(home)}` : entry;
    places.push({ shown, paths: variants(entry), why: "this project's sandbox.denyRead", below: !inside });
  }
  return places;
}

/** The private place `absolute` is in, if any. */
export function privatePlace(absolute: string, context: PathContext): string | undefined {
  return privatePlaceFor(absolute, context)?.shown;
}

function privatePlaceFor(absolute: string, context: PathContext): PrivatePlace | undefined {
  const candidates = variants(absolute);
  return privatePlaces(context).find((place) => place.paths.some((entry) => candidates.some((candidate) => within(entry, candidate)
    && !place.open?.(path.relative(entry, candidate)))));
}

/** Why a shown private place is private ("keys and logins" unless it is the project's own denyRead). */
function whyPrivate(shown: string, context: PathContext): string {
  return privatePlaces(context).find((place) => place.shown === shown)?.why ?? "keys and logins";
}

/** A private place inside the folder `absolute` (grep over ~ would read ~/.ssh). */
export function privatePlaceBelow(absolute: string, context: PathContext): string | undefined {
  const candidates = variants(absolute);
  return privatePlaces(context).find((place) => place.below && place.paths.some((entry) => candidates.some((candidate) => within(candidate, entry))))?.shown;
}

function readText(file: string): string | undefined {
  try { return statSync(file).size > 1024 * 1024 ? undefined : readFileSync(file, "utf8"); } catch { return undefined; }
}

/** The git folders for `root`: its .git (or the folder a .git file points to) and the shared folder of a worktree. */
export function gitDirs(root: string): string[] {
  const dotGit = path.join(root, ".git");
  const dirs: string[] = [];
  let gitDir: string | undefined;
  try {
    if (statSync(dotGit).isDirectory()) gitDir = dotGit;
    else {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? "")?.[1]?.trim();
      if (pointer) gitDir = path.resolve(root, pointer);
    }
  } catch { /* not a git repo */ }
  if (!gitDir) return dirs;
  dirs.push(gitDir);
  const common = readText(path.join(gitDir, "commondir"))?.trim();
  if (common) dirs.push(path.resolve(gitDir, common));
  return dirs;
}

/** Folders a core.hooksPath setting points to, from the repo's and your own git settings. */
export function hooksPathTargets(root: string, home = os.homedir()): string[] {
  const configs = gitDirs(root).flatMap((dir) => [path.join(dir, "config"), path.join(dir, "config.worktree")]);
  configs.push(path.join(home, ".gitconfig"), path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "git", "config"));
  const targets = new Set<string>();
  for (const file of configs) {
    const text = readText(file);
    if (!text) continue;
    for (const match of text.matchAll(/^\s*hookspath\s*=\s*(.+?)\s*$/gim)) {
      let value = match[1]!.replace(/^"(.*)"$/, "$1");
      if (value.startsWith("~/")) value = path.join(home, value.slice(2));
      targets.add(path.resolve(root, value));
    }
  }
  return [...targets];
}

/** Is `absolute` part of git's own files: any .git folder or file, the repo's git folders, or a hooks folder? */
export function gitInternalPart(absolute: string, root: string, home = os.homedir()): string | undefined {
  for (const candidate of variants(absolute)) {
    const parts = candidate.split(/[\\/]+/);
    const index = parts.findIndex((part) => same(part, ".git"));
    if (index >= 0) return parts.slice(index, index + 2).join("/");
  }
  for (const dir of gitDirs(root)) if (variants(absolute).some((candidate) => within(dir, candidate))) return ".git";
  for (const target of hooksPathTargets(root, home)) {
    if (variants(absolute).some((candidate) => variants(target).some((entry) => within(entry, candidate)))) return displayPath(target, root, home);
  }
  return undefined;
}

/** A path as a person would type it: relative inside the project, ~/ under home, absolute otherwise. */
export function displayPath(absolute: string, root: string, home = os.homedir()): string {
  if (within(root, absolute)) return path.relative(root, absolute).split(path.sep).join("/") || ".";
  if (within(home, absolute)) { const relative = path.relative(home, absolute).split(path.sep).join("/"); return relative ? `~/${relative}` : "~"; }
  return absolute;
}

/**
 * What a path is, for the AI's file tools:
 * - private: under a private place (~/.ssh, ~/.aws, Casper's login file ...), by name or through a link;
 * - gitInternal (writes only): any .git folder or file, the repo's git folders, a core.hooksPath folder;
 * - protected (writes only): ~/.casper, ~/.pi, shell start-up files, ~/.gitconfig;
 * - linksOut: named inside the project but a link takes it outside;
 * - inside or outside otherwise.
 */
export function classifyPath(absolute: string, context: PathContext, write: boolean): PathClass {
  const home = context.home ?? os.homedir();
  if (privatePlace(absolute, context)) return "private";
  const real = realpathLongest(absolute);
  if (write && gitInternalPart(absolute, context.root, home)) return "gitInternal";
  const roots = variants(context.root);
  const namedInside = roots.some((root) => within(root, absolute));
  const realInside = roots.some((root) => within(root, real));
  if (namedInside && !realInside) return "linksOut";
  // Where the write lands decides; a name under ~/.pi that is a link into the project is the project.
  // A project that itself lives in one of these places (Casper's own worktrees are in ~/.casper/worktrees)
  // is still the project: only the parts outside it are protected.
  if (write && PROTECTED_WRITE_PATHS.some((entry) => variants(path.join(home, entry))
    .some((place) => !(realInside && roots.some((root) => within(place, root)))
      && (within(place, real) || (!realInside && within(place, absolute)))))) return "protected";
  return realInside ? "inside" : "outside";
}

/** macOS name variants Pi's read also tries (screenshot AM/PM, NFD, curly quote), when they exist. */
export function readVariants(absolute: string): string[] {
  const found = [absolute];
  for (const variant of [absolute.replace(/ (AM|PM)\./gi, " $1."), absolute.normalize("NFD"), absolute.replace(/'/g, "’")]) {
    if (variant !== absolute && existsSync(variant)) found.push(variant);
  }
  return found;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

/**
 * The file tool gate for the AI's native read, grep, find, ls, edit and write, and the lsp tool's path. Returns the refusal
 * the AI sees, or undefined to let the call run.
 */
export function fileToolGate(toolName: string, input: Record<string, unknown> | undefined, context: PathContext): string | undefined {
  const home = context.home ?? os.homedir();
  // The lsp tool sends the file's text to the language server and returns its symbols: a private file is refused as
  // read refuses it. (It never leaves the project; the LSP layer checks that.)
  if (toolName === "lsp" && input && typeof input.path === "string" && input.path) {
    const place = privatePlace(resolveToolPath(input.path, context.root, home), context);
    return place ? `Not read: ${place} is private (${whyPrivate(place, context)}). Casper keeps it from the AI.` : undefined;
  }
  if (!input || (!READ_TOOLS.has(toolName) && !WRITE_TOOLS.has(toolName))) return undefined;
  const given = typeof input.path === "string" && input.path ? input.path : toolName === "read" || WRITE_TOOLS.has(toolName) ? undefined : ".";
  if (given === undefined) return undefined;
  const absolute = resolveToolPath(given, context.root, home);
  const write = WRITE_TOOLS.has(toolName);
  const verb = write ? "Not done" : "Not read";
  for (const candidate of toolName === "read" ? readVariants(absolute) : [absolute]) {
    const place = privatePlace(candidate, context);
    if (place) return `${verb}: ${place} is private (${whyPrivate(place, context)}). Casper keeps it from the AI.`;
    const kind = classifyPath(candidate, context, write);
    if (kind === "linksOut") return `${verb}: ${given} is a link to a place outside this project. Casper doesn't follow links out.`;
    if (kind === "gitInternal") return `Not done: ${gitInternalPart(candidate, context.root, home)} belongs to git itself. Casper doesn't let the AI change it.`;
    if (kind === "protected") return `Not done: ${displayPath(candidate, context.root, home)} holds your shell, git or Casper settings. Casper doesn't let the AI change it.`;
  }
  // grep reads every file under its folder, hidden ones too; find lists their names (fd --hidden).
  if (toolName === "grep" || toolName === "find") {
    const below = privatePlaceBelow(absolute, context);
    if (below) return `Not searched: ${displayPath(absolute, context.root, home)} holds private files (${below}). Search a narrower folder.`;
  }
  return undefined;
}

const WRITE_WORDS = /(?:^|[\s;&|(`])(?:tee|cp|mv|ln|install|chmod|chown|touch|dd|rsync|curl|wget|unzip|tar|rm|mkdir|truncate|patch|sed\s+(?:-\w*i|--in-place)|perl\s+-\w*i|python[\d.]*|node|bun|ruby|perl|sh|bash|zsh|git\s+(?:apply|checkout|restore))(?=\s|$)/;
const REDIRECT = /(?:^|[^<>&\d])>{1,2}(?!&)|&>/;
/** git config keys that make git run a program, or point it somewhere else. */
const RISKY_GIT_KEY = /^(?:core\.(?:hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy|worktree|attributesfile|excludesfile)$|alias\.|filter\.|pager\.|diff\.external$|diff\..+\.(?:textconv|command)$|merge\..+\.driver$|(?:difftool|mergetool|browser|man)\..+\.(?:cmd|path)$|interactive\.difffilter$|credential(?:\.|$)|include\.|includeif\.|gpg\.|sequence\.editor$|uploadpack\.|receivepack\.|protocol\.|url\.|remote\..+\.(?:uploadpack|receivepack|proxy)$)/i;
/** git options before the command word that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path", "--super-prefix"]);
/** git config options that take the next word as their value. */
const CONFIG_VALUE_OPTIONS = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment", "--value", "--url"]);
const CONFIG_READS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "--list", "-l", "get", "list"]);

/** The words of a piece of shell text with quotes taken off. A text check, not a shell parser. */
function shellWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      // As bash reads it: inside double quotes a backslash escapes only $ ` " \ and a newline.
      else if (char === "\\" && quote === "\"" && index + 1 < text.length && "$`\"\\\n".includes(text[index + 1]!)) { index++; if (text[index] !== "\n") current += text[index]; }
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") { quote = char; started = true; continue; }
    if (char === "\\" && index + 1 < text.length) { current += text[++index]; started = true; continue; }
    if (/\s/.test(char)) { if (started) words.push(current); current = ""; started = false; continue; }
    current += char; started = true;
  }
  if (started) words.push(current);
  return words;
}

/** Why `git config ...` in this shell text changes git's settings in a risky way, if it does. Looks
 * inside quoted words too, so `sh -c "git config core.hooksPath x"` counts. */
function riskyGitConfig(text: string, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  for (const segment of text.split(/;|&&|\|\||\||\n|\$\(|[()`]/)) {
    const words = shellWords(segment);
    for (const word of words) if (/\s/.test(word)) { const inner = riskyGitConfig(word, depth + 1); if (inner) return inner; }
    let index = words.findIndex((word) => /^git(?:\.exe)?$/i.test(path.basename(word.replaceAll("\\", "/"))));
    if (index < 0) continue;
    for (index++; index < words.length && words[index]!.startsWith("-"); index++) if (GIT_VALUE_OPTIONS.has(words[index]!)) index++;
    if (words[index] !== "config") continue;
    const args = words.slice(index + 1);
    let outside = false;
    let key: string | undefined;
    let read = false;
    for (let at = 0; at < args.length; at++) {
      const arg = args[at]!;
      if (CONFIG_READS.has(arg) || /^--get(?:-\w+)?=/.test(arg)) { read = true; break; }
      if (arg === "-e" || arg === "--edit" || arg === "edit") { key = "--edit"; break; }
      if (arg === "--global" || arg === "--system" || arg === "-f" || arg === "--file" || /^--file=/.test(arg)) outside = true;
      if (arg.startsWith("-")) { if (CONFIG_VALUE_OPTIONS.has(arg)) at++; continue; }
      key = ["set", "unset", "unset-all", "rename-section", "remove-section"].includes(arg) ? args.slice(at + 1).find((next) => !next.startsWith("-")) : arg;
      break;
    }
    if (read) continue;
    if (key === "--edit") return "Not run: `git config --edit` changes git's settings in an editor. Casper doesn't let the AI change them. Ask the user to run it.";
    if (key && RISKY_GIT_KEY.test(key)) return `Not run: \`git config ${key}\` changes how git runs programs. Casper doesn't let the AI change it. Ask the user to run it.`;
    if (outside) return "Not run: `git config` outside this repo changes your own git settings. Casper doesn't let the AI change them. Ask the user to run it.";
  }
  return undefined;
}

/**
 * A shell command that would change git's own files: a write to .git/hooks, .git/config, a
 * core.hooksPath folder or a rebase or cherry-pick to-do (an `exec` line there runs on the next
 * `--continue`, outside the sandbox), or `git config` setting a key that makes git run a program. A text check,
 * not a sandbox: a script can still get past it until the shell sandbox ships.
 */
export function gitInternalsCommand(command: string, root: string, home = os.homedir()): string | undefined {
  const config = riskyGitConfig(command);
  if (config) return config;
  const hooks = hooksPathTargets(root, home).flatMap((target) => [target, displayPath(target, root, home)]);
  const names = [/(?:^|[\s'"=:(/\\])\.git(?:[\\/]+(?:hooks|config(?:\.worktree)?|info|rebase-merge|rebase-apply|sequencer)\b|[\\/]*(?=$|[\s'";&|)]))/, ...hooks.filter((name) => name && name !== ".").map((name) => new RegExp(`(?:^|[\\s'"=:(])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[\\\\/]|\\s|$|['"])`))];
  const named = names.map((pattern) => pattern.exec(command)?.[0]?.trim().replace(/^['"=:(/\\]/, "")).find(Boolean);
  if (named && (REDIRECT.test(command) || WRITE_WORDS.test(command))) {
    return `Not run: this command changes ${named.replace(/[\\/]+$/, "")}, git's own files. Casper doesn't let the AI change them. Ask the user to run it.`;
  }
  return undefined;
}

/**
 * A shell command whose text names a private place (~/.ssh/config, $HOME/.aws, /home/me/.netrc ...). The sandbox
 * hides these from the shell too; this check also holds with the sandbox off (--no-sandbox, Windows). Words are read
 * as the shell would (~, ~user, $HOME, .., cd, quotes, globs), and a whole-home copy or grep -r counts. A text check,
 * not a sandbox: a variable or a script can get past it. The key file ssh or scp is told to use (-i, IdentityFile) is not
 * read by the AI, so that one is allowed.
 */
export function privatePathCommand(command: string, context: PathContext): string | undefined {
  const home = context.home ?? os.homedir();
  // Only ssh's own -i: `diff -i ~/.ssh/config` or `grep -i x ~/.ssh/config` reads the file.
  let text = command;
  for (let guard = 0; guard < 8; guard++) {
    const next = text.replace(/(\b(?:ssh|scp|sftp|ssh-copy-id|autossh|mosh)(?=\s)[^;&|\n()`]*?)(?:\s-i\s*|\bIdentityFile[= ]\s*)(?:"[^"]*"|'[^']*'|\S+)/, "$1 ");
    if (next === text) break;
    text = next;
  }
  const homes = ["~", "\\$HOME", "\\$\\{HOME\\}", "\"\\$HOME\"", "%USERPROFILE%", "\\$env:USERPROFILE", "\\$\\{env:USERPROFILE\\}", pathPattern(home)];
  // Git Bash has the same home folder variable.
  if (process.platform === "win32") homes.push("\\$USERPROFILE", "\\$\\{USERPROFILE\\}", "\"\\$USERPROFILE\"");
  // Windows and macOS names ignore case, and so do PowerShell's and cmd's variables.
  const flags = process.platform === "win32" || process.platform === "darwin" ? "i" : "";
  for (const place of privatePlaces(context)) {
    const entry = place.shown.startsWith("~/") ? place.shown.slice(2) : undefined;
    const names = entry ? homes.map((prefix) => `${prefix}[\\\\/]+${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\//g, "[\\\\/]+")}`) : [];
    for (const absolute of place.paths) names.push(pathPattern(absolute));
    const pattern = new RegExp(`(?:^|[\\s'"=:(<>|;&])(?:${names.join("|")})(?=$|[\\\\/\\s'";&|)<>*?])`, flags);
    if (pattern.test(text)) return `Not run: this command reads ${place.shown}, which is private (${place.why}). Casper keeps it from the AI. Ask the user instead.`;
  }
  // `cd ~/.ssh`, `cd $HOME` then a relative name: a command that goes home and names a private place by itself.
  if (/(?:^|[\s;&|(])cd\s+(?:~|\$HOME|\$\{HOME\}|"\$HOME")\/?(?=$|[\s;&|)])/.test(text)) {
    const bare = PRIVATE_PATHS.find((entry) => new RegExp(`(?:^|[\\s'"=:(<>|;&])(?:\\./)?${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\\\/\\s'";&|)])`).test(text));
    if (bare) return `Not run: this command reads ~/${bare}, which is private (keys and logins). Casper keeps it from the AI. Ask the user instead.`;
  }
  // PowerShell and cmd separate folders with \, which the shell reading below takes as an escape: read those once more with /.
  const shown = privateWord(text, context, home) ?? (process.platform === "win32" && text.includes("\\") ? privateWord(text.replaceAll("\\", "/"), context, home) : undefined);
  if (shown) return `Not run: this command reads ${shown}, which is private (${whyPrivate(shown, context)}). Casper keeps it from the AI. Ask the user instead.`;
  return undefined;
}

/** An absolute path as a regex. On Windows either slash separates folders, and the drive may be named the Git Bash,
 * Cygwin or WSL way (/c/Users, /cygdrive/c/Users, /proc/cygdrive/c/Users, /mnt/c/Users), by its admin share
 * (\\host\C$\Users) or as a device path (\\?\C:\Users). */
function pathPattern(absolute: string): string {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (process.platform !== "win32") return escape(absolute);
  const parts = absolute.split(/[\\/]+/);
  const drive = /^([A-Za-z]):$/.exec(parts[0]!);
  const share = `[\\\\/]{2}(?:[?.][\\\\/]+UNC[\\\\/]+)?[^\\\\/\\s'"]+[\\\\/]+${drive?.[1]}\\$`;
  return [drive ? `(?:(?:[\\\\/]{2}[?.][\\\\/]+)?${drive[1]}:|/(?:mnt/|(?:proc/)?cygdrive/)?${drive[1]}|${share})` : escape(parts[0]!),
    ...parts.slice(1).map(escape)].join("[\\\\/]+");
}

/** Programs that read every file under a folder they are given (grep -r ~ reads ~/.ssh/config). */
function readsTree(words: string[]): boolean {
  const program = path.basename(words[0] ?? "");
  const flags = words.slice(1).filter((word) => word.startsWith("-"));
  const short = (letters: RegExp) => flags.some((flag) => /^-[^-]/.test(flag) && letters.test(flag.slice(1)));
  if (["grep", "egrep", "fgrep", "zgrep"].includes(program)) return short(/[rR]/) || flags.some((flag) => /^--(?:recursive|dereference-recursive)$/.test(flag));
  if (["rg", "ag"].includes(program)) return short(/u/) || flags.some((flag) => /^--(?:hidden|no-ignore|unrestricted)$/.test(flag));
  if (["cp", "scp"].includes(program)) return short(/[rRa]/) || flags.some((flag) => /^--(?:recursive|archive)$/.test(flag));
  if (["find"].includes(program)) return words.some((word) => /^-(?:exec|execdir|ok|okdir|fprint|fls)$/.test(word));
  return ["tar", "zip", "7z", "rsync", "cpio", "rclone", "restic", "borg", "duplicity"].includes(program);
}

/** Whether one glob part matches one path part: * and ? stay inside the part, [..] is a set, and (as in the shell)
 * a leading dot is matched only by a dot. Windows names ignore case, so its globs do too. */
function globMatches(pattern: string, name: string): boolean {
  if (name.startsWith(".") && !pattern.startsWith(".")) return false;
  try { return new RegExp(`^${pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`, process.platform === "win32" ? "i" : "").test(name); } catch { return false; }
}

/** The parts of an absolute path. Windows paths may use \ or / between parts. */
function pathParts(absolute: string): string[] {
  return absolute.split(path.sep === "\\" ? /[\\/]/ : "/").filter(Boolean);
}

/**
 * The private place a command's words reach once ~, ~user, $HOME, .., a cd and globs are read the way the shell reads
 * them: `cat ../.ssh/config` from ~/Documents, `cd; cat .ssh/config`, `cat ~/.ss*\/config`, `cat ~/'.ssh'/config`,
 * `grep -r HostName ~`. Still a text check: a variable or a script can get past it.
 */
function privateWord(command: string, context: PathContext, home: string): string | undefined {
  const places = privatePlaces(context);
  const userName = path.basename(home);
  const windows = process.platform === "win32";
  // On Windows a word may also be a Git Bash drive path (/c/Users), a drive's admin share or device path, or a Git Bash,
  // PowerShell or cmd home variable, in any case.
  const homeVariable = windows ? /^(?:\$\{HOME\}|\$HOME|\$\{USERPROFILE\}|\$USERPROFILE|\$\{env:USERPROFILE\}|\$env:USERPROFILE|%USERPROFILE%)(?=\/|$)/i
    : /^(?:\$\{HOME\}|\$HOME)(?=\/|$)/;
  const expand = (word: string): string | undefined => {
    let value = (windows ? windowsDrivePath(windowsShellPath(word)) : word).replace(homeVariable, home);
    const tilde = /^~([^/]*)(?=\/|$)/.exec(value);
    if (tilde) value = (tilde[1] === "" || tilde[1] === userName ? home : path.join(path.dirname(home), tilde[1]!)) + value.slice(tilde[0].length);
    return value.includes("$") ? undefined : value;
  };
  let cwd = context.root;
  // Git Bash also reads a name from / or /proc/cygdrive as a drive path (from /, c/Users is C:\Users), so on Windows a
  // cd to a / path is kept the way Git Bash names it too, and the names after it are read from there.
  let shellCwd: string | undefined;
  const fromShell = (word: string) => shellCwd !== undefined && !/^(?:[\\/~$%]|[a-z]:)/i.test(word) ? path.posix.join(shellCwd, word) : word;
  let segments: ReturnType<typeof commandSegments>;
  try { segments = commandSegments(command); } catch { return undefined; }
  for (const { words } of segments) {
    if (!words.length) continue;
    if (words[0] === "cd" || words[0] === "pushd") {
      const target = words.slice(1).find((word) => !word.startsWith("-"));
      const typed = target === undefined ? undefined : fromShell(target);
      const expanded = typed === undefined ? home : expand(typed);
      const moved = expanded !== undefined && !/[*?[]/.test(expanded);
      if (moved) cwd = path.resolve(cwd, expanded);
      if (windows) shellCwd = moved && typed !== undefined && /^\/(?!\/)/.test(typed) ? path.posix.normalize(typed) : undefined;
    }
    // `ssh -G host` prints what ~/.ssh/config says for it.
    if (path.basename(words[0]!) === "ssh" && words.some((word) => /^-[46AaCfGgKkMNnqsTtVvXxYy]*G[46AaCfGgKkMNnqsTtVvXxYy]*$/.test(word))) return "~/.ssh";
    const tree = readsTree(words);
    const git = /^git(?:\.exe)?$/i.test(path.basename(words[0]!));
    for (const raw of words.slice(1)) {
      let word = raw.startsWith("-") ? raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : "" : raw.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "");
      // git show HEAD:secrets/x, :secrets/x, :0:secrets/x print that file from git's own copy.
      if (git && word.includes(":") && !word.includes("://")) { const rest = word.replace(/^:\d:/, ""); word = rest.slice(rest.indexOf(":") + 1); }
      if (!word || !(shellCwd !== undefined || /^[.~/$]|\//.test(word))) continue;
      const expanded = expand(fromShell(word));
      if (expanded === undefined) continue;
      const absolute = path.resolve(cwd, expanded);
      if (!/[*?[]/.test(absolute)) {
        const inside = privatePlace(absolute, context);
        if (inside) return inside;
        if (tree) { const below = privatePlaceBelow(absolute, context); if (below) return below; }
        continue;
      }
      // A glob: part by part, does it reach a private place (or, for a tree reader, a folder that holds one)?
      const parts = pathParts(windowsDrivePath(absolute));
      for (const place of places) {
        for (const entry of place.paths) {
          const want = pathParts(entry);
          const reaches = parts.length >= want.length ? want.every((part, index) => globMatches(parts[index]!, part))
            : tree && parts.every((part, index) => globMatches(part, want[index]!));
          if (reaches) return place.shown;
        }
      }
    }
  }
  return undefined;
}
