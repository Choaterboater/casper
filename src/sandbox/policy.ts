import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitDirs, hooksPathTargets, PRIVATE_PATHS, PROTECTED_WRITE_PATHS, realpathLongest, within } from "../platform/project-paths";

/**
 * What the shell sandbox lets a command touch. One policy feeds every shell path (the AI's bash, checks,
 * services, dev servers, Casper's own tool runs) and every platform backend. Only you can widen it, in
 * ~/.casper/config.yaml; a project's .casper/project.yaml can only add denies.
 */

/** Your own settings (~/.casper/config.yaml or a profile). */
export interface SandboxUserSettings {
  /** `sandbox: off`: no sandbox (shell commands ask first instead of running held). */
  off?: boolean;
  /** Hosts a shell command may reach without asking, added to the registry list. */
  allowedDomains?: string[];
  /** Extra folders commands may write (for example a shared build cache). */
  allowWrite?: string[];
  /** Unix sockets a command may use on macOS (for example /var/run/docker.sock). Linux can't filter by path. */
  allowUnixSockets?: string[];
  /** `shell.keepEnv`: AI provider keys you want your own tests to keep (for example OPENAI_API_KEY). */
  keepEnv?: string[];
}

/** A project's settings (.casper/project.yaml): only more denies. */
export interface SandboxProjectSettings {
  denyRead?: string[];
  denyWrite?: string[];
}

/** Package registries and code hosts a shell command reaches without asking. Shown by /sandbox. */
export const REGISTRY_HOSTS: readonly string[] = [
  "registry.npmjs.org", "*.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org",
  "github.com", "*.githubusercontent.com", "bun.sh",
];

/** This machine, through the proxy (a command that goes direct to localhost reaches its own sandbox). */
export const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/** Package caches under your home folder that installs and test runs write. Not the places that hold programs
 * you run outside the sandbox (pre-commit's hook copies, Playwright's browsers, uv's own Pythons and tools):
 * a command could change what they run. Add one with sandbox.allowWrite if a check needs it. */
export function cachePaths(platform: NodeJS.Platform = process.platform): string[] {
  const shared = [".cache/uv", ".cache/pip", ".npm", ".bun/install/cache"];
  return platform === "darwin" ? [...shared, "Library/Caches/pip", "Library/Caches/uv", "Library/Caches/org.swift.swiftpm"] : shared;
}

/** macOS: clang's module cache, which `swift build` must write, in your user cache folder beside the temp
 * folder (/var/folders/../C beside ../T). Only that folder, not the rest of the cache folder. With TMPDIR
 * set elsewhere, the cache folder comes from `getconf DARWIN_USER_CACHE_DIR`. */
export function clangModuleCache(
  platform: NodeJS.Platform = process.platform,
  tmp = os.tmpdir(),
  userCacheDir: () => string | undefined = darwinUserCacheDir,
): string | undefined {
  if (platform !== "darwin") return undefined;
  const match = /^(\/(?:private\/)?var\/folders\/[^/]+\/[^/]+)\/T\/?$/.exec(tmp);
  const cache = match ? path.join(match[1]!, "C") : userCacheDir();
  return cache ? path.join(cache, "clang", "ModuleCache") : undefined;
}

