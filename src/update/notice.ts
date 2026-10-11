import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeGitArgs } from "../platform/git";
import { lastUpdateFailure, updateFailureLines } from "./handoff-log";
import { compareVersions, defaultRunner, gitEnv, lookUpNewest, type Fetcher, type Install, type ProcessRunner } from "./command";

/**
 * The one line at the start of a session that says a newer Casper is out, and the short note at the end of the footer
 * that stays until you update. No model and no tokens.
 * - What they show comes from the last check, saved in ~/.casper/update-check.json, so starting never waits on the network.
 * - A check runs in the background at most once a day: a release binary asks GitHub for the newest release; a source
 *   checkout fetches and counts how far its branch is behind. The next start shows what it found.
 * - Off with `updates: false` in ~/.casper/config.yaml, CASPER_NO_UPDATE_CHECK=1, or in CI.
 */

export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const FILE = "update-check.json";

type Saved =
  | { checkedAt: number; kind: "binary"; version: string }
  | { checkedAt: number; kind: "checkout"; root: string; head: string; behind: number };

export interface NoticeOptions {
  install: Install;
  currentVersion: string;
  /** The folder that holds Casper's state (~/.casper). */
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetcher;
  run?: ProcessRunner;
  now?: () => number;
  signal?: AbortSignal;
}

/** CASPER_NO_UPDATE_CHECK (any value but 0 or empty) or CI turns the check, the line and the footer note off. */
export function updateChecksOff(env: NodeJS.ProcessEnv): boolean {
  const set = (value: string | undefined) => Boolean(value?.trim()) && value!.trim() !== "0" && value!.trim().toLowerCase() !== "false";
  return set(env.CASPER_NO_UPDATE_CHECK) || set(env.CI);
}

async function readSaved(stateDir: string): Promise<Saved | undefined> {
  try {
    const saved = JSON.parse(await readFile(path.join(stateDir, FILE), "utf8")) as Saved;
    return saved && typeof saved.checkedAt === "number" ? saved : undefined;
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

/** What the last check found that is newer than this Casper: a release, or how far a checkout is behind. */
type Newer = { kind: "binary"; version: string } | { kind: "checkout"; behind: number };

async function newerCasper(options: NoticeOptions): Promise<Newer | undefined> {
  const saved = await readSaved(options.stateDir);
  const { install } = options;
  if (install.kind === "binary") {
    return saved?.kind === "binary" && compareVersions(saved.version, options.currentVersion) > 0 ? { kind: "binary", version: saved.version } : undefined;
  }
  if (saved?.kind !== "checkout" || saved.root !== install.root || saved.behind <= 0) return undefined;
  // Counted from the commit it was on then; after a pull (or any other move) the count no longer applies.
  const head = await checkoutGit(options, install.root)("rev-parse", "HEAD");
  return head.code === 0 && head.stdout.trim() === saved.head ? { kind: "checkout", behind: saved.behind } : undefined;
}

/** The line to show now, from the last check; undefined when nothing newer is known. */
export async function updateNotice(options: NoticeOptions): Promise<string | undefined> {
  if (options.install.kind === "binary") {
    const failed = await lastUpdateFailure(options.stateDir, options.currentVersion, options.now?.());
    if (failed) return updateFailureLines(failed).join("\n");
  }
  const newer = await newerCasper(options);
  if (!newer) return undefined;
  if (newer.kind === "binary") return `Casper ${newer.version} is out (you have ${options.currentVersion}). Run casper update to install it.`;
  return `The Casper checkout is ${newer.behind} change${newer.behind === 1 ? "" : "s"} behind. Run casper update to pull ${newer.behind === 1 ? "it" : "them"}.`;
}

/** The short footer note for the same news (`Casper 0.2.33 is out · casper update`); undefined when nothing newer is
 * known. */
export async function updateFooterNote(options: NoticeOptions): Promise<string | undefined> {
  const newer = await newerCasper(options);
  if (!newer) return undefined;
  return newer.kind === "binary" ? `Casper ${newer.version} is out · casper update`
    : `Casper is ${newer.behind} change${newer.behind === 1 ? "" : "s"} behind · casper update`;
}

/** Looks again when the last check is a day old (or for another install), and saves what it found. Never throws. */
export async function refreshUpdateCheck(options: NoticeOptions): Promise<void> {
  try {
    const now = (options.now ?? Date.now)();
    const saved = await readSaved(options.stateDir);
    const { install } = options;
    const sameInstall = saved && (install.kind === "binary" ? saved.kind === "binary" : saved.kind === "checkout" && saved.root === install.root);
    if (sameInstall && now - saved.checkedAt >= 0 && now - saved.checkedAt < CHECK_EVERY_MS) return;
    if (install.kind === "binary") {
      const newest = await lookUpNewest(options.fetch ?? ((url, init) => fetch(url, init)), options.env ?? process.env, options.signal);
      if (typeof newest !== "string") await save(options.stateDir, { checkedAt: now, kind: "binary", version: newest.version });
      return;
    }
    const git = checkoutGit(options, install.root);
    // A branch with nothing to pull from has nothing to report; `casper update` says why when asked.
    if ((await git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")).code !== 0) return;
    if ((await git("fetch", "--quiet")).code !== 0) return;
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    const counted = await git("rev-list", "--count", "HEAD..@{upstream}");
    if (!head || counted.code !== 0) return;
    await save(options.stateDir, { checkedAt: now, kind: "checkout", root: install.root, head, behind: Number(counted.stdout.trim()) || 0 });
  } catch { /* A check that fails is tried again next start. */ }
}
