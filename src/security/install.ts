import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { installEnv, securityEnv } from "./env";
import { runTool, type ToolRunner } from "./spawn";
import { hostPlatform, pinnedToolDir, pinnedToolPath, SECURITY_TOOLS, type LockedSpec, type SecurityToolSpec, type UvLockSource } from "./tools";
import type { SecurityToolId } from "./types";

/**
 * Finding and installing the pinned tools. Casper prefers its own pinned copy in ~/.casper/tools, and
 * otherwise uses a copy on PATH (shown with its version). Installing always follows the user's "3 Install
 * them"; the host asks, this module only downloads, checks and unpacks.
 */

export type ToolLocation =
  | { kind: "pinned"; path: string; version: string }
  | { kind: "path"; path: string; version?: string }
  | { kind: "missing" };

const MARKER = ".casper-installed.json";

interface InstalledMarker { id: string; version: string; pin: string }

/** What the pinned copy was installed from: the asset's sha256, or the lock's own hash. */
export function pinFingerprint(spec: SecurityToolSpec, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  if (spec.source.kind === "uv-lock") return createHash("sha256").update(spec.source.lock).digest("hex");
  const key = hostPlatform(platform, arch);
  return key ? spec.source.assets[key]?.sha256 : undefined;
}

export interface FindOptions {
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  run?: ToolRunner;
}

async function isFile(file: string): Promise<boolean> {
  return stat(file).then((details) => details.isFile(), () => false);
}

/** A program on PATH (never the current folder: a repo cannot plant its own "gitleaks"). */
export async function onPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const dir of pathValue.split(platform === "win32" ? ";" : ":")) {
    if (!dir || dir === "." || !path.isAbsolute(dir)) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension.toLowerCase()}`);
      if (await isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

const VERSION_ARGS: Partial<Record<SecurityToolId, string[]>> = { gitleaks: ["version"] };

/** A PATH copy's version from its own `--version` output. */
export async function pathToolVersion(spec: SecurityToolSpec, file: string, options: FindOptions): Promise<string | undefined> {
  const result = await (options.run ?? runTool)({
    file, args: VERSION_ARGS[spec.id] ?? ["--version"], cwd: options.homeDir,
    env: securityEnv(options.env ?? process.env, { homeDir: options.homeDir }), timeoutMs: 15_000, maxStdoutBytes: 64 * 1024,
  });
  return /\b(\d+\.\d+\.\d+)\b/.exec(`${result.stdout}\n${result.stderr}`)?.[1];
}

export async function findTool(spec: SecurityToolSpec, options: FindOptions): Promise<ToolLocation> {
  const platform = options.platform ?? process.platform;
  const pinned = pinnedToolPath(options.homeDir, spec, platform);
  try {
    const marker = JSON.parse(await readFile(path.join(pinnedToolDir(options.homeDir, spec), MARKER), "utf8")) as Partial<InstalledMarker>;
    if (marker.id === spec.id && marker.version === spec.version && marker.pin === pinFingerprint(spec, platform, options.arch) && await isFile(pinned)) {
      return { kind: "pinned", path: pinned, version: spec.version };
    }
  } catch { /* not installed by Casper */ }
  const found = await onPath(spec.command, options.env ?? process.env, platform);
  if (!found) return { kind: "missing" };
  return { kind: "path", path: found, version: await pathToolVersion(spec, found, options) };
}

/** "gitleaks: using your 8.18.0 (Casper pins 8.30.1)" for a copy Casper did not install. */
export function ownCopyLine(spec: SecurityToolSpec, location: ToolLocation): string | undefined {
  if (location.kind !== "path") return undefined;
  if (!location.version) return `${spec.label}: using your copy, version unknown (Casper pins ${spec.version})`;
  return location.version === spec.version ? `${spec.label}: using your ${location.version}` : `${spec.label}: using your ${location.version} (Casper pins ${spec.version})`;
}

// ---------------------------------------------------------------------------------------------------------
// The install question

export interface NumberedQuestion { text: string; choices: string[] }

/** Stop comes first, so Enter never downloads or runs anything; installing takes a deliberate 3. */
export const INSTALL_CHOICES = ["Stop", "Run what's installed", "Install them"] as const;
export const INSTALL_STOP = INSTALL_CHOICES[0];
export const INSTALL_RUN = INSTALL_CHOICES[1];
export const INSTALL_YES = INSTALL_CHOICES[2];

function joinHosts(specs: readonly SecurityToolSpec[]): string {
  const hosts = [...new Set(specs.flatMap((spec) => spec.hosts))];
  return hosts.length <= 1 ? hosts.join("") : `${hosts.slice(0, -1).join(", ")} and ${hosts.at(-1)}`;
}

/** "Security checks need 4 tools that aren't installed: … (about 400 MB from github.com and pypi.org)." */
export function installQuestion(specs: readonly SecurityToolSpec[]): NumberedQuestion {
  const count = specs.length;
  const megabytes = specs.reduce((sum, spec) => sum + spec.approxMB, 0);
  const size = megabytes >= 100 ? Math.round(megabytes / 100) * 100 : Math.max(10, Math.round(megabytes / 10) * 10);
  const tools = count === 1 ? "1 tool that isn't installed" : `${count} tools that aren't installed`;
  return {
    text: `Security checks need ${tools}: ${specs.map((spec) => spec.label.replace(/ S$/, "")).join(", ")} (about ${size} MB from ${joinHosts(specs)}).`,
    choices: [...INSTALL_CHOICES],
  };
}