let userCacheDir: string | null | undefined;
function darwinUserCacheDir(): string | undefined {
  if (userCacheDir === undefined) {
    try {
      const out = execFileSync("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], { encoding: "utf8", timeout: 2000 }).trim();
      userCacheDir = /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/C\/?$/.test(out) ? out.replace(/\/$/, "") : null;
    } catch { userCacheDir = null; }
  }
  return userCacheDir ?? undefined;
}

/** uv's own Pythons, which `casper new` may fetch for a Python template (a run you started, of known packages). */
export const UV_PYTHONS = ".local/share/uv";

/** Casper's own records the shell must not read: approvals, remembered hosts, lab answers, undo copies. */
export const CASPER_PRIVATE_PATHS: readonly string[] = [".casper/projects", ".casper/mcp-consent.json", ".casper/skills-trust.json"];

/** git's own files in a git folder that change what git runs. */
export const GIT_OWN_FILES: readonly string[] = ["hooks", "config", "config.worktree", "info"];

/** Files that tell git where its folder is: a worktree's `.git` file and its folder's `commondir`. Held read-only
 * only when they exist (a stand-in for a missing one would break git); a main `.git/commondir` that appears
 * is removed by the sandbox (see ShellSandbox.guardGit). */
function gitPointers(folder: string): string[] {
  const dotGit = path.join(folder, ".git");
  const pointers = [dotGit, ...gitDirs(folder).map((dir) => path.join(dir, "commondir"))];
  return pointers.filter((file) => { try { return statSync(file).isFile(); } catch { return false; } });
}

/** Submodules' own git folders (`.git/modules/<name>`, nested ones too) and the `.git` files that point a
 * submodule's folder at them. `git status` in the project runs git in each submodule with that folder's
 * settings, so a command that could write them could make your own git run a program it chose. */
function submoduleGitParts(folder: string, depth = 0): { dirs: string[]; pointers: string[] } {
  const dirs: string[] = [];
  const pointers: string[] = [];
  if (depth > 3) return { dirs, pointers };
  const walk = (modules: string, level: number) => {
    if (level > 4) return;
    let entries: string[];
    try { entries = readdirSync(modules); } catch { return; }
    for (const name of entries.slice(0, 200)) {
      const dir = path.join(modules, name);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      if (existsSync(path.join(dir, "HEAD"))) {
        dirs.push(dir);
        walk(path.join(dir, "modules"), level + 1);
      } else walk(dir, level + 1); // a submodule named with a slash (lib/one)
    }
  };
  for (const gitDir of gitDirs(folder)) walk(path.join(gitDir, "modules"), 0);
  let listed = "";
  try { listed = readFileSync(path.join(folder, ".gitmodules"), "utf8"); } catch { /* no submodules */ }
  for (const match of listed.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) {
    const sub = path.resolve(folder, match[1]!);
    if (!within(folder, sub) || sub === folder) continue;
    const dotGit = path.join(sub, ".git");
    try { if (statSync(dotGit).isFile()) pointers.push(dotGit); } catch { continue; }
    const inner = submoduleGitParts(sub, depth + 1);
    pointers.push(...inner.pointers);
  }
  return { dirs, pointers };
}

export interface SandboxPolicyInput {
  /** The project folder: writable unless `readOnlyProject`. */
  root: string;
  home?: string;
  /** Temp folders commands may write (the system temp folder and Casper's own). */
  tempDirs?: string[];
  /** Pi's state folder: its auth.json is private. */
  agentDir?: string;
  user?: SandboxUserSettings;
  project?: SandboxProjectSettings;
  /** Hosts remembered for this project ("Always for this project"). */
  rememberedHosts?: string[];
  /** Folders outside the project you allowed writes to for this session (never kept). */
  sessionWrites?: string[];
  /** Folders one command may also write (a new project's folder). */
  extraWrite?: string[];
  /** A plan turn: the project is read-only too. */
  readOnlyProject?: boolean;
  platform?: NodeJS.Platform;
}

export interface SandboxPolicy {
  allowWrite: string[];
  denyWrite: string[];
  denyRead: string[];
  allowedDomains: string[];
}

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

/** `~/x` and relative paths (from the project) as absolute paths. */
function resolveEntry(entry: string, root: string, home: string): string {
  if (entry === "~") return home;
  if (entry.startsWith("~/")) return path.join(home, entry.slice(2));
  return path.resolve(root, entry);
}

/** Every spelling a rule needs: as written and through links (macOS /tmp is /private/tmp). */
function spellings(absolute: string): string[] {
  return unique([path.resolve(absolute), realpathLongest(absolute)]);
}

/** The system temp folders on this platform. */
export function systemTempDirs(platform: NodeJS.Platform = process.platform): string[] {
  const dirs = [os.tmpdir()];
  if (platform !== "win32") for (const dir of ["/tmp", "/var/tmp"]) if (existsSync(dir)) dirs.push(dir);
  return unique(dirs.flatMap(spellings));
}

export function sandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  const home = input.home ?? os.homedir();
  const root = path.resolve(input.root);
  const inHome = (entries: readonly string[]) => entries.flatMap((entry) => spellings(path.join(home, entry)));
  const git = gitDirs(root);
  const hooks = hooksPathTargets(root, home);
  const project = input.readOnlyProject ? [] : [root, ...git.filter((dir) => !within(root, dir))];
  const allowWrite = unique([
    ...project.flatMap(spellings),
    ...(input.tempDirs ?? systemTempDirs(input.platform)).flatMap(spellings),
    ...inHome(cachePaths(input.platform)),
    ...[clangModuleCache(input.platform)].filter((entry): entry is string => Boolean(entry)).flatMap(spellings),
    ...(input.extraWrite ?? []).flatMap(spellings),
    ...(input.user?.allowWrite ?? []).map((entry) => resolveEntry(entry, root, home)).flatMap(spellings),
    ...(input.sessionWrites ?? []).flatMap(spellings),
  ]);
  // A folder a command may also write (a new project's folder), or one you allowed this session, keeps git's own
  // files read-only too: your next git run there (or Casper's first commit) runs its hooks, outside the sandbox.
  const extra = [...(input.extraWrite ?? []), ...(input.sessionWrites ?? []).flatMap(withRepos)].map((entry) => path.resolve(entry));
  const submodules = [root, ...extra].map((folder) => submoduleGitParts(folder));
  const gitOwn = [root, ...extra].flatMap((folder) => [...gitDirs(folder), path.join(folder, ".git")])
    .concat(submodules.flatMap((found) => found.dirs))
    .flatMap((dir) => GIT_OWN_FILES.map((name) => path.join(dir, name)));
  const denyWrite = unique([
    ...gitOwn.flatMap(spellings),
    ...hooks.flatMap(spellings),
    ...extra.flatMap((folder) => hooksPathTargets(folder, home)).flatMap(spellings),
    ...[root, ...extra].flatMap(gitPointers).flatMap(spellings),
    ...submodules.flatMap((found) => found.pointers).flatMap(spellings),
    ...inHome(PROTECTED_WRITE_PATHS),
    ...inHome(PRIVATE_PATHS),
    ...(input.project?.denyWrite ?? []).map((entry) => resolveEntry(entry, root, home)).flatMap(spellings),
  ]);
  const denyRead = unique([
    ...inHome(PRIVATE_PATHS),
    ...inHome(CASPER_PRIVATE_PATHS),
    ...(input.agentDir ? spellings(path.join(input.agentDir, "auth.json")) : []),
    ...(input.project?.denyRead ?? []).map((entry) => resolveEntry(entry, root, home)).flatMap(spellings),
  ]);
  const allowedDomains = unique([...REGISTRY_HOSTS, ...LOCAL_HOSTS, ...(input.user?.allowedDomains ?? []), ...(input.rememberedHosts ?? [])]);
  return { allowWrite, denyWrite, denyRead, allowedDomains };
}

