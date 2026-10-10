import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { safeGitArgs } from "../platform/git";
import { RELEASE_KEY } from "./release-key";
import { checkInstaller } from "./verify-installer";
import { lastUpdateFailure, removeUpdateLog, startUpdateLog, updateFailureLines, updateLogPath } from "./handoff-log";

/**
 * `casper update`: no model, no tokens and no saved state.
 * - A release binary asks GitHub for the newest release (previews count; drafts do not) and, when it is newer,
 *   runs that release's own installer on the folder this program is in, pinned to the new version. On Windows the
 *   running casper.exe cannot be replaced, so the checked installer is handed to a separate hidden process that waits
 *   for Casper to exit and then runs that same file. The installer is
 *   checked first (verify-installer.ts): against the signed SHA256SUMS once there is a release key, and against
 *   GitHub's build provenance when gh is signed in.
 * - A source checkout never looks at releases: it pulls with git (fast-forward only) and, when the lockfile
 *   changed, runs `bun install --frozen-lockfile` in the checkout.
 * `--check` only says whether there is something newer. Exit 0 done or nothing to do, 1 not finished (the message
 * says what is left to do).
 */

export const RELEASE_REPO = "Choaterboater/casper";
const RELEASES_API = `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=30`;
const DOWNLOAD = `https://github.com/${RELEASE_REPO}/releases/download`;
const NOTHING_CHANGED = "Nothing was changed.";
const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/;
/** Settings the installers read; the user's own must not change the hash, the platform or the folder. */
const INSTALLER_SETTINGS = ["CASPER_BASE_URL", "CASPER_INSTALL_DIR", "CASPER_VERSION", "CASPER_SHA256", "CASPER_OS", "CASPER_ARCH"];

export type Install = { kind: "checkout"; root: string } | { kind: "binary"; executable: string };

export type Fetcher = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: "follow" }) => Promise<Response>;

/** `code` is null when the program could not start (not installed). */
export interface ProcessRun { code: number | null; stdout: string; stderr: string }
export type ProcessRunner = (argv: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; inherit?: boolean; signal?: AbortSignal; timeoutMs?: number }) => Promise<ProcessRun>;

export type DetachedStarter = (argv: string[], options: { env: NodeJS.ProcessEnv }) => Promise<boolean>;

export interface UpdateOptions {
  check: boolean;
  install: Install;
  currentVersion: string;
  write: (line: string) => void;
  platform?: NodeJS.Platform;
  /** This program's CPU, as the release files name it (x64 or arm64); tests pass one. */
  arch?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetcher;
  run?: ProcessRunner;
  /** Windows only: starts a program fully detached (own process, no window, not tied to this console) and says whether it started. */
  startDetached?: DetachedStarter;
  /** The id of this process, which the Windows handoff waits on; tests pass one. */
  pid?: number;
  /** The folder that holds Casper's state (~/.casper). The Windows handoff writes update.log there, and an update that
   * did not finish last time is said before a new one starts. Unset, neither happens (tests). */
  stateDir?: string;
  /** The bun that runs the checkout; `bun install` uses it. */
  bun?: string;
  /** The release key SHA256SUMS must be signed with (tests pass a throwaway one); empty checks no signature. */
  releaseKey?: string;
  signal?: AbortSignal;
}

const OUTPUT_BYTES = 4 * 1024 * 1024;

/** Runs a program directly (no shell, no sandbox: the user is updating their own install). `inherit` streams its
 * output to this terminal; otherwise stdout and stderr are captured. */