/** The numbered line: "1 Stop · 2 Run what's installed · 3 Install them". */
export function numberedChoices(choices: readonly string[]): string {
  return choices.map((choice, index) => `${index + 1} ${choice}`).join(" · ");
}

// ---------------------------------------------------------------------------------------------------------
// Installing

export class ChecksumError extends Error {
  constructor(readonly tool: string) {
    super(`${tool} download didn't match the pinned checksum. Nothing was installed.`);
  }
}

/**
 * uv: on PATH, or where uv's official installer puts it (UV_INSTALL_DIR, XDG_BIN_HOME, ~/.local/bin, then the older
 * ~/.cargo/bin), so a uv installed during this session is found before the shell's PATH picks it up.
 */
export async function findUv(env: NodeJS.ProcessEnv, homeDir: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const found = await onPath("uv", env, platform);
  if (found) return found;
  const name = platform === "win32" ? "uv.exe" : "uv";
  const dirs = [env.UV_INSTALL_DIR, env.XDG_BIN_HOME, path.join(homeDir, ".local", "bin"), path.join(homeDir, ".cargo", "bin")];
  for (const dir of dirs) {
    if (dir && path.isAbsolute(dir) && await isFile(path.join(dir, name))) return path.join(dir, name);
  }
  return undefined;
}

export const UV_MISSING = "Security checks need uv to install Python tools.";
export const UV_MISSING_NETWORK = "Setting up the network server needs uv. Install it from docs.astral.sh/uv, then type /mcp setup network.";

export interface InstallOptions {
  homeDir: string;
  /** The environment the install starts from; credentials never pass on. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Downloads one URL. Defaults to fetch(); tests pass a stub. */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  run?: ToolRunner;
  /** Progress lines. */
  write?: (text: string) => void;
}

export interface InstallResult { id: string; ok: boolean; message: string }