/** An allowed folder and the git repos right inside it (~/code/<repo>), whose own git files stay read-only. */
function withRepos(folder: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(folder).slice(0, 500); } catch { /* not there yet */ }
  return [folder, ...names.map((name) => path.join(folder, name)).filter((dir) => existsSync(path.join(dir, ".git")))];
}

/** System folders a write question never offers. */
const SYSTEM_FOLDERS: readonly string[] = ["/etc", "/usr", "/System", "/bin", "/sbin", "/Library", "/private/etc"];

/**
 * The folder a write question offers for a refused write to `absolute`: its nearest existing parent. Undefined
 * (a plain refusal, no question) for the project, ~, /, system folders, git's own folders, and any folder that
 * is, holds or sits inside a denied place (private places, Casper's own, shell start-up files, git's files).
 */
export function writeFolderToOffer(absolute: string, policy: Pick<SandboxPolicy, "denyWrite" | "denyRead">, context: { root: string; home: string }): string | undefined {
  let folder = path.dirname(path.resolve(absolute));
  while (!isFolder(folder)) {
    const parent = path.dirname(folder);
    if (parent === folder) return undefined;
    folder = parent;
  }
  const names = spellings(folder);
  const real = realpathLongest(folder);
  const exactly = (places: string[]) => places.some((place) => names.some((name) => within(place, name) && within(name, place)));
  if (!offerable(names, policy, context) || exactly([path.parse(real).root, ...spellings(context.home)])) return undefined;
  if ([...policy.denyWrite, ...policy.denyRead].some((place) => names.some((name) => within(name, place)))) return undefined;
  return real;
}

/** The file itself, for the AI's edit and write tools when its folder can't be offered (~, or ~/Documents that
 * holds the project's git files): asked about alone, unless it is in the project, a system folder, git's files
 * or a denied place. */
export function writeFileToOffer(absolute: string, policy: Pick<SandboxPolicy, "denyWrite" | "denyRead">, context: { root: string; home: string }): string | undefined {
  const names = spellings(absolute);
  const real = realpathLongest(absolute);
  return offerable(names, policy, context) && !isFolder(real) ? real : undefined;
}

/** Not the project, a system folder, git's own files, or in a denied place. */
function offerable(names: string[], policy: Pick<SandboxPolicy, "denyWrite" | "denyRead">, context: { root: string }): boolean {
  const inside = (places: string[]) => places.some((place) => names.some((name) => within(place, name)));
  if (inside(spellings(context.root)) || inside(SYSTEM_FOLDERS.flatMap(spellings))) return false;
  if (names.some((name) => name.split(/[\\/]+/).includes(".git"))) return false;
  return !inside([...policy.denyWrite, ...policy.denyRead]);
}

function isFolder(folder: string): boolean {
  try { return statSync(folder).isDirectory(); } catch { return false; }
}

/** A host as the ask and the remembered list use it: lower case, no port, no trailing dot. */
export function hostName(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** True when `host` matches a pattern in `patterns` (`*.example.com` matches a.example.com, not example.com). */
export function hostListed(host: string, patterns: readonly string[]): boolean {
  const name = hostName(host);
  return patterns.some((pattern) => {
    const entry = hostName(pattern).replace(/:\d+$/, "");
    if (entry.startsWith("*.")) return name.endsWith(entry.slice(1));
    return name === entry;
  });
}
