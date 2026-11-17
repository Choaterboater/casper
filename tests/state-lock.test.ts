import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ProjectMemory } from "../src/memory/store";
import { bootEpoch, hostId, pidAlive, sameBoot, withStateLock, type StateLockOptions } from "../src/platform/state-lock";
import { SessionBranchStore, sessionProjectKey } from "../src/sessions/store";
import { GitWorktreeManager } from "../src/workspace/worktree";
import { cleanEnv } from "./support/env";
import { GONE_PID, heldLock } from "./support/stale-lock";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
async function temp(): Promise<string> { const dir = await mkdtemp(path.join(os.tmpdir(), "casper-state-lock-")); dirs.push(dir); return dir; }

const BOOT = 1_700_000_000;
const OTHER_HOST = "0badc0de";
/** This process is alive; the made-up holder is not. */
const alive = (pid: number) => pid === process.pid;
const options = (over: Partial<StateLockOptions> = {}): StateLockOptions =>
  ({ busy: "State is locked", attempts: 5, waitMs: 1, alive, boot: () => BOOT, ...over });

test("bootEpoch is when the computer started, and boot times a minute apart are the same start", () => {
  expect(bootEpoch(1_700_000_100_400, 100)).toBe(1_700_000_000);
  expect(Math.abs(bootEpoch() - bootEpoch())).toBeLessThanOrEqual(1);
  expect(sameBoot(BOOT, BOOT + 60)).toBe(true);
  expect(sameBoot(BOOT, BOOT - 61)).toBe(false);
});

test("pidAlive: this process is alive; a process that has ended is not", async () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(0)).toBe(false);
  const child = Bun.spawn([process.execPath, "-e", ""], { env: cleanEnv(), stdout: "ignore", stderr: "ignore" });
  await child.exited;
  expect(pidAlive(child.pid)).toBe(false);
});

test("the lock holds an owner file while it runs (0700 folder, 0600 file) and leaves nothing behind", async () => {
  const lock = path.join(await temp(), "facts.lock");
  const seen = await withStateLock(lock, async () => {
    const names = await readdir(lock);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`^owner\\.${process.pid}\\.${BOOT}\\.${hostId()}\\.[0-9a-f]{16}$`));
    if (process.platform !== "win32") {
      expect((await stat(lock)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(lock, names[0]!))).mode & 0o777).toBe(0o600);
    }
    return "ran";
  }, options());
  expect(seen).toBe("ran");
  expect(existsSync(lock)).toBe(false);
});

test("a live owner keeps the lock: the waiter gives up with the caller's words and changes nothing", async () => {
  const lock = path.join(await temp(), "facts.lock");
  const file = await heldLock(lock, { pid: process.pid, boot: BOOT + 30 });
  let ran = false;
  await expect(withStateLock(lock, async () => { ran = true; }, options())).rejects.toThrow("State is locked");
  expect(ran).toBe(false);
  expect(existsSync(file)).toBe(true);
});

test("an owner whose pid is gone is taken over once its file is 2 s old, not before", async () => {
  const root = await temp();
  const fresh = path.join(root, "fresh.lock");
  await heldLock(fresh, { pid: GONE_PID, boot: BOOT }, 0);
  await expect(withStateLock(fresh, async () => {}, options())).rejects.toThrow("State is locked");
  const old = path.join(root, "old.lock");
  const file = await heldLock(old, { pid: GONE_PID, boot: BOOT }, 3_000);
  expect(await withStateLock(old, async () => existsSync(file), options())).toBe(false);
  expect(existsSync(old)).toBe(false);
});

test("an owner from before the computer restarted is taken over even when its pid is in use again", async () => {
  const lock = path.join(await temp(), "facts.lock");
  await heldLock(lock, { pid: process.pid, boot: BOOT - 3_600 }, 0);
  let ran = false;
  await withStateLock(lock, async () => { ran = true; }, options());
  expect(ran).toBe(true);
});

test("an owner on another computer sharing this home is judged by age alone: not by its boot or pid, and taken over after 5 minutes", async () => {
  const root = await temp();
  expect(hostId("one")).toMatch(/^[0-9a-f]{8}$/);
  expect(hostId("one")).not.toBe(hostId("two"));
  // Another boot and a pid gone here: on its own computer it may well be running.
  const recent = path.join(root, "recent.lock");
  const file = await heldLock(recent, { pid: GONE_PID, boot: BOOT - 3_600, host: OTHER_HOST }, 60_000);
  await expect(withStateLock(recent, async () => {}, options())).rejects.toThrow("State is locked");
  expect(existsSync(file)).toBe(true);
  const left = path.join(root, "left.lock");
  await heldLock(left, { pid: process.pid, boot: BOOT, host: OTHER_HOST }, 6 * 60_000);
  let ran = false;
  await withStateLock(left, async () => { ran = true; }, options());
  expect(ran).toBe(true);
});

test("a lock folder with no owner file (an older Casper's) is taken over after 5 minutes, not before", async () => {
  const lock = path.join(await temp(), "facts.lock");
  await mkdir(lock, { mode: 0o700 });
  await expect(withStateLock(lock, async () => {}, options())).rejects.toThrow("State is locked");
  const then = new Date(Date.now() - 6 * 60_000);
  await utimes(lock, then, then);
  let ran = false;
  await withStateLock(lock, async () => { ran = true; }, options());
  expect(ran).toBe(true);
});

