import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { freePort, portInUse } from "../src/platform/managed-process";
import { OwnedProcesses, osSupportsProcessGroups, ProcessCleanupError, type ProcessPlatform } from "../src/platform/processes";
import type { ServiceSpec } from "../src/services/config";
import { ServiceManager } from "../src/services/manager";
import { removeTempDir } from "./support/temp-dir";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const SERVER = path.join(import.meta.dir, "fixtures", "service-server.ts");
const COMMAND = `"${process.execPath}" "${SERVER}"`;

async function until(condition: () => boolean | Promise<boolean>, deadline = 5000): Promise<void> {
  const limit = performance.now() + deadline;
  while (performance.now() < limit) { if (await condition()) return; await Bun.sleep(20); }
  throw new Error("Condition was not reached before its deadline");
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = (pid: number) => until(() => !alive(pid));

async function project() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-services-")));
  cleanups.push(() => removeTempDir(root));
  return root;
}

async function fixture(spec: Partial<ServiceSpec> = {}, options: { root?: string; platform?: ProcessPlatform } = {}) {
  const root = options.root ?? await project();
  const marker = path.join(root, `grandchild-${Math.random().toString(36).slice(2)}.pid`);
  const manager = new ServiceManager({ projectRoot: root, platform: options.platform, services: {
    api: { command: COMMAND, port: "auto", ready: { http: "/health" }, timeoutMs: 10_000, ...spec, env: { SPAWN_CHILD: marker, ...spec.env } },
  } });
  cleanups.push(() => manager.close().catch(() => {}));
  const grandchild = async () => { await until(async () => (await readFile(marker, "utf8").catch(() => "")).length > 0); return Number(await readFile(marker, "utf8")); };
  return { root, manager, grandchild };
}

const api = (manager: ServiceManager) => manager.status().find(service => service.name === "api")!;

test("a declared service starts on a loopback port, is ready, and leaves no process after stop", async () => {
  const f = await fixture();
  expect(api(f.manager)).toMatchObject({ name: "api", state: "idle" });
  const started = await f.manager.start("api", new AbortController().signal);
  expect(started).toMatchObject({ name: "api", state: "ready" });
  expect(started.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(f.manager.origin("api")).toBe(started.origin!);
  expect(await (await fetch(`${started.origin}/health`)).json()).toEqual({ ok: true });
  const root = started.pid!, grandchild = await f.grandchild();
  await f.manager.stop("api");
  expect(api(f.manager).state).toBe("stopped");
  await gone(root); await gone(grandchild);
  expect(await portInUse("127.0.0.1", Number(new URL(started.origin!).port))).toBe(false);
}, 20_000);

test("PORT, HOST and literal env values reach the service, and a log line can mark it ready", async () => {
  const f = await fixture({ ready: { log: "custom ready" }, env: { READY_LOG: "custom ready" } });
  const started = await f.manager.start("api", new AbortController().signal);
  expect(started.state).toBe("ready");
  expect((await fetch(`${started.origin}/`)).status).toBe(200);
}, 20_000);

test("two managers of the same project with port: auto get distinct ports", async () => {
  const root = await project();
  const [first, second] = [await fixture({}, { root }), await fixture({}, { root })];
  const [a, b] = [await first.manager.start("api", new AbortController().signal), await second.manager.start("api", new AbortController().signal)];
  expect(a.origin).not.toBe(b.origin);
  for (const origin of [a.origin, b.origin]) expect((await fetch(`${origin}/health`)).status).toBe(200);
}, 20_000);

test("a fixed port held by another process is refused with guidance and the holder keeps answering", async () => {
  const port = await freePort();
  const holder = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("someone else") });
  cleanups.push(() => holder.stop(true));
  const f = await fixture({ port });
  const failure = await f.manager.start("api", new AbortController().signal).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(`Port ${port} is in use by a process Casper didn't start`);
  expect((failure as Error).message).toContain("port: auto");
  expect(api(f.manager).state).toBe("failed");
  expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("someone else");
}, 20_000);

test("a fixed free port is used as declared", async () => {
  const port = await freePort();
  const f = await fixture({ port });
  expect((await f.manager.start("api", new AbortController().signal)).origin).toBe(`http://127.0.0.1:${port}`);
}, 20_000);

