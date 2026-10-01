import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { safeGitArgs } from "../platform/git";

/**
 * `casper update`: no model, no tokens and no saved state.
 * - A release binary asks GitHub for the newest release (previews count; drafts do not) and, when it is newer,
 *   runs that release's own installer on the folder this program is in, pinned to the new version.
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

export interface UpdateOptions {
  check: boolean;
  install: Install;
  currentVersion: string;
  write: (line: string) => void;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetcher;
  run?: ProcessRunner;
  /** The bun that runs the checkout; `bun install` uses it. */
  bun?: string;
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
  const [installer, sums] = await Promise.all([download(script), download("SHA256SUMS")]);
  if (installer === undefined || sums === undefined) { write(`Could not download the Casper ${version} installer from GitHub. ${NOTHING_CHANGED}`); return { exitCode: 1 }; }
  // SHA256SUMS lists the binaries (which the installer checks itself); the installer is checked against it when it is
  // listed, and against the digest GitHub publishes for the file.
  const digest = createHash("sha256").update(installer).digest("hex");
  const listed = sums.split(/\r?\n/).map((line) => /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim())).find((match) => match?.[2] === script)?.[1];
  const published = newest.assets.find((asset) => asset.name === script)?.digest?.replace(/^sha256:/i, "");
  if ((listed && listed.toLowerCase() !== digest) || (published && published.toLowerCase() !== digest)) {
    write(`The downloaded installer did not match the release's checksum, so it was not run. ${NOTHING_CHANGED}`);
    return { exitCode: 1 };
  }
  // Its own default download address names its release; one for another release is not run.
  if (!installer.includes(`${base}}`) && !installer.includes(`'${base}'`)) {
    write(`The downloaded installer is for a different release than ${version}, so it was not run. ${NOTHING_CHANGED}`);
    return { exitCode: 1 };
  }

  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  for (const setting of INSTALLER_SETTINGS) delete env[setting];
  env.CASPER_BASE_URL = base;
  const run = options.run ?? defaultRunner;
  const temp = await mkdtemp(path.join(os.tmpdir(), "casper-update-"));
  try {
    const file = path.join(temp, script);
    await writeFile(file, installer);
    write(`Updating Casper from ${currentVersion} to ${version}.`);
    if (!windows) {
      const result = await run(["sh", file, "--dir", folder, "--version", version], { env, inherit: true, ...(options.signal ? { signal: options.signal } : {}) });
      return finished(write, result.code === 0, currentVersion, version);
    }
    return await windowsSwap(options, program, version, async () => {
      Object.assign(env, { CASPER_INSTALL_DIR: folder, CASPER_VERSION: version });
      const result = await run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], { env, inherit: true, ...(options.signal ? { signal: options.signal } : {}) });
      return result.code === 0;
    });
  } finally { await rm(temp, { recursive: true, force: true }); }
}

function finished(write: (line: string) => void, ok: boolean, from: string, to: string): { exitCode: number } {
  write(ok ? `Casper is now ${to}.` : `The installer stopped before it finished; Casper ${from} is still installed.`);
  return { exitCode: ok ? 0 : 1 };
}

const exists = (file: string) => stat(file).then(() => true, () => false);

/** Windows will not overwrite a running casper.exe but will rename it. It moves aside to casper.old.exe so the installer
 * can put the new one in place; if the installer does not finish, it is moved back. The old copy goes on the next update. */
async function windowsSwap(options: UpdateOptions, program: string, version: string, install: () => Promise<boolean>): Promise<{ exitCode: number }> {
  const { write, currentVersion } = options;
  const aside = path.join(path.dirname(program), "casper.old.exe");
  await rm(aside, { force: true }).catch(() => undefined);
  try { await rename(program, aside); }
  catch {
    write(`Windows would not let Casper move its own program aside. Close Casper, then run this in PowerShell: irm ${DOWNLOAD}/v${version}/install.ps1 | iex`);
    return { exitCode: 1 };
  }
  let ok = false;
  try { ok = await install() && await exists(program); }
  finally {
    if (!ok && !(await exists(program))) {
      await rename(aside, program).catch(() => {
        write(`Rename casper.old.exe back to casper.exe in ${path.dirname(program)} to use Casper ${currentVersion} again.`);
      });
    }
  }
  return finished(write, ok, currentVersion, version);
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
    // Its own commits: HEAD is not part of what it pulls from (exit 1); git's text covers changes in the way.
    const ownCommits = (await git("merge-base", "--is-ancestor", "HEAD", "@{upstream}")).code === 1;
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