export const defaultRunner: ProcessRunner = (argv, options) => new Promise((resolve) => {
  let child;
  try {
    child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
      stdio: options.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"] });
  } catch { resolve({ code: null, stdout: "", stderr: "" }); return; }
  const out: Buffer[] = [], err: Buffer[] = [];
  let size = 0;
  const collect = (into: Buffer[]) => (chunk: Buffer) => { size += chunk.length; if (size <= OUTPUT_BYTES) into.push(chunk); };
  child.stdout?.on("data", collect(out));
  child.stderr?.on("data", collect(err));
  const kill = () => child.kill("SIGTERM");
  const timer = options.timeoutMs ? setTimeout(kill, options.timeoutMs) : undefined;
  options.signal?.addEventListener("abort", kill, { once: true });
  let started = true;
  child.on("error", () => { started = false; });
  child.on("close", (code) => {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);
    resolve({ code: started ? code ?? 1 : null, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
  });
});

/** Starts a program that outlives this one: no shell, no window, no link to this console. True once it has started. */
export const defaultDetachedStarter: DetachedStarter = (argv, options) => new Promise((resolve) => {
  try {
    const child = spawn(argv[0]!, argv.slice(1), { env: options.env, shell: false, detached: true, windowsHide: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => { child.unref(); resolve(true); });
  } catch { resolve(false); }
});

/** How long the handoff waits for Casper to exit before giving up without installing. */
export const HANDOFF_WAIT_SECONDS = 300;

/** The program Windows runs after Casper has exited. It takes everything as parameters (nothing is built into a command
 * string), waits for exactly one process id, checks the installer file is the one Casper verified, and runs only that file. */
export const HANDOFF_SCRIPT = `param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 4194304)][int]$WaitPid,
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$InstallerSha256,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?$')][string]$Version,
  [Parameter(Mandatory = $true)][string]$Cleanup,
  [string]$LogFile = '',
  [int]$WaitSeconds = ${HANDOFF_WAIT_SECONDS}
)
$ErrorActionPreference = 'Stop'
# One line per step in update.log, which nobody else can see: this process has no window. A log that cannot be written is not an error.
function Write-Step([string]$Text) {
  if (-not $LogFile) { return }
  try { Add-Content -LiteralPath $LogFile -Value ((Get-Date).ToString('s') + ' ' + $Text) -Encoding UTF8 } catch { }
}
try {
  Write-Step "helper started; waiting for Casper (process $WaitPid) to exit"
  # Wait for Casper to exit. A process that is already gone is fine; any other answer means do nothing.
  $casper = $null
  try { $casper = Get-Process -Id $WaitPid -ErrorAction Stop }
  catch [Microsoft.PowerShell.Commands.ProcessCommandException] { $casper = $null }
  if ($casper) {
    if (-not $casper.WaitForExit($WaitSeconds * 1000)) {
      Write-Step "Casper (process $WaitPid) was still running after $WaitSeconds seconds"
      Write-Step 'result: failed: Casper did not exit in time, so nothing was changed'
      exit 1
    }
    $casper.Dispose()
    Write-Step "Casper (process $WaitPid) exited"
  } else {
    Write-Step "Casper (process $WaitPid) had already exited"
  }
  Start-Sleep -Seconds 1
  $Actual = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash
  Write-Step "installer SHA-256 expected $InstallerSha256, actual $Actual"
  if ($Actual -ne $InstallerSha256) {
    Write-Step 'result: failed: the installer file is not the one Casper checked, so it was not run'
    exit 1
  }
  $env:CASPER_INSTALL_DIR = $InstallDir
  $env:CASPER_VERSION = $Version
  Remove-Item -LiteralPath (Join-Path $InstallDir 'casper.old.exe') -Force -ErrorAction SilentlyContinue
  Write-Step 'running the installer'
  & $Installer
  Write-Step 'the installer finished'
  # The installer's own words go to this hidden window. What counts is the program it left behind.
  $Seen = ''
  try {
    $Said = ((& (Join-Path $InstallDir 'casper.exe') --version) | Out-String)
    if ($Said -match 'casper (\\S+)') { $Seen = $Matches[1] }
  } catch { $Seen = '' }
  Write-Step "installed program version: $Seen"
  if ($Seen -eq $Version) { Write-Step 'result: ok' }
  else { Write-Step "result: failed: the installer ran, but the program in the install folder says version '$Seen' and not $Version" }
} catch {
  Write-Step ('error: ' + $_.Exception.Message)
  Write-Step ('result: failed: ' + $_.Exception.Message)
} finally {
  Remove-Item -LiteralPath $Cleanup -Recurse -Force -ErrorAction SilentlyContinue
}
`;

export async function runUpdate(options: UpdateOptions): Promise<{ exitCode: number }> {
  return options.install.kind === "checkout" ? updateCheckout(options, options.install.root) : updateBinary(options, options.install.executable);
}

// --- Versions and releases ---

/** Dotted numbers compare as numbers; a pre-release suffix (`-rc.1`) comes before its release. A leading v is ignored. */
export function compareVersions(a: string, b: string): number {
  const split = (version: string) => {
    const [core = "", ...pre] = version.replace(/^v/, "").split("-");
    return { core: core.split(".").map(Number), pre: pre.join("-") };
  };
  const left = split(a), right = split(b);
  for (let index = 0; index < Math.max(left.core.length, right.core.length); index++) {
    const order = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (order) return order;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  const x = left.pre.split("."), y = right.pre.split(".");
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    if (x[index] === undefined) return -1;
    if (y[index] === undefined) return 1;
    const nx = Number(x[index]), ny = Number(y[index]);
    const order = Number.isNaN(nx) || Number.isNaN(ny) ? x[index]!.localeCompare(y[index]!) : nx - ny;
    if (order) return order;
  }
  return 0;
}

export interface Release { version: string; assets: Array<{ name: string; digest?: string }> }

/** The newest published release in GitHub's list, previews included, drafts and non-version tags skipped. */
export function newestRelease(list: unknown): Release | undefined {
  if (!Array.isArray(list)) return undefined;
  let newest: Release | undefined;
  for (const entry of list as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object" || entry.draft !== false || typeof entry.tag_name !== "string") continue;
    const version = TAG.exec(entry.tag_name)?.[1];
    if (!version || (newest && compareVersions(version, newest.version) <= 0)) continue;
    const assets = Array.isArray(entry.assets) ? (entry.assets as Array<Record<string, unknown>>).flatMap((asset) =>
      asset && typeof asset.name === "string" ? [{ name: asset.name, ...(typeof asset.digest === "string" ? { digest: asset.digest } : {}) }] : []) : [];
    newest = { version, assets };
  }
  return newest;
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

/** The newest release, or the one plain sentence that says why it is not known. */
/** A GitHub token from GITHUB_TOKEN or GH_TOKEN raises GitHub's hourly limit on release lookups. It is sent only to
 * the releases API, never with a download. */
export function githubToken(env: NodeJS.ProcessEnv): string | undefined {
  return env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || undefined;
}

export async function lookUpNewest(fetcher: Fetcher, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Release | string> {
  const token = githubToken(env);
  let response: Response;
  try {
    response = await fetcher(RELEASES_API, { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "casper-update",
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: timeoutSignal(signal, 30_000), redirect: "follow" });
  } catch { return `Could not reach GitHub to look for a newer Casper. ${NOTHING_CHANGED}`; }
  if (token && response.status === 401) return `GitHub did not accept the token in ${env.GITHUB_TOKEN?.trim() ? "GITHUB_TOKEN" : "GH_TOKEN"}. ${NOTHING_CHANGED}`;
  if (response.status === 403 || response.status === 429) {
    return token ? `GitHub is limiting requests right now; try again later. ${NOTHING_CHANGED}`
      : `GitHub is limiting requests right now; try again later, or set GITHUB_TOKEN to a GitHub token for a higher limit. ${NOTHING_CHANGED}`;
  }
  if (!response.ok) return `GitHub answered with an error (HTTP ${response.status}). ${NOTHING_CHANGED}`;
  let list: unknown;
  try { list = await response.json(); } catch { list = undefined; }
  return newestRelease(list) ?? `GitHub's list of Casper releases could not be read. ${NOTHING_CHANGED}`;
}

// --- A release binary ---

async function updateBinary(options: UpdateOptions, executable: string): Promise<{ exitCode: number }> {
  const { write, currentVersion } = options;
  const fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const newest = await lookUpNewest(fetcher, options.env ?? process.env, options.signal);
  if (typeof newest === "string") { write(newest); return { exitCode: 1 }; }
  const version = newest.version;
  if (compareVersions(version, currentVersion) <= 0) { write(`Casper ${currentVersion} is the newest release.`); return { exitCode: 0 }; }
  if (options.stateDir) {
    const failed = await lastUpdateFailure(options.stateDir, currentVersion);
    if (failed) for (const line of updateFailureLines(failed)) write(line);
  }
  if (options.check) { write(`Casper ${version} is out; you have ${currentVersion}. Run casper update to install it.`); return { exitCode: 0 }; }

  const windows = (options.platform ?? process.platform) === "win32";
  // The installer replaces <folder>/casper (casper.exe on Windows): the program that actually runs, links resolved.
  const program = await realpath(executable).catch(() => executable);
  const folder = path.dirname(program);
  const expected = windows ? "casper.exe" : "casper";
  const name = path.basename(program);
  if ((windows ? name.toLowerCase() : name) !== expected) {
    write(`This Casper is named ${name}, and the installer writes ${expected}, so it would not replace this one. Rename it to ${expected} first. ${NOTHING_CHANGED}`);
    return { exitCode: 1 };
  }

  const base = `${DOWNLOAD}/v${version}`;
  const script = windows ? "install.ps1" : "install.sh";
  const download = async (file: string): Promise<string | undefined> => {
    try {
      const response = await fetcher(`${base}/${file}`, { headers: { "User-Agent": "casper-update" }, signal: timeoutSignal(options.signal, 60_000), redirect: "follow" });
      return response.ok ? await response.text() : undefined;
    } catch { return undefined; }
  };
  const releaseKey = options.releaseKey ?? RELEASE_KEY;
  const [installer, sums, signature] = await Promise.all([download(script), download("SHA256SUMS"), releaseKey ? download("SHA256SUMS.sig") : undefined]);
  if (installer === undefined || sums === undefined) { write(`Could not download the Casper ${version} installer from GitHub. ${NOTHING_CHANGED}`); return { exitCode: 1 }; }
  const refused = checkInstaller({ version, script, installer, sums, signature, releaseKey,
    published: newest.assets.find((asset) => asset.name === script)?.digest });
  if (refused) { write(`${refused} ${NOTHING_CHANGED}`); return { exitCode: 1 }; }
  const listed = listedDigest(sums, script) !== undefined;
  // This program's own file: the installer checks it against the list Casper just checked, and fetches none itself.
  const arch = options.arch ?? process.arch;
  const binary = `casper-${windows ? "windows" : options.platform ?? process.platform}-${arch}${windows ? ".exe" : ""}`;
  const binaryDigest = listedDigest(sums, binary);
  if (releaseKey && !binaryDigest) { write(`The signed list for Casper ${version} does not name ${binary}, so nothing was installed. ${NOTHING_CHANGED}`); return { exitCode: 1 }; }
  // Its own default download address names its release; one for another release is not run.
  if (!installer.includes(`${base}}`) && !installer.includes(`'${base}'`)) {
    write(`The downloaded installer is for a different release than ${version}, so it was not run. ${NOTHING_CHANGED}`);
    return { exitCode: 1 };
  }

  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  for (const setting of INSTALLER_SETTINGS) delete env[setting];
  env.CASPER_BASE_URL = base;
  if (binaryDigest) Object.assign(env, { CASPER_SHA256: binaryDigest, CASPER_ARCH: arch, ...(windows ? {} : { CASPER_OS: options.platform ?? process.platform }) });
  const run = options.run ?? defaultRunner;
  // Private to this user: the folder is made with owner-only access (Windows: inside the user's own temp folder).
  const temp = await mkdtemp(path.join(os.tmpdir(), "casper-update-"));
  let handedOff = false;
  try {
    const file = path.join(temp, script);
    await writeFile(file, installer, { mode: 0o600 });
    // Where it was built: a release that lists its installers in SHA256SUMS has build provenance for them too.
    if (listed && !(await builtByGitHub(run, file, options))) {
      write(`The downloaded installer doesn't match a Casper build from GitHub, so it was not run. ${NOTHING_CHANGED}`);
      return { exitCode: 1 };
    }
    write(`Updating Casper from ${currentVersion} to ${version}.`);
    if (!windows) {
      const result = await run(["sh", file, "--dir", folder, "--version", version], { env, inherit: true, ...(options.signal ? { signal: options.signal } : {}) });
      return finished(write, result.code === 0, currentVersion, version);
    }
    // Windows will not replace casper.exe while it runs, so a separate process does it once this one has exited.
    const handoff = path.join(temp, "handoff.ps1");
    await writeFile(handoff, HANDOFF_SCRIPT, { mode: 0o600 });
    // The log is started here, before the helper, so a helper that never runs leaves a `pending` log to find.
    const log = options.stateDir ? await startUpdateLog(options.stateDir, currentVersion, version) : undefined;
    const started = await (options.startDetached ?? defaultDetachedStarter)([
      "powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", handoff,
      "-WaitPid", String(options.pid ?? process.pid), "-Installer", file, "-InstallerSha256", createHash("sha256").update(installer).digest("hex"),
      "-InstallDir", folder, "-Version", version, "-Cleanup", temp, ...(log ? ["-LogFile", log] : []),
    ], { env }).catch(() => false);
    if (!started) {
      if (options.stateDir) await removeUpdateLog(options.stateDir);
      write(`Windows would not let Casper move its own program aside. Close Casper, then run this in PowerShell: irm ${DOWNLOAD}/v${version}/install.ps1 | iex`);
      return { exitCode: 1 };
    }
    handedOff = true;
    write(`Casper cannot replace itself while it runs. A hidden helper does it once this Casper has exited, and it downloads the new program first. Close Casper if it is still open, wait about 30 seconds, then run casper --version.${log ? ` If it still shows ${currentVersion}, ${updateLogPath(options.stateDir!)} says what happened.` : ""}`);
    return { exitCode: 0 };
  } finally { if (!handedOff) await rm(temp, { recursive: true, force: true }); }
}

/** The SHA-256 a SHA256SUMS list gives for `file`, or undefined when it doesn't name it. */
function listedDigest(sums: string, file: string): string | undefined {
  return sums.split(/\r?\n/).map((line) => /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim())).find((match) => match?.[2] === file)?.[1]?.toLowerCase();
}

/** False only when gh is installed and signed in and says the file is not a build from the Casper repository.
 * A gh older than 2.56 cannot check Casper's builds (one older than 2.47 has no `attestation` command at all). Its own
 * version and help, asked without the file, tell that apart from a mismatch; a gh whose version can't be read and that
 * has the command gets the full check. */
async function builtByGitHub(run: ProcessRunner, file: string, options: UpdateOptions): Promise<boolean> {
  const env = options.env ?? process.env;
  const signal = options.signal ? { signal: options.signal } : {};
  if ((await run(["gh", "auth", "status"], { env, timeoutMs: 30_000, ...signal })).code !== 0) return true;
  const ghVersion = /^gh version (\d+)\.(\d+)\./.exec((await run(["gh", "--version"], { env, timeoutMs: 30_000, ...signal })).stdout);
  if (ghVersion && (Number(ghVersion[1]) < 2 || (Number(ghVersion[1]) === 2 && Number(ghVersion[2]) < 56))) return true;
  if ((await run(["gh", "attestation", "verify", "--help"], { env, timeoutMs: 30_000, ...signal })).code !== 0) return true;
  return (await run(["gh", "attestation", "verify", file, "--repo", RELEASE_REPO], { env, timeoutMs: 120_000, ...signal })).code === 0;
}

function finished(write: (line: string) => void, ok: boolean, from: string, to: string): { exitCode: number } {
  write(ok ? `Casper is now ${to}.` : `The installer stopped before it finished; Casper ${from} is still installed.`);
  return { exitCode: ok ? 0 : 1 };
}

// --- A source checkout ---

/** Settings that would point git at another repository or another configuration. The ones that reach the remote
 * (GIT_SSH, GIT_SSH_COMMAND, GIT_ASKPASS, GIT_PROXY_*) are the user's own and stay. */
const GIT_REPO_SETTINGS = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|CEILING_DIRECTORIES|NAMESPACE|COMMON_DIR|PREFIX)$/i;

/** Git's messages are kept in English (LC_ALL=C) so the few it is asked about read the same everywhere. */
export function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && !GIT_REPO_SETTINGS.test(name)) env[name] = value;
  return { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C", LANGUAGE: "C" };
}

async function checkoutVersion(root: string): Promise<string | undefined> {
  try {
    const version = (JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch { return undefined; }
}

const changes = (count: number) => `${count} new change${count === 1 ? "" : "s"}`;

async function updateCheckout(options: UpdateOptions, root: string): Promise<{ exitCode: number }> {
  const { write } = options;
  const run = options.run ?? defaultRunner;
  const env = gitEnv(options.env ?? process.env);
  const git = (...args: string[]) => run(["git", ...safeGitArgs(args)], { cwd: root, env, timeoutMs: 120_000, ...(options.signal ? { signal: options.signal } : {}) });
  const fail = (line: string) => { write(line); return { exitCode: 1 }; };

  const top = await git("rev-parse", "--show-toplevel");
  if (top.code === null) return fail(`Git is not installed, so the Casper checkout at ${root} cannot be updated.`);
  if (top.code !== 0) return fail(`Casper runs from ${root}, which is not a git checkout, so it cannot be updated with git.`);
  if ((await git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")).code !== 0) {
    // Names the branch it is on and, when the remote's main branch is known, the one step that makes it updatable.
    const branch = (await git("symbolic-ref", "--quiet", "--short", "HEAD")).stdout.trim();
    if (!branch) return fail(`The Casper checkout at ${root} is not on a branch, so there is nothing to pull from${options.check ? "" : " and it was not updated"}.`);
    const remoteHead = (await git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")).stdout.trim();
    const main = remoteHead.startsWith("origin/") ? remoteHead.slice("origin/".length) : "";
    return fail(`The Casper checkout at ${root} is on ${branch}, which has no remote to pull from${options.check ? "" : ", so it was not updated"}.`
      + (main && main !== branch ? ` To update it, switch to ${main} (git switch ${main}) and run casper update again.` : ""));
  }
  const before = await checkoutVersion(root) ?? options.currentVersion;

  if (options.check) {
    if ((await git("fetch", "--quiet")).code !== 0) return fail(`Could not reach the remote of the Casper checkout at ${root} to look for changes.`);
    const behind = Number((await git("rev-list", "--count", "HEAD..@{upstream}")).stdout.trim()) || 0;
    write(behind ? `The Casper checkout at ${root} is ${behind} change${behind === 1 ? "" : "s"} behind. Run casper update to pull them.`
      : `The Casper checkout at ${root} is up to date (${before}).`);
    return { exitCode: 0 };
  }

  const head = async () => (await git("rev-parse", "HEAD")).stdout.trim();
  const start = await head();
  const pull = await git("pull", "--ff-only", "--quiet");
  if (pull.code !== 0) {
    // Its own commits are in the way only when the branch has diverged (each side has commits the other lacks): a
    // checkout that is only ahead pulls cleanly, so its failed pull is the network or a lock. Git's text covers changes in the way.
    const onlyAhead = (await git("merge-base", "--is-ancestor", "@{upstream}", "HEAD")).code === 0;
    const ownCommits = !onlyAhead && (await git("merge-base", "--is-ancestor", "HEAD", "@{upstream}")).code === 1;
    return fail(ownCommits || /fast-forward|diverg|would be overwritten|local changes|untracked working tree/i.test(pull.stderr)
      ? `The Casper checkout at ${root} has its own commits or changes in the way, so it was not updated; nothing was forced.`
      : `Git could not pull into the Casper checkout at ${root} (is the network down?), so it was not updated.`);
  }
  const end = await head();
  if (end === start) { write(`The Casper checkout at ${root} is already up to date (${before}).`); return { exitCode: 0 }; }
  const count = Number((await git("rev-list", "--count", `${start}..${end}`)).stdout.trim()) || 0;
  const after = await checkoutVersion(root) ?? before;
  write(after !== before ? `Updated the Casper checkout at ${root} from ${before} to ${after}.`
    : `Updated the Casper checkout at ${root} (still ${after}, ${changes(count)}).`);

  // `git diff --quiet` exits 1 when the lockfile differs between the two commits.
  if ((await git("diff", "--quiet", start, end, "--", "bun.lock")).code !== 1) return { exitCode: 0 };
  const installed = await run([options.bun ?? process.execPath, "install", "--frozen-lockfile"], { cwd: root, env: options.env ?? process.env, inherit: true,
    ...(options.signal ? { signal: options.signal } : {}) });
  if (installed.code === 0) { write("Casper's dependency list (bun.lock) changed, so it ran bun install in the checkout."); return { exitCode: 0 }; }
  return fail(`Casper's dependency list (bun.lock) changed, but bun install failed; run bun install --frozen-lockfile in ${root}.`);
}
