import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { freePort, ManagedProcess, ManagedProcessError, portInUse, type ManagedProcessOptions } from "../src/platform/managed-process";
import { ProcessCleanupError, type ProcessPlatform } from "../src/platform/processes";
import { BrowserServer } from "../src/browser/server";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const SERVER = path.join(import.meta.dir, "fixtures", "service-server.ts");
const COMMAND = `"${process.execPath}" "${SERVER}"`;

async function until(condition: () => boolean | Promise<boolean>, deadline = 5000): Promise<void> {
  const limit = performance.now() + deadline;
  while (performance.now() < limit) { if (await condition()) return; await Bun.sleep(20); }
  throw new Error("Condition was not reached before its deadline");
}
const gone = (pid: number) => until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });

async function fixture(env: Record<string, string>, options: Partial<ManagedProcessOptions> | ((origin: string) => Partial<ManagedProcessOptions>) = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-managed-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const port = await freePort();
  const marker = path.join(root, "grandchild.pid");
  const managed = new ManagedProcess({ command: COMMAND, cwd: root, env: { PORT: String(port), HOST: "127.0.0.1", SPAWN_CHILD: marker, ...env },
    ready: { log: "listening" }, timeoutMs: 10_000, ...typeof options === "function" ? options(`http://127.0.0.1:${port}`) : options });
  cleanups.push(() => managed.close().catch(() => {}));
  const grandchild = async () => { await until(async () => (await readFile(marker, "utf8").catch(() => "")).length > 0); return Number(await readFile(marker, "utf8")); };
  return { root, port, managed, grandchild, origin: `http://127.0.0.1:${port}` };
}

test("a process is ready when its log line appears, reports the time taken and leaves no process after close", async () => {
  const f = await fixture({ READY_LOG: "server is up", SLOW_READY_MS: "150" }, { ready: { log: "server is up" } });
  expect(f.managed.state()).toBe("starting");
  const ready = await f.managed.start(new AbortController().signal);
  expect(ready.readyMs).toBeGreaterThanOrEqual(100);
  expect(f.managed.state()).toBe("ready");
  expect(await (await fetch(`${f.origin}/health`)).json()).toEqual({ ok: true });
  const root = f.managed.pid!, grandchild = await f.grandchild();
  await f.managed.close();
  expect(f.managed.state()).toBe("stopped");
  await gone(root); await gone(grandchild);
  expect(await portInUse("127.0.0.1", f.port)).toBe(false);
}, 20_000);

test("a process is ready when a loopback HTTP path answers within the deadline", async () => {
  const f = await fixture({ SLOW_READY_MS: "200", READY_LOG: "never matched" }, origin => ({ ready: { http: new URL(`${origin}/health`) } }));
  const ready = await f.managed.start(new AbortController().signal);
  expect(ready).toMatchObject({ httpStatus: 200 });
  expect(ready.readyMs).toBeGreaterThanOrEqual(150);
  expect(f.managed.state()).toBe("ready");
}, 20_000);

test("an exit before readiness rejects with the log tail and exit details and leaves no process", async () => {
  const f = await fixture({ SLOW_READY_MS: "60000", CRASH_AFTER_MS: "300" });
  const failure = await f.managed.start(new AbortController().signal).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ManagedProcessError);
  expect(failure).toMatchObject({ reason: "exited", tail: expect.stringContaining("fatal: synthetic crash") });
  expect(String((failure as Error).message)).toContain("fatal: synthetic crash");
  expect(f.managed.state()).toBe("exited");
  expect(f.managed.exit()).toMatchObject({ code: 3 });
  await gone(f.managed.pid!); await gone(await f.grandchild());
}, 20_000);

test("a missed readiness deadline rejects with the log tail and leaves no process", async () => {
  const f = await fixture({ SLOW_READY_MS: "60000" }, { timeoutMs: 600 });
  const failure = await f.managed.start(new AbortController().signal).catch((error: unknown) => error);
  expect(failure).toMatchObject({ reason: "timeout", tail: expect.stringContaining("booting") });
  const grandchild = await f.grandchild();
  await gone(f.managed.pid!); await gone(grandchild);
  expect(f.managed.state()).toBe("stopped");
}, 20_000);

test("an aborted startup rejects with the log tail and leaves no process", async () => {
  const f = await fixture({ SLOW_READY_MS: "60000" });
  const controller = new AbortController();
  const work = f.managed.start(controller.signal).catch((error: unknown) => error);
  const grandchild = await f.grandchild();
  controller.abort();
  expect(await work).toMatchObject({ reason: "aborted", tail: expect.stringContaining("booting") });
  await gone(f.managed.pid!); await gone(grandchild);
}, 20_000);

test("the log tail is bounded to 16 KiB by default and can be filtered or cut to recent lines", async () => {
  const f = await fixture({ NOISE_BYTES: "60000" });
  await f.managed.start(new AbortController().signal);
  const all = f.managed.logs();
  expect(Buffer.byteLength(all.text)).toBeLessThanOrEqual(16_384);
  expect(all.truncated).toBe(true);
  expect(all.text).toContain("listening");
  expect(all.text).not.toContain("booting");
  const filtered = f.managed.logs({ filter: /listening|noise \d+9 / });
  expect(filtered.text.split("\n").every(line => /listening|noise \d+9 /.test(line))).toBe(true);
  expect(filtered.text).toContain("listening");
  expect(f.managed.logs({ lines: 2, filter: "noise" }).text.split("\n")).toHaveLength(2);
}, 20_000);

test("free loopback ports are distinct and usable, and a listening port is detected as in use", async () => {
  const [first, second] = [await freePort(), await freePort()];
  expect(first).not.toBe(second);
  for (const port of [first, second]) {
    expect(await portInUse("127.0.0.1", port)).toBe(false);
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("held") });
    try { expect(await portInUse("127.0.0.1", port)).toBe(true); }
    finally { await server.stop(true); }
  }
});

