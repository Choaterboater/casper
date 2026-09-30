import { existsSync, statSync } from "node:fs";
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

/** Package caches under your home folder that installs and test runs write. */
export function cachePaths(platform: NodeJS.Platform = process.platform): string[] {
  const shared = [".cache/uv", ".cache/pip", ".npm", ".bun/install/cache", ".local/share/uv", ".cache/pre-commit", ".cache/ms-playwright"];
  return platform === "darwin" ? [...shared, "Library/Caches/pip", "Library/Caches/uv", "Library/Caches/ms-playwright"] : shared;
}

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
    ...(input.extraWrite ?? []).flatMap(spellings),
    ...(input.user?.allowWrite ?? []).map((entry) => resolveEntry(entry, root, home)).flatMap(spellings),
  ]);
  // A folder a command may also write (a new project's folder) keeps git's own files read-only too: Casper's
  // first commit there runs git with your hooks, outside the sandbox.
  const extra = (input.extraWrite ?? []).map((entry) => path.resolve(entry));
  const gitOwn = [root, ...extra].flatMap((folder) => [...gitDirs(folder), path.join(folder, ".git")])
    .flatMap((dir) => GIT_OWN_FILES.map((name) => path.join(dir, name)));
  const denyWrite = unique([
    ...gitOwn.flatMap(spellings),
    ...hooks.flatMap(spellings),
    ...extra.flatMap((folder) => hooksPathTargets(folder, home)).flatMap(spellings),
    ...[root, ...extra].flatMap(gitPointers).flatMap(spellings),
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