test("a crash after ready is reported with its exit code and log tail, and its children are cleaned up", async () => {
  const f = await fixture({ env: { CRASH_AFTER_MS: "700" } });
  const started = await f.manager.start("api", new AbortController().signal);
  const grandchild = await f.grandchild();
  await until(() => api(f.manager).state === "crashed");
  expect(api(f.manager)).toMatchObject({ state: "crashed", exit: { code: 3 }, tail: expect.stringContaining("fatal: synthetic crash") });
  await gone(started.pid!); await gone(grandchild);
  // A crashed service is restarted by the next freshness check.
  expect(await f.manager.ensureFresh("api", new AbortController().signal)).toEqual({ restarted: true });
  expect(api(f.manager).state).toBe("ready");
}, 20_000);

test("an edit inside a service's scope makes the next freshness check restart it; one outside does not", async () => {
  const root = await project();
  // Existing directories: an exclusion or outside path is proven only against known spelling.
  await mkdir(path.join(root, "src", "ui"), { recursive: true }); await mkdir(path.join(root, "docs"));
  const f = await fixture({ scope: { inputs: ["src"], exclude: ["src/ui"] } }, { root });
  const first = await f.manager.start("api", new AbortController().signal);
  const signal = new AbortController().signal;
  expect(await f.manager.ensureFresh("api", signal)).toEqual({ restarted: false });
  f.manager.markEdited(path.join(f.root, "docs", "notes.md"));
  f.manager.markEdited("src/ui/view.ts");
  expect(api(f.manager).stale).toBe(false);
  expect(await f.manager.ensureFresh("api", signal)).toEqual({ restarted: false });
  expect(api(f.manager).pid).toBe(first.pid);
  f.manager.markEdited(path.join(f.root, "src", "routes.ts"));
  expect(api(f.manager).stale).toBe(true);
  expect(await f.manager.ensureFresh("api", signal)).toEqual({ restarted: true });
  const second = api(f.manager);
  expect(second).toMatchObject({ state: "ready", stale: false });
  expect(second.pid).not.toBe(first.pid);
  expect(second.origin).toBe(first.origin);
  await gone(first.pid!);
  // A shell command's files are unknown, so it marks every service stale.
  f.manager.markEdited();
  expect(await f.manager.ensureFresh("api", signal)).toEqual({ restarted: true });
  expect(api(f.manager).pid).not.toBe(second.pid);
}, 30_000);

test("without a scope any edit marks the service stale", async () => {
  const f = await fixture();
  await f.manager.start("api", new AbortController().signal);
  f.manager.markEdited("README.md");
  expect(api(f.manager).stale).toBe(true);
}, 20_000);

test("an abort during startup leaves no process", async () => {
  const f = await fixture({ env: { SLOW_READY_MS: "60000" } });
  const controller = new AbortController();
  const work = f.manager.start("api", controller.signal).catch((error: unknown) => error);
  const grandchild = await f.grandchild();
  await until(() => api(f.manager).pid !== undefined);
  const root = api(f.manager).pid!;
  controller.abort();
  expect(await work).toBeInstanceOf(Error);
  expect(api(f.manager).state).toBe("stopped");
  await gone(root); await gone(grandchild);
}, 20_000);

test("a startup that misses its deadline fails with the log tail", async () => {
  // The deadline has to outlast the fixture's start, or there is no "booting" line yet: a fresh Bun process
  // took past 1 s in a full parallel suite.
  const f = await fixture({ timeoutMs: 5000, env: { SLOW_READY_MS: "60000" } });
  const failure = await f.manager.start("api", new AbortController().signal).catch((error: unknown) => error);
  expect((failure as Error).message).toContain("readiness timed out");
  expect(api(f.manager)).toMatchObject({ state: "failed", tail: expect.stringContaining("booting") });
}, 20_000);

test("an unknown service name is refused", async () => {
  const f = await fixture();
  await expect(f.manager.start("web", new AbortController().signal)).rejects.toThrow('No service named "web"');
});