/** Counts how many callers are inside at once. */
function section() {
  let inside = 0, most = 0, runs = 0;
  return {
    async run(body: () => Promise<void> = async () => {}) { inside++; most = Math.max(most, inside); runs++; try { await body(); } finally { inside--; } },
    get most() { return most; },
    get runs() { return runs; },
  };
}

test("two waiters that both find the same stale lock: one takes it over, the other waits its turn", async () => {
  const lock = path.join(await temp(), "facts.lock");
  await heldLock(lock, { pid: GONE_PID, boot: BOOT });
  let arrived = 0, open!: () => void;
  const both = new Promise<void>((resolve) => { open = resolve; });
  // Neither takes over until both have judged the lock stale.
  const beforeTakeover = async () => { if (++arrived === 2) open(); await both; };
  const counted = section();
  await Promise.all([1, 2].map(() => withStateLock(lock, () => counted.run(() => Bun.sleep(5)), options({ attempts: 200, beforeTakeover }))));
  expect(arrived).toBeGreaterThanOrEqual(2);
  expect(counted.runs).toBe(2);
  expect(counted.most).toBe(1);
  expect(existsSync(lock)).toBe(false);
});

test("a waiter that judged a lock stale and acts late never takes the new holder's lock", async () => {
  const lock = path.join(await temp(), "facts.lock");
  await heldLock(lock, { pid: GONE_PID, boot: BOOT });
  let bJudged!: () => void, aHolds!: () => void, aDone!: () => void;
  const judged = new Promise<void>((resolve) => { bJudged = resolve; });
  const holding = new Promise<void>((resolve) => { aHolds = resolve; });
  const finish = new Promise<void>((resolve) => { aDone = resolve; });
  const counted = section();
  let bInsideWhileA = false, aInside = false;
  const a = withStateLock(lock, () => counted.run(async () => { aInside = true; aHolds(); await finish; aInside = false; }),
    options({ attempts: 2_000, beforeTakeover: () => judged }));
  // B judges the old owner stale, then acts only once A holds the lock again.
  const b = withStateLock(lock, () => counted.run(async () => { bInsideWhileA = aInside; }),
    options({ attempts: 2_000, beforeTakeover: async () => { bJudged(); await holding; } }));
  await holding;
  await Bun.sleep(50);
  const owners = await readdir(lock);
  expect(owners).toHaveLength(1);
  expect(owners[0]).toStartWith(`owner.${process.pid}.`);
  aDone();
  await Promise.all([a, b]);
  expect(bInsideWhileA).toBe(false);
  expect(counted.runs).toBe(2);
  expect(counted.most).toBe(1);
});

test("memory: a lock left by a killed Casper no longer blocks every later update", async () => {
  const state = path.join(await temp(), "state");
  await mkdir(state, { recursive: true });
  const stale = path.join(state, "memory.jsonl.lock");
  await heldLock(stale, { pid: GONE_PID, boot: bootEpoch() - 7_200 });
  const memory = new ProjectMemory(state);
  await memory.remember("the build runs on bun");
  expect((await memory.facts()).map((fact) => fact.text)).toEqual(["the build runs on bun"]);
  expect(existsSync(stale)).toBe(false);
});

test("saved session branches: a lock left by a killed Casper no longer blocks saving one", async () => {
  const root = await temp();
  const project = path.join(root, "project");
  await mkdir(project);
  const store = await SessionBranchStore.open({ projectKey: sessionProjectKey(project), primaryWorkspace: project, homeDir: root });
  await mkdir(path.dirname(store.filePath), { recursive: true, mode: 0o700 });
  const stale = `${store.filePath}.lock`;
  await heldLock(stale, { pid: GONE_PID, boot: bootEpoch() });
  await store.upsert({ name: "probe", parent: "main", sessionId: "session-probe", sessionFile: path.join(root, "probe.jsonl"),
    workspacePath: project, gitBranch: null, status: "open", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
  const reopened = await SessionBranchStore.open({ projectKey: sessionProjectKey(project), primaryWorkspace: project, homeDir: root });
  expect(reopened.list().map((branch) => branch.name)).toEqual(["probe"]);
  expect(existsSync(stale)).toBe(false);
});

test("worktree creation: a lock from before the computer restarted no longer blocks making the copy", async () => {
  const root = await realpath(await temp());
  const repo = path.join(root, "repo"), home = path.join(root, "home");
  await mkdir(repo); await mkdir(home);
  const env = cleanEnv({ GIT_AUTHOR_NAME: "Casper Test", GIT_AUTHOR_EMAIL: "casper@example.invalid",
    GIT_COMMITTER_NAME: "Casper Test", GIT_COMMITTER_EMAIL: "casper@example.invalid" });
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: repo, env });
  await git("init", "-b", "main");
  await writeFile(path.join(repo, "a.txt"), "base\n");
  await git("add", "a.txt");
  await git("commit", "-m", "base");
  const manager = (await GitWorktreeManager.open(repo, home))!;
  const plan = await manager.plan("probe", repo);
  await mkdir(path.dirname(plan.path), { recursive: true, mode: 0o700 });
  const stale = `${plan.path}.create-lock`;
  await heldLock(stale, { pid: process.pid, boot: bootEpoch() - 7_200 }, 0);
  const made = await manager.create(plan);
  expect(made.path).toBe(plan.path);
  expect(existsSync(path.join(plan.path, "a.txt"))).toBe(true);
  expect(existsSync(stale)).toBe(false);
});
