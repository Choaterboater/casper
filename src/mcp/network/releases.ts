import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { LockedSpec } from "../../security/tools";
import { NETWORK_SERVER } from "./server";

/**
 * Network server releases between Casper releases. At most once a day (and only for someone who has Casper's own
 * network entry) Casper asks GitHub's releases API, with no login, which casper-network-mcp releases exist and saves
 * the answer in ~/.casper/network-releases.json; offers read only that file, so starting never waits on GitHub.
 * Installing a release fetches the hash lock attached to it and checks it (checkLock) before uv installs from it
 * with --require-hashes, exactly as the lock bundled with Casper is installed. The bundled pin stays the floor: a
 * release is used only when it is newer, and a lock that can't be fetched or fails the check means the bundled one.
 * Off with CASPER_OFFLINE=1, `tools: { downloads: off }` or `network_updates: off`.
 */

export const NETWORK_REPO = "Choaterboater/casper-network-mcp";
export const NETWORK_RELEASES_API = `https://api.github.com/repos/${NETWORK_REPO}/releases?per_page=20`;
export const NETWORK_RELEASE_DOWNLOADS = `https://github.com/${NETWORK_REPO}/releases/download`;
/** Where the check and a release's lock come from: the API, then github.com, which redirects the download to
 * GitHub's file hosts. The packages themselves still come from pypi.org (NETWORK_SERVER.hosts). */
export const NETWORK_RELEASE_HOSTS = ["api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];
export const LOCK_ASSET = "casper-network-mcp.lock.txt";
export const RELEASE_CHECK_FILE = path.join(".casper", "network-releases.json");
export const RELEASE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;
const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_LOCK_BYTES = 1024 * 1024;

/** The fetch used when no seam is passed (the test suite replaces it, so no test reaches GitHub). */
export const networkReleaseDefaults: { fetch: (url: string, init?: RequestInit) => Promise<Response> } = { fetch: (url, init) => fetch(url, init) };

/** What decides whether Casper looks at releases at all, and the test seams. */
export interface NetworkReleaseOptions {
  /** Why releases are not looked at or used (CASPER_OFFLINE=1, tools.downloads: off, network_updates: off). */
  off?: string;
  apiUrl?: string;
  downloadsUrl?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  signal?: AbortSignal;
}

/** Why Casper doesn't look for network server releases, or undefined when it does. Settings that didn't load (a file
 * with a mistake) count as off, so your own off switch is never skipped. */
export function networkReleasesOff(env: NodeJS.ProcessEnv, settings: { networkUpdates?: boolean; toolDownloads?: boolean } | undefined): string | undefined {
  if (env.CASPER_OFFLINE === "1") return "CASPER_OFFLINE=1";
  if (!settings) return "settings didn't load";
  if (settings.toolDownloads === false) return "tools: { downloads: off }";
  if (settings.networkUpdates === false) return "network_updates: off";
  return undefined;
}

/** A release version Casper accepts: digits and dots only, so it is safe in a URL, a path and a command. */
export function validReleaseVersion(version: unknown): version is string {
  return typeof version === "string" && version.length <= 32 && /^\d{1,6}(?:\.\d{1,6}){1,3}$/.test(version);
}

/** -1, 0 or 1 for dotted versions (both already valid). */
export function compareReleaseVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * A release's lock is installable: it pins casper-network-mcp==<version> by sha256, every other line is a pinned
 * requirement, a hash or a comment, and nothing points at a local folder, another index or another file.
 */
export function checkLock(lock: string, version: string): void {
  const escaped = version.replace(/\./g, "\\.");
  if (!new RegExp(`^casper-network-mcp==${escaped} .*--hash=sha256:[0-9a-f]{64}`, "m").test(lock)) throw new Error(`the lock has no hashed casper-network-mcp==${version} line`);
  const lines = lock.split("\n").map((line) => line.trim());
  if (lines.some((line) => /^(-e\s|\.\s*$|\.\/)/.test(line))) throw new Error("the lock has a local project line");
  if (lines.some((line) => line.startsWith("-") && !/^--hash=sha256:[0-9a-f]{64}(?:\s*\\)?$/.test(line))) throw new Error("the lock has an option line (another index, file or folder)");
  if (lines.some((line) => line && !line.startsWith("#") && !line.startsWith("-") && !/^[A-Za-z0-9][A-Za-z0-9._-]*==[A-Za-z0-9.+!_-]+(?:\s*;[^@]*)?(?:\s+--hash=sha256:[0-9a-f]{64})*\s*\\?$/.test(line))) {
    throw new Error("the lock has a requirement that isn't pinned to one version");
  }
}

interface KnownRelease { version: string; prerelease: boolean }
interface SavedCheck { checkedAt: number; releases: KnownRelease[] }

async function readSaved(homeDir: string): Promise<SavedCheck | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(homeDir, RELEASE_CHECK_FILE), "utf8")) as Partial<SavedCheck>;
    if (typeof parsed?.checkedAt !== "number" || !Array.isArray(parsed.releases)) return undefined;
    // Read again as untrusted: only valid versions count.
    const releases = parsed.releases.filter((release): release is KnownRelease => validReleaseVersion(release?.version) && typeof release.prerelease === "boolean");
    return { checkedAt: parsed.checkedAt, releases };
  } catch {
    return undefined;
  }
}