test("an unconfirmed cleanup raises the process cleanup error through the platform seam", async () => {
  let root = 0;
  // Simulated Windows: the OS listing keeps reporting the root, so termination is never confirmed.
  const platform: ProcessPlatform = { groups: false, signalProcess: () => {}, signalGroup: () => { throw new Error("no groups"); },
    list: async () => new Map(root ? [[root, { pid: root, parent: 1, group: 0, stamp: "root" }]] : []) };
  const f = await fixture({}, { platform });
  const started = await f.manager.start("api", new AbortController().signal);
  root = started.pid!;
  const grandchild = await f.grandchild();
  // The simulated platform signals nothing. Without groups (Windows) stop the real tree first: Windows can't
  // remove a folder that a live process still runs in.
  cleanups.push(async () => {
    if (!osSupportsProcessGroups) await new OwnedProcesses(root, () => true).stop();
    for (const pid of [root, grandchild]) { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
  });
  await expect(f.manager.stop("api")).rejects.toBeInstanceOf(ProcessCleanupError);
  expect(() => f.manager.assertCleanup()).toThrow(ProcessCleanupError);
  expect(api(f.manager).cleanup).toBe("unknown");
}, 20_000);

const pids = async (file: string) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);

test("a close while a service is still starting leaves no process", async () => {
  const root = await project(), log = path.join(root, "pids.log");
  const f = await fixture({ env: { PID_LOG: log } }, { root });
  const work = f.manager.start("api", new AbortController().signal).catch((error: unknown) => error);
  await f.manager.close();
  expect(await work).toBeInstanceOf(Error);
  // A launch that spawned after close would have logged a PID by now.
  await Bun.sleep(750);
  for (const pid of await pids(log)) await gone(pid);
  expect(["idle", "stopped"]).toContain(api(f.manager).state);
  expect(api(f.manager).pid).toBeUndefined();
}, 20_000);

test("a restart while a service is starting leaves exactly one process", async () => {
  const root = await project(), log = path.join(root, "pids.log");
  const f = await fixture({ env: { PID_LOG: log } }, { root });
  const signal = new AbortController().signal;
  const first = f.manager.start("api", signal).catch((error: unknown) => error);
  const second = await f.manager.restart("api", signal);
  expect(second.state).toBe("ready");
  expect(await first).toBeInstanceOf(Error);
  await Bun.sleep(300);
  expect((await pids(log)).filter(alive)).toHaveLength(1);
  await f.manager.close();
  for (const pid of await pids(log)) await gone(pid);
}, 20_000);

test("scope matching resolves aliases, and an edit whose identity cannot be proven disjoint marks the service stale", async () => {
  // A small parent: resolving a link lists its directory within a bounded budget.
  const base = await project(), root = path.join(base, "app"), alias = path.join(base, "alias");
  await mkdir(path.join(root, "src"), { recursive: true }); await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "notdir"), "a file");
  await symlink(root, alias);
  const f = await fixture({ scope: { inputs: ["src"] } }, { root });
  await f.manager.start("api", new AbortController().signal);
  f.manager.markEdited(path.join(alias, "docs", "notes.md"));
  expect(api(f.manager).stale).toBe(false);
  // The same project through a symlinked path is still inside the scope.
  f.manager.markEdited(path.join(alias, "src", "routes.ts"));
  expect(api(f.manager).stale).toBe(true);
  await f.manager.restart("api", new AbortController().signal);
  // A path through a regular file has no provable identity, so it cannot be ruled out.
  f.manager.markEdited("notdir/routes.ts");
  expect(api(f.manager).stale).toBe(true);
}, 20_000);

test("a crash that a freshness restart replaces is still reported once afterwards", async () => {
  const f = await fixture({ env: { CRASH_AFTER_MS: "400" } });
  await f.manager.start("api", new AbortController().signal);
  await until(() => api(f.manager).state === "crashed");
  expect(await f.manager.ensureFresh("api", new AbortController().signal)).toEqual({ restarted: true });
  expect(f.manager.takeCrashes()).toEqual([expect.objectContaining({ name: "api", state: "crashed", exit: { code: 3, signal: null }, tail: expect.stringContaining("fatal: synthetic crash") })]);
  expect(f.manager.takeCrashes()).toEqual([]);
}, 20_000);
