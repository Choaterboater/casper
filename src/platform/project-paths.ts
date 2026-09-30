import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where a path the AI's file tools name really points. One list of private paths is shared by the
 * file tool gate here and, later, the shell sandbox. The gate is a check before the tool runs, on
 * the resolved path (realpath of the longest part that exists), so a link anywhere in the path counts.
 * It is not a sandbox: a shell command can still read these files (see docs/SECURITY.md).
 */

/** Private places under your home folder: keys, logins and cloud credentials. */
export const PRIVATE_PATHS: readonly string[] = [
  ".ssh", ".aws", ".gnupg", ".config/gh", ".kube", ".docker/config.json", ".netrc", ".git-credentials", ".claude.json", ".mcp.json",
  ".claude/.credentials.json", ".casper/agent/auth.json", ".casper/mcp-consent.key", ".pi/agent/auth.json", "Library/Keychains",
  ".config/gcloud", ".azure", ".oci", ".terraform.d/credentials.tfrc.json", ".pgpass", ".npmrc", ".pypirc", ".config/hub",
  ".password-store", ".local/share/keyrings",
];

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
}

const UNICODE_SPACES = /[  -   　]/g;

/** The absolute path a native tool will use for `input`: the same steps as Pi's resolveToCwd. */
export function resolveToolPath(input: string, cwd: string, home = os.homedir()): string {
  let normal = input.replace(UNICODE_SPACES, " ");
  if (normal.startsWith("@")) normal = normal.slice(1);
  if (normal === "~") return home;
  if (normal.startsWith("~/") || (process.platform === "win32" && normal.startsWith("~\\"))) return path.join(home, normal.slice(2));
  if (/^file:\/\//.test(normal)) { try { return fileURLToPath(normal); } catch { /* keep as typed */ } }
  return path.resolve(cwd, normal);
}

/** realpath of the longest part of the path that exists, with the rest added back. */
export function realpathLongest(absolute: string): string {
  let current = path.resolve(absolute);
  const rest: string[] = [];
  for (;;) {
    try { return path.join(realpathSync(current), ...rest.reverse()); }
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
    return !lower.startsWith("..") && !path.isAbsolute(lower);
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function variants(absolute: string): string[] {
  return [...new Set([absolute, realpathLongest(absolute)])];
}

/** Private places, each as typed (~/.ssh) and as its absolute paths. */
export function privatePlaces(context: PathContext): Array<{ shown: string; paths: string[] }> {
  const home = context.home ?? os.homedir();
  const places = PRIVATE_PATHS.map((entry) => ({ shown: `~/${entry}`, paths: variants(path.join(home, entry)) }));
  if (context.agentDir) places.push({ shown: "Casper's login file (auth.json)", paths: variants(path.join(context.agentDir, "auth.json")) });
  return places;
}

/** The private place `absolute` is in, if any. */
export function privatePlace(absolute: string, context: PathContext): string | undefined {
  const candidates = variants(absolute);
  return privatePlaces(context).find((place) => place.paths.some((entry) => candidates.some((candidate) => within(entry, candidate))))?.shown;
}

/** A private place inside the folder `absolute` (grep over ~ would read ~/.ssh). */
export function privatePlaceBelow(absolute: string, context: PathContext): string | undefined {
  const candidates = variants(absolute);
  return privatePlaces(context).find((place) => place.paths.some((entry) => candidates.some((candidate) => within(candidate, entry))))?.shown;
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
 * The file tool gate for the AI's native read, grep, find, ls, edit and write. Returns the refusal
 * the AI sees, or undefined to let the call run.
 */
export function fileToolGate(toolName: string, input: Record<string, unknown> | undefined, context: PathContext): string | undefined {
  if (!input || (!READ_TOOLS.has(toolName) && !WRITE_TOOLS.has(toolName))) return undefined;
  const home = context.home ?? os.homedir();
  const given = typeof input.path === "string" && input.path ? input.path : toolName === "read" || WRITE_TOOLS.has(toolName) ? undefined : ".";
  if (given === undefined) return undefined;
  const absolute = resolveToolPath(given, context.root, home);
  const write = WRITE_TOOLS.has(toolName);
  const verb = write ? "Not done" : "Not read";
  for (const candidate of toolName === "read" ? readVariants(absolute) : [absolute]) {
    const place = privatePlace(candidate, context);
    if (place) return `${verb}: ${place} is private (keys and logins). Casper keeps it from the AI.`;
    const kind = classifyPath(candidate, context, write);
    if (kind === "linksOut") return `${verb}: ${given} is a link to a place outside this project. Casper doesn't follow links out.`;
    if (kind === "gitInternal") return `Not done: ${gitInternalPart(candidate, context.root, home)} belongs to git itself. Casper doesn't let the AI change it.`;
    if (kind === "protected") return `Not done: ${displayPath(candidate, context.root, home)} holds your shell, git or Casper settings. Casper doesn't let the AI change it.`;
  }
  // grep reads every file under its folder, hidden ones too.
  if (toolName === "grep") {
    const below = privatePlaceBelow(absolute, context);
    if (below) return `Not searched: ${displayPath(absolute, context.root, home)} holds private files (${below}). Search a narrower folder.`;
  }
  return undefined;
}

const WRITE_WORDS = /(?:^|[\s;&|(`])(?:tee|cp|mv|ln|install|chmod|chown|touch|dd|rsync|curl|wget|unzip|tar|rm|mkdir|truncate|patch|sed\s+(?:-\w*i|--in-place)|perl\s+-\w*i|python[\d.]*|node|bun|ruby|perl|sh|bash|zsh|git\s+(?:apply|checkout|restore))(?=\s|$)/;
const REDIRECT = /(?:^|[^<>&\d])>{1,2}(?!&)|&>/;
/** git config keys that make git run a program, or point it somewhere else. */
const RISKY_GIT_KEY = /^(?:core\.(?:hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy|worktree|attributesfile|excludesfile)$|alias\.|filter\.|pager\.|diff\..+\.(?:textconv|command)$|merge\..+\.driver$|(?:difftool|mergetool|browser|man)\..+\.(?:cmd|path)$|interactive\.difffilter$|credential(?:\.|$)|include\.|includeif\.|gpg\.|sequence\.editor$|uploadpack\.|receivepack\.|protocol\.|url\.|remote\..+\.(?:uploadpack|receivepack|proxy)$)/i;
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
      else if (char === "\\" && quote === "\"" && index + 1 < text.length) current += text[++index];
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
 * A shell command that would change git's own files: a write to .git/hooks, .git/config or a
 * core.hooksPath folder, or `git config` setting a key that makes git run a program. A text check,
 * not a sandbox: a script can still get past it until the shell sandbox ships.
 */
export function gitInternalsCommand(command: string, root: string, home = os.homedir()): string | undefined {
  const config = riskyGitConfig(command);
  if (config) return config;
  const hooks = hooksPathTargets(root, home).flatMap((target) => [target, displayPath(target, root, home)]);
  const names = [/(?:^|[\s'"=:(/\\])\.git(?:[\\/]+(?:hooks|config(?:\.worktree)?|info)\b|[\\/]*(?=$|[\s'";&|)]))/, ...hooks.filter((name) => name && name !== ".").map((name) => new RegExp(`(?:^|[\\s'"=:(])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[\\\\/]|\\s|$|['"])`))];
  const named = names.map((pattern) => pattern.exec(command)?.[0]?.trim().replace(/^['"=:(/\\]/, "")).find(Boolean);
  if (named && (REDIRECT.test(command) || WRITE_WORDS.test(command))) {
    return `Not run: this command changes ${named.replace(/[\\/]+$/, "")}, git's own files. Casper doesn't let the AI change them. Ask the user to run it.`;
  }
  return undefined;
}
