import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeGitArgs } from "../platform/git";
import { lastUpdateFailure, startUpdateLog, updateFailureLines, updateLogPath } from "./handoff-log";
import { compareVersions, defaultRunner, gitEnv, lookUpNewest, runUpdate, type CheckoutHold, type UpdateOptions } from "./command";
import type { UpdatesSetting } from "../config/load";

/** Checks and installs share the daily cache across sessions. Nothing at startup waits on the network. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const INSTALLED_NOTE = "✔ Update installed · restart to use it";
export const FAILED_NOTE = "update failed · casper update";
const FILE = "update-check.json";

/** Why the last background attempt left a checkout alone, in the few words the notice row has room for. */
const HELD = new Map<CheckoutHold, string>([
  ["default", "default branch unknown"],
  ["branch", "checkout on another branch"],
  ["upstream", "checkout tracks another upstream"],
  ["commits", "checkout has local commits"],
  ["changes", "checkout has uncommitted changes"],
]);

/** `held` is a checkout's: it stays with that HEAD until the next background attempt. */
type Saved = ({ checkedAt: number; attemptedAt?: number; outcome?: "installed" | "failed"; held?: CheckoutHold } & (
  | { kind: "binary"; version: string }
  | { kind: "checkout"; root: string; head: string; behind: number }
));

export interface NoticeOptions extends Omit<UpdateOptions, "check" | "write" | "stateDir" | "background"> {
  /** The folder that holds Casper's state (~/.casper). */
  stateDir: string;
  now?: () => number;
  /** Session start, so a manual update in another terminal can light the live notice, not the next checkout start. */
  startedAt?: number;
}

/** CASPER_NO_UPDATE_CHECK (any value but 0, false or empty) or CI turns all update activity off. */
export function updateChecksOff(env: NodeJS.ProcessEnv): boolean {
  const set = (value: string | undefined) => Boolean(value?.trim()) && value!.trim() !== "0" && value!.trim().toLowerCase() !== "false";
  return set(env.CASPER_NO_UPDATE_CHECK) || set(env.CI);
}

async function readSaved(stateDir: string): Promise<Saved | undefined> {
  try {
    const saved = JSON.parse(await readFile(path.join(stateDir, FILE), "utf8")) as Saved;
    return saved && Number.isFinite(saved.checkedAt) ? saved : undefined;
  } catch { return undefined; }
}