async function defaultFetch(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

function toolsRoot(homeDir: string): string {
  return path.join(homeDir, ".casper", "tools");
}

async function finish(spec: SecurityToolSpec, dir: string, pin: string): Promise<void> {
  const marker: InstalledMarker = { id: spec.id, version: spec.version, pin };
  await writeFile(path.join(dir, MARKER), `${JSON.stringify(marker)}\n`);
}

async function installBinary(spec: SecurityToolSpec, options: InstallOptions): Promise<InstallResult> {
  if (spec.source.kind !== "binary") throw new Error("not a binary tool");
  const platform = options.platform ?? process.platform;
  const key = hostPlatform(platform, options.arch ?? process.arch);
  const asset = key ? spec.source.assets[key] : undefined;
  if (!asset) return { id: spec.id, ok: false, message: `${spec.label}: Casper has no pinned download for this computer (${platform} ${options.arch ?? process.arch}).` };
  options.write?.(`Downloading ${spec.label} ${spec.version}…\n`);
  const bytes = await (options.fetchBytes ?? defaultFetch)(asset.url);
  // Checked before anything touches the disk: a mismatch installs nothing.
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256) throw new ChecksumError(spec.label);
  const root = toolsRoot(options.homeDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = path.join(root, `.staging-${spec.id}-${randomUUID()}`);
  try {
    await mkdir(path.join(staging, "bin"), { recursive: true });
    const program = path.join(staging, "bin", platform === "win32" ? `${spec.command}.exe` : spec.command);
    if (asset.archive === "raw") {
      await writeFile(program, bytes);
    } else {
      const archive = path.join(staging, `download.${asset.archive === "zip" ? "zip" : "tar.gz"}`);
      const extract = path.join(staging, "extract");
      await writeFile(archive, bytes);
      await mkdir(extract);
      const unpacked = await (options.run ?? runTool)({
        file: "tar", args: [asset.archive === "zip" ? "-xf" : "-xzf", archive, "-C", extract, asset.member],
        cwd: staging, env: installEnv(options.env ?? process.env), timeoutMs: 120_000,
      });
      const member = path.join(extract, asset.member);
      if (unpacked.exitCode !== 0 || !(await lstat(member).then((details) => details.isFile(), () => false))) {
        throw new Error(`${spec.label}: could not unpack the download`);
      }
      await copyFile(member, program);
      await rm(extract, { recursive: true, force: true });
      await rm(archive, { force: true });
    }
    await chmod(program, 0o755);
    await finish(spec, staging, asset.sha256);
    const target = pinnedToolDir(options.homeDir, spec);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    return { id: spec.id, ok: true, message: `${spec.label} ${spec.version} installed` };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Why uv's hash-locked install failed, in plain words with one next step, and uv's own last line. */
export function installFailure(stderr: string): string {
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  const uv = last ? ` (uv: ${last.length > 200 ? `${last.slice(0, 199)}…` : last})` : "";
  if (/hash mismatch|hashes? (?:do not|don't) match/i.test(stderr)) return `a download did not match its pinned hash, so nothing was installed. Try again later.${uv}`;
  if (/dns error|failed to fetch|connection (?:refused|reset)|timed out|network is unreachable|could not connect|failed to lookup/i.test(stderr)) {
    return `the install couldn't reach pypi.org. Check your internet connection, then try again.${uv}`;
  }
  if (/(?:no|doesn't have a) (?:source distribution or )?wheel|no matching distribution|not compatible with the current platform|for the current platform/i.test(stderr)) {
    return `there is no ready-made build of it for this computer.${uv}`;
  }
  return `the install failed.${uv}`;
}

interface LockedBuild { label: string; version: string; source: UvLockSource; relocatable: boolean }

/** The program inside a locked venv folder. */
function venvEntry(dir: string, entry: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.join(dir, "venv", "Scripts", `${entry}.exe`) : path.join(dir, "venv", "bin", entry);
}

/**
 * Builds a hash-locked venv in `dir` (emptied first). The marker, written last by the caller, is what
 * makes it count; on any failure the folder is removed and the error thrown.
 */
async function buildLockedVenv(build: LockedBuild, dir: string, uv: string, options: InstallOptions): Promise<void> {
  const env = installEnv(options.env ?? process.env);
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runTool;
  const { label, version, source } = build;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const lockFile = path.join(dir, source.lockName);
    await writeFile(lockFile, source.lock);
    options.write?.(`Installing ${label} ${version} (hash-locked)…\n`);
    const venv = path.join(dir, "venv");
    // A venv built in one folder and moved to another needs relative paths in its scripts.
    const made = await run({ file: uv, args: ["venv", "--quiet", "--no-project", ...(build.relocatable ? ["--relocatable"] : []), "--python", source.python, venv], cwd: dir, env, timeoutMs: 600_000 });
    if (made.exitCode !== 0) throw new Error(`${label}: uv could not make a Python ${source.python} environment`);
    const python = platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
    const installed = await run({
      file: uv, args: ["pip", "install", "--quiet", "--python", python, "--require-hashes", "--no-deps", "--only-binary", ":all:", "-r", lockFile],
      cwd: dir, env, timeoutMs: 1_200_000,
    });
    if (installed.exitCode !== 0) throw new Error(`${label}: ${installFailure(installed.stderr)}`);
    if (!(await isFile(venvEntry(dir, source.entry, platform)))) throw new Error(`${label}: the install did not create ${source.entry}`);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function installLocked(spec: SecurityToolSpec, options: InstallOptions): Promise<InstallResult> {
  if (spec.source.kind !== "uv-lock") throw new Error("not a Python tool");
  const uv = await onPath("uv", installEnv(options.env ?? process.env), options.platform ?? process.platform);
  if (!uv) return { id: spec.id, ok: false, message: UV_MISSING };
  // Security tools keep a folder per version, built in place.
  const dir = pinnedToolDir(options.homeDir, spec);
  await buildLockedVenv({ label: spec.label, version: spec.version, source: spec.source, relocatable: false }, dir, uv, options);
  try {
    await finish(spec, dir, pinFingerprint(spec, options.platform ?? process.platform, options.arch)!);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { id: spec.id, ok: true, message: `${spec.label} ${spec.version} installed` };
}

// ---------------------------------------------------------------------------------------------------------
// Locked programs in a version-less folder (MCP servers)

/** ~/.casper/tools/<id>: no version in the name, so a saved command never goes stale. */
function lockedDir(homeDir: string, spec: LockedSpec): string {
  return path.join(toolsRoot(homeDir), spec.id);
}

/** The program a locked spec installs: ~/.casper/tools/<id>/venv/bin/<entry>. */
export function lockedEntryPath(homeDir: string, spec: LockedSpec, platform: NodeJS.Platform = process.platform): string {
  return venvEntry(lockedDir(homeDir, spec), spec.source.entry, platform);
}

/** The version Casper installed there, from its marker; undefined when nothing complete is installed. */
export async function installedVersion(homeDir: string, spec: LockedSpec, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  try {
    const marker = JSON.parse(await readFile(path.join(lockedDir(homeDir, spec), MARKER), "utf8")) as Partial<InstalledMarker>;
    if (marker.id !== spec.id || typeof marker.version !== "string") return undefined;
    return await isFile(lockedEntryPath(homeDir, spec, platform)) ? marker.version : undefined;
  } catch {
    return undefined;
  }
}

const isDir = (dir: string) => lstat(dir).then((details) => details.isDirectory(), () => false);

/**
 * Installs a locked spec into ~/.casper/tools/<id>. A new version is built in <id>.new and swapped in
 * by rename only once its marker is written; a failed or killed install leaves the old folder working.
 * `swap` runs the two renames: the caller stops the running program around them (Windows can't rename a folder
 * a running program uses), and a failed swap puts the old folder back. Never throws.
 */
export async function installLockedSpec(spec: LockedSpec, options: InstallOptions & {
  uvMissing?: string; swap?: (renames: () => Promise<void>) => Promise<void>;
}): Promise<{ ok: boolean; message: string; entryPath?: string }> {
  const platform = options.platform ?? process.platform;
  const uv = await findUv(installEnv(options.env ?? process.env), options.homeDir, platform);
  if (!uv) return { ok: false, message: options.uvMissing ?? `${spec.label} needs uv to install. Install it from docs.astral.sh/uv.` };
  const target = lockedDir(options.homeDir, spec);
  const staging = `${target}.new`;
  const old = `${target}.old`;
  try {
    await mkdir(toolsRoot(options.homeDir), { recursive: true, mode: 0o700 });
    // A swap killed between its two renames left only <id>.old: put it back first.
    if (!(await isDir(target)) && await isDir(old)) await rename(old, target);
    await rm(old, { recursive: true, force: true });
    await buildLockedVenv({ label: spec.label, version: spec.version, source: spec.source, relocatable: true }, staging, uv, options);
    try {
      const marker: InstalledMarker = { id: spec.id, version: spec.version, pin: createHash("sha256").update(spec.source.lock).digest("hex") };
      await writeFile(path.join(staging, MARKER), `${JSON.stringify(marker)}\n`);
      const renames = async () => {
        const hadOld = await isDir(target);
        if (hadOld) await rename(target, old);
        try {
          await rename(staging, target);
        } catch (error) {
          if (hadOld) await rename(old, target).catch(() => undefined);
          throw error;
        }
      };
      await (options.swap ? options.swap(renames) : renames());
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    await rm(old, { recursive: true, force: true });
    return { ok: true, message: `${spec.label} ${spec.version} installed`, entryPath: lockedEntryPath(options.homeDir, spec, platform) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Installs one pinned tool. Never throws: a failure is a plain message and nothing is left behind. */
export async function installTool(spec: SecurityToolSpec, options: InstallOptions): Promise<InstallResult> {
  try {
    return spec.source.kind === "binary" ? await installBinary(spec, options) : await installLocked(spec, options);
  } catch (error) {
    return { id: spec.id, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function installTools(ids: readonly SecurityToolId[], options: InstallOptions): Promise<InstallResult[]> {
  const results: InstallResult[] = [];
  for (const id of ids) results.push(await installTool(SECURITY_TOOLS[id], options));
  return results;
}

// ---------------------------------------------------------------------------------------------------------
// osv-scanner's advisory data

export function osvDbDir(homeDir: string): string {
  return path.join(homeDir, ".casper", "security", "osv-db");
}

export interface OsvDbState {
  present: boolean;
  ecosystems: string[];
  /** When the oldest ecosystem file was downloaded. */
  downloadedAt?: Date;
  ageDays?: number;
}

export async function osvDbState(homeDir: string, now = new Date()): Promise<OsvDbState> {
  const base = path.join(osvDbDir(homeDir), "osv-scalibr");
  let oldest: Date | undefined;
  const ecosystems: string[] = [];
  for (const name of await readdir(base).catch(() => [] as string[])) {
    const details = await stat(path.join(base, name, "all.zip")).catch(() => undefined);
    if (!details?.isFile()) continue;
    ecosystems.push(name);
    if (!oldest || details.mtime < oldest) oldest = details.mtime;
  }
  if (!oldest) return { present: false, ecosystems: [] };
  return { present: true, ecosystems: ecosystems.sort(), downloadedAt: oldest, ageDays: Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 86_400_000)) };
}

export const OSV_UPDATE_QUESTION: NumberedQuestion = {
  text: "osv-scanner downloads advisory data for this project's package types from osv-vulnerabilities.storage.googleapis.com (tens of MB).",
  // Stop comes first, so Enter never downloads.
  choices: ["Stop", "Download it"],
};

/**
 * Downloads osv-scanner's advisory data for the package types this repo uses. The only networked step
 * besides installing; the host asks first. Returns a plain line for the report.
 */
export async function updateOsvDb(root: string, toolPath: string, options: InstallOptions & { signal?: AbortSignal }): Promise<{ ok: boolean; message: string }> {
  const dir = osvDbDir(options.homeDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const result = await (options.run ?? runTool)({
    file: toolPath, args: ["scan", "source", "--offline-vulnerabilities", "--download-offline-databases", "--no-resolve", "--format", "json", "--recursive", "."],
    cwd: root, env: { ...installEnv(options.env ?? process.env), OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: dir }, timeoutMs: 600_000, signal: options.signal,
  });
  const state = await osvDbState(options.homeDir);
  if ((result.exitCode === 0 || result.exitCode === 1 || result.exitCode === 128) && state.present) {
    return { ok: true, message: `Advisory data downloaded for ${state.ecosystems.join(", ")}.` };
  }
  return { ok: false, message: "osv-scanner could not download the advisory data." };
}