async function save(homeDir: string, saved: SavedCheck): Promise<void> {
  const file = path.join(homeDir, RELEASE_CHECK_FILE);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(saved)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function capped(response: Response, max: number): Promise<string> {
  if (Number(response.headers.get("content-length") ?? "0") > max) throw new Error("the answer is larger than expected");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > max) throw new Error("the answer is larger than expected");
  return new TextDecoder().decode(bytes);
}

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

/** The releases in a releases-API answer that Casper could install: not a draft, a v<digits.dots> tag, the lock attached. */
export function installableReleases(body: unknown): KnownRelease[] {
  if (!Array.isArray(body)) return [];
  const found: KnownRelease[] = [];
  for (const item of body.slice(0, 100)) {
    if (!item || typeof item !== "object" || item.draft === true) continue;
    const tag = typeof item.tag_name === "string" ? item.tag_name : "";
    const version = tag.startsWith("v") ? tag.slice(1) : "";
    if (!validReleaseVersion(version)) continue;
    const assets = Array.isArray(item.assets) ? item.assets : [];
    if (!assets.some((asset: unknown) => (asset as { name?: unknown } | null)?.name === LOCK_ASSET)) continue;
    found.push({ version, prerelease: item.prerelease === true });
  }
  return found;
}

/**
 * Asks GitHub again when the last check is a day old, and saves what it found. A failed check keeps the releases
 * already known and waits a day too. Never throws; nothing at all when releases are off.
 */
export async function refreshNetworkReleases(homeDir: string, options: NetworkReleaseOptions = {}): Promise<void> {
  if (options.off) return;
  try {
    const now = (options.now ?? Date.now)();
    const saved = await readSaved(homeDir);
    if (saved && now - saved.checkedAt >= 0 && now - saved.checkedAt < RELEASE_CHECK_EVERY_MS) return;
    let releases = saved?.releases ?? [];
    try {
      const response = await (options.fetch ?? networkReleaseDefaults.fetch)(options.apiUrl ?? NETWORK_RELEASES_API, {
        headers: { accept: "application/vnd.github+json", "user-agent": "casper" }, redirect: "error", signal: withTimeout(CHECK_TIMEOUT_MS, options.signal),
      });
      if (response.ok) releases = installableReleases(JSON.parse(await capped(response, MAX_API_BYTES)));
    } catch { /* No answer: try again tomorrow. */ }
    if (options.signal?.aborted) return;
    await save(homeDir, { checkedAt: now, releases });
  } catch { /* A check that fails is tried again later. */ }
}

/**
 * The newest release Casper knows of (from the last check) that is newer than both `installed` and the bundled pin.
 * A pre-release counts only when the installed version is itself a known pre-release. Undefined when off.
 */
export async function newerNetworkRelease(homeDir: string, installed: string | undefined, options: NetworkReleaseOptions = {}): Promise<string | undefined> {
  if (options.off) return undefined;
  const saved = await readSaved(homeDir);
  if (!saved) return undefined;
  const onPrerelease = installed !== undefined && saved.releases.some((release) => release.version === installed && release.prerelease);
  let newest: string | undefined;
  for (const release of saved.releases) {
    if (release.prerelease && !onPrerelease) continue;
    if (compareReleaseVersions(release.version, NETWORK_SERVER.version) <= 0) continue;
    if (installed && validReleaseVersion(installed) && compareReleaseVersions(release.version, installed) <= 0) continue;
    if (!newest || compareReleaseVersions(release.version, newest) > 0) newest = release.version;
  }
  return newest;
}

/** Fetches a release's lock from that release on GitHub and checks it. Never throws. */
export async function fetchReleaseLock(version: string, options: NetworkReleaseOptions = {}): Promise<{ ok: true; lock: string } | { ok: false; reason: string; failedCheck?: true }> {
  if (!validReleaseVersion(version)) return { ok: false, reason: "its version isn't digits and dots" };
  let lock: string;
  try {
    const response = await (options.fetch ?? networkReleaseDefaults.fetch)(`${options.downloadsUrl ?? NETWORK_RELEASE_DOWNLOADS}/v${version}/${LOCK_ASSET}`, {
      headers: { "user-agent": "casper" }, redirect: "follow", signal: withTimeout(LOCK_TIMEOUT_MS, options.signal),
    });
    if (!response.ok) return { ok: false, reason: `its lock couldn't be downloaded (HTTP ${response.status})` };
    lock = await capped(response, MAX_LOCK_BYTES);
  } catch (error) {
    return { ok: false, reason: `its lock couldn't be downloaded (${error instanceof Error ? error.message : String(error)})` };
  }
  try { checkLock(lock, version); }
  catch (error) { return { ok: false, reason: `its lock failed Casper's check: ${error instanceof Error ? error.message : String(error)}`, failedCheck: true }; }
  return { ok: true, lock };
}

/** The network server spec for a checked release lock: the bundled spec with that version and lock. */
export function releaseSpec(version: string, lock: string): LockedSpec {
  return { ...NETWORK_SERVER, version, source: { ...NETWORK_SERVER.source, lock } };
}