async function save(stateDir: string, saved: Saved): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const file = path.join(stateDir, FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function checkoutGit(options: NoticeOptions, root: string) {
  const run = options.run ?? defaultRunner;
  const env = gitEnv(options.env ?? process.env);
  return (...args: string[]) => run(["git", ...safeGitArgs(args)], { cwd: root, env, timeoutMs: 60_000, ...(options.signal ? { signal: options.signal } : {}) });
}

function sameInstall(saved: Saved | undefined, options: NoticeOptions): saved is Saved {
  return Boolean(saved && (options.install.kind === "binary" ? saved.kind === "binary" : saved.kind === "checkout" && saved.root === options.install.root));
}

async function applicable(options: NoticeOptions): Promise<Saved | undefined> {
  const saved = await readSaved(options.stateDir);
  if (!sameInstall(saved, options)) return undefined;
  if (saved.kind === "binary") return compareVersions(saved.version, options.currentVersion) > 0 || (saved.outcome === "failed" && saved.version === options.currentVersion) ? saved : undefined;
  const head = await checkoutGit(options, saved.root)("rev-parse", "HEAD");
  return head.code === 0 && head.stdout.trim() === saved.head ? saved : undefined;
}

/** Startup explanation, including the Windows handoff's diagnostic from the previous run. */
export async function updateNotice(options: NoticeOptions): Promise<string | undefined> {
  if (updateChecksOff(options.env ?? process.env)) return undefined;
  if (options.install.kind === "binary") {
    const failed = await lastUpdateFailure(options.stateDir, options.currentVersion, options.now?.());
    if (failed) return updateFailureLines(failed).join("\n");
  }
  const saved = await applicable(options);
  if (!saved) return undefined;
  if (saved.outcome === "failed") return FAILED_NOTE;
  if (saved.outcome === "installed") return INSTALLED_NOTE;
  if (saved.kind === "binary") return `Casper ${saved.version} is out (you have ${options.currentVersion}). Run casper update to install it.`;
  return saved.behind > 0 ? `The Casper checkout is ${saved.behind} change${saved.behind === 1 ? "" : "s"} behind. Run casper update to pull ${saved.behind === 1 ? "it" : "them"}.` : undefined;
}

async function installedDuringSession(options: NoticeOptions): Promise<boolean> {
  if (options.startedAt === undefined) return false;
  try {
    const marker = JSON.parse(await readFile(path.join(options.stateDir, "update-installed.json"), "utf8"));
    return marker.installedAt >= options.startedAt && marker.from === options.currentVersion
      && JSON.stringify(marker.install) === JSON.stringify(options.install);
  } catch { return false; }
}

/** The same news in the live notice row. */
export async function updateFooterNote(options: NoticeOptions): Promise<string | undefined> {
  if (updateChecksOff(options.env ?? process.env)) return undefined;
  if (options.install.kind === "binary" && await lastUpdateFailure(options.stateDir, options.currentVersion, options.now?.())) return FAILED_NOTE;
  const saved = await applicable(options);
  if (saved?.outcome === "failed") return FAILED_NOTE;
  if (await installedDuringSession(options)) return INSTALLED_NOTE;
  if (!saved) return undefined;
  if (saved.outcome === "installed") return INSTALLED_NOTE;
  if (saved.kind === "binary") return `Casper ${saved.version} is out · casper update`;
  if (saved.behind <= 0) return undefined;
  const why = saved.held && HELD.get(saved.held);
  return `Casper update ready · ${why ? `${why} · ` : ""}casper update`;
}

/** Refresh the shared daily cache. The one early-session probe may look once more after a few minutes. */
export async function refreshUpdateCheck(options: NoticeOptions, early = false): Promise<{ error?: string }> {
  if (updateChecksOff(options.env ?? process.env) || options.signal?.aborted) return {};
  try {
    const now = (options.now ?? Date.now)();
    const saved = await readSaved(options.stateDir);
    if (!early && sameInstall(saved, options) && now - saved.checkedAt >= 0 && now - saved.checkedAt < CHECK_EVERY_MS) return {};
    const retained = sameInstall(saved, options) && saved.attemptedAt !== undefined ? { attemptedAt: saved.attemptedAt } : {};
    if (options.install.kind === "binary") {
      const newest = await lookUpNewest(options.fetch ?? ((url, init) => fetch(url, init)), options.env ?? process.env, options.signal);
      if (typeof newest === "string") return { error: newest };
      await save(options.stateDir, { checkedAt: now, kind: "binary", version: newest.version, ...retained,
        ...(saved?.kind === "binary" && saved.version === newest.version && compareVersions(newest.version, options.currentVersion) > 0 && saved.outcome ? { outcome: saved.outcome } : {}) });
      return {};
    }
    const git = checkoutGit(options, options.install.root);
    if ((await git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")).code !== 0) return {};
    if ((await git("fetch", "--quiet")).code !== 0) return { error: "Could not fetch the Casper checkout." };
    const head = await git("rev-parse", "HEAD");
    const counted = await git("rev-list", "--count", "HEAD..@{upstream}");
    if (head.code !== 0 || !head.stdout.trim() || counted.code !== 0) return { error: "Could not check the Casper checkout." };
    const same = saved?.kind === "checkout" && saved.root === options.install.root && saved.head === head.stdout.trim();
    await save(options.stateDir, { checkedAt: now, kind: "checkout", root: options.install.root, head: head.stdout.trim(), behind: Number(counted.stdout.trim()) || 0, ...retained,
      ...(same && saved.outcome === "failed" ? { outcome: "failed" as const } : {}), ...(same && saved.held ? { held: saved.held } : {}) });
    return {};
  } catch { return { error: "The background update check could not finish." }; }
}

/** No terminal output, and exactly the manual updater's verification/install path. The caller reserves idle time
 * until this promise settles; canInstall is checked again after network I/O. A private lock excludes other sessions. */
export async function backgroundUpdate(options: NoticeOptions, settings: {
  mode: UpdatesSetting;
  canInstall: () => boolean;
  early?: boolean;
}): Promise<string | undefined> {
  if (settings.mode === "off" || updateChecksOff(options.env ?? process.env) || options.signal?.aborted) return undefined;
  await mkdir(options.stateDir, { recursive: true });
  const lock = path.join(options.stateDir, "update.lock");
  const acquiring = path.join(options.stateDir, "update-acquire.lock");
  const owner = `${process.pid}:${randomUUID()}`;
  // Serialize acquisition AND stale reclamation. A second reaper cannot delete a newly acquired live lock.
  // If this tiny critical section is interrupted, leave it closed rather than risk overlapping installs.
  try { await mkdir(acquiring); } catch { return updateFooterNote(options); }
  try {
    try {
      if (Date.now() - (await stat(lock)).mtimeMs > 15 * 60_000) {
        const pid = Number((await readFile(path.join(lock, "owner"), "utf8").catch(() => "0")).split(":")[0]);
        let alive = false;
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); alive = true; } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
        }
        if (!alive) await rm(lock, { recursive: true, force: true });
      }
    } catch { /* no lock */ }
    try { await mkdir(lock); } catch { return updateFooterNote(options); }
    await writeFile(path.join(lock, "owner"), owner, { mode: 0o600 });
  } finally { await rm(acquiring, { recursive: true, force: true }).catch(() => {}); }
  const now = (options.now ?? Date.now)();
  const logFailure = async (lines: string[], target: string) => {
    await startUpdateLog(options.stateDir, options.currentVersion, target);
    // Only updater-controlled messages: subprocess output and environment can contain credentials.
    await appendFile(updateLogPath(options.stateDir), `${lines.join("\n")}\nresult: failed: background update did not finish\n`, { mode: 0o600 }).catch(() => {});
  };
  try {
    const before = await readSaved(options.stateDir);
    const checked = await refreshUpdateCheck(options, settings.early);
    if (options.signal?.aborted) return undefined;
    if (checked.error) {
      await logFailure([checked.error], options.currentVersion);
      const failure: Saved = options.install.kind === "binary"
        ? { kind: "binary", version: options.currentVersion, checkedAt: now, outcome: "failed" }
        : { kind: "checkout", root: options.install.root, head: (await checkoutGit(options, options.install.root)("rev-parse", "HEAD")).stdout.trim(), behind: 0, checkedAt: now, outcome: "failed" };
      await save(options.stateDir, { ...failure, ...(sameInstall(before, options) && before.attemptedAt !== undefined ? { attemptedAt: before.attemptedAt } : {}) });
      return FAILED_NOTE;
    }
    if (await installedDuringSession(options)) return updateFooterNote(options);
    const saved = await applicable(options);
    if (!saved || (saved.kind === "checkout" && saved.behind <= 0)) return updateFooterNote(options);
    if (saved.outcome === "failed" && saved.kind === "binary" && saved.version === options.currentVersion) return FAILED_NOTE;
    if (settings.mode !== "auto" || !settings.canInstall()) return updateFooterNote(options);
    if (saved.outcome === "installed" || (sameInstall(before, options) && before.attemptedAt !== undefined && now - before.attemptedAt < CHECK_EVERY_MS)) return updateFooterNote(options);
    // Persist before starting: crashes and another session cannot cause repeated installs today. Each attempt finds its own reason.
    const attempt: Saved = { ...saved, attemptedAt: now, held: undefined };
    await save(options.stateDir, attempt);
    const result = await runUpdate({ ...options, check: false, background: true, write: () => {} });
    if (result.deferred) {
      if (result.held) await save(options.stateDir, { ...attempt, held: result.held });
      return updateFooterNote(options);
    }
    if (result.exitCode !== 0) {
      await logFailure(["The verified updater failed. Run casper update to see its diagnostics."], saved.kind === "binary" ? saved.version : options.currentVersion);
      const head = saved.kind === "checkout" ? (await checkoutGit(options, saved.root)("rev-parse", "HEAD")).stdout.trim() : undefined;
      await save(options.stateDir, { ...attempt, ...(saved.kind === "checkout" && head ? { head } : {}), outcome: "failed" });
      return FAILED_NOTE;
    }
    if (result.updated) {
      // Checkout HEAD changed: its cached notice becomes inapplicable on the next start, even without a version bump.
      await save(options.stateDir, { ...attempt, outcome: "installed" });
      return INSTALLED_NOTE;
    }
    return updateFooterNote(options);
  } catch {
    await logFailure(["The background updater could not finish. Run casper update to retry."], options.currentVersion).catch(() => {});
    return FAILED_NOTE;
  } finally {
    if (await readFile(path.join(lock, "owner"), "utf8").catch(() => "") === owner) await rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}