test("an unconfirmed cleanup raises the process cleanup error", async () => {
  const f = await fixture({});
  // Simulated Windows: the OS listing keeps reporting the root, so termination is never confirmed.
  const platform: ProcessPlatform = { groups: false, signalProcess: () => {}, signalGroup: () => { throw new Error("no groups"); },
    list: async () => new Map([[managed.pid!, { pid: managed.pid!, parent: 1, group: 0, stamp: "root" }]]) };
  const managed = new ManagedProcess({ command: COMMAND, cwd: f.root, env: { PORT: String(f.port), HOST: "127.0.0.1" }, ready: { log: "listening" }, timeoutMs: 10_000, platform });
  await managed.start(new AbortController().signal);
  const root = managed.pid!;
  cleanups.push(() => { try { process.kill(-root, "SIGKILL"); } catch { try { process.kill(root, "SIGKILL"); } catch { /* gone */ } } });
  await expect(managed.close()).rejects.toBeInstanceOf(ProcessCleanupError);
}, 20_000);

test("a browser server closed while its port is probed never spawns the development server", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-managed-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const port = await freePort();
  const server = new BrowserServer();
  cleanups.push(() => server.close().catch(() => {}));
  const started = server.start(COMMAND, root, `http://127.0.0.1:${port}/`, new AbortController().signal).catch((error: unknown) => error);
  await server.close();
  expect(await started).toMatchObject({ message: "Development server was closed during startup" });
  expect(server.diagnostics().running).toBe(false);
  expect(await portInUse("127.0.0.1", port)).toBe(false);
}, 20_000);

test("HTTP readiness and the port helpers are limited to loopback hosts", async () => {
  const options = { command: COMMAND, cwd: os.tmpdir(), timeoutMs: 1000 };
  for (const url of ["http://example.com:8080/health", "http://0.0.0.0:8080/", "http://10.0.0.1:8080/", "file:///etc/passwd"])
    expect(() => new ManagedProcess({ ...options, ready: { http: new URL(url) } })).toThrow("loopback");
  for (const url of ["http://localhost:8080/", "http://127.0.0.1:8080/", "http://[::1]:8080/"])
    expect(() => new ManagedProcess({ ...options, ready: { http: new URL(url) } })).not.toThrow();
  await expect(portInUse("example.com", 80)).rejects.toThrow("loopback");
  await expect(freePort("0.0.0.0")).rejects.toThrow("loopback");
  expect(await freePort("localhost")).toBeGreaterThan(0);
});

test("a close during startup rejects as closed, reports stopped and leaves no process", async () => {
  const f = await fixture({ SLOW_READY_MS: "60000" });
  const work = f.managed.start(new AbortController().signal).catch((error: unknown) => error);
  const grandchild = await f.grandchild();
  await f.managed.close();
  expect(await work).toMatchObject({ reason: "closed" });
  expect(f.managed.state()).toBe("stopped");
  expect(f.managed.exit()).toBeUndefined();
  await gone(f.managed.pid!); await gone(grandchild);
}, 20_000);

test("a crash after readiness reports exited with its exit details and calls onExit", async () => {
  const exits: unknown[] = [];
  const f = await fixture({ CRASH_AFTER_MS: "500" }, { onExit: details => exits.push(details) });
  await f.managed.start(new AbortController().signal);
  expect(f.managed.state()).toBe("ready");
  await until(() => f.managed.state() === "exited");
  expect(f.managed.exit()).toMatchObject({ code: 3 });
  expect(exits).toEqual([{ code: 3, signal: null }]);
  await until(() => f.managed.logs().text.includes("fatal: synthetic crash"));
  await f.managed.close();
  expect(f.managed.state()).toBe("exited");
  await gone(f.managed.pid!); await gone(await f.grandchild());
}, 20_000);

test("a sticky or global pattern still matches anywhere in a line, for readiness and log filters", async () => {
  const f = await fixture({ READY_LOG: "service is up" }, { ready: { log: /is up/gy } });
  await f.managed.start(new AbortController().signal);
  expect(f.managed.logs({ filter: /is up/y }).text).toBe("service is up");
}, 20_000);

test("a process closed before it started refuses to start as closed", async () => {
  const f = await fixture({});
  await f.managed.close();
  expect(await f.managed.start(new AbortController().signal).catch((error: unknown) => error)).toMatchObject({ reason: "closed", message: expect.stringContaining("closed before it started") });
  expect(f.managed.pid).toBeUndefined();
});

test("Casper's isolation and offline variables win over caller env; other caller values pass through", async () => {
  const names = ["PATH", "HOME", "TMPDIR", "BUN_INSTALL_AUTO", "npm_config_offline", "DATABASE_URL"];
  const f = await fixture({ PRINT_ENV: names.join(","), PATH: "/caller/bin", HOME: "/caller/home", TMPDIR: "/caller/tmp",
    BUN_INSTALL_AUTO: "force", npm_config_offline: "false", DATABASE_URL: "postgres://127.0.0.1/app" });
  await f.managed.start(new AbortController().signal);
  const seen = JSON.parse(f.managed.logs({ filter: /^env / }).text.slice(4)) as Record<string, string | null>;
  expect(seen).toMatchObject({ BUN_INSTALL_AUTO: "disable", npm_config_offline: "true", DATABASE_URL: "postgres://127.0.0.1/app" });
  expect(seen.PATH).toStartWith(path.join(f.root, "node_modules", ".bin"));
  expect(seen.HOME).not.toBe("/caller/home");
  if (process.platform !== "win32") expect(seen.TMPDIR).toBe(seen.HOME);
}, 20_000);
