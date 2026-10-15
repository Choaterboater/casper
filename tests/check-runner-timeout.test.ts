import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import { DEFAULT_CHECK_TIMEOUT_MS, runCommandCheck } from "../src/verify/command";
import { posixProcessPlatform } from "../src/platform/processes";
import { VerifierRegistry } from "../src/verify/registry";
import type { ProjectModel } from "../src/project/model";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(20);
  }
}

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "casper-check-worker-"));
  cleanup.push(() => removeTempDir(cwd));
  await writeFile(path.join(cwd, "worker.cjs"), `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {});
    fs.writeFileSync("worker.pid", String(process.pid));
    console.log("tests/spinning.test.ts:");
    // A real CPU-bound worker, with a final guard if the regression breaks cleanup.
    const end = Date.now() + 20000;
    while (Date.now() < end) {}
  `);
  await writeFile(path.join(cwd, "runner.cjs"), `
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const mode = process.argv[2];
    spawn(process.execPath, ["worker.cjs"], { stdio: mode === "closed" ? "ignore" : "inherit" });
    process.on("SIGTERM", () => process.exit(0));
    const wait = setInterval(() => {
      if (fs.existsSync("worker.pid") && mode !== "wait") process.exit(0);
      if (mode === "wait") console.log("runner still working");
    }, 10);
  `);
  let worker: number | undefined;
  const ready = async () => {
    await until(() => Bun.file(path.join(cwd, "worker.pid")).exists(), "worker did not start");
    worker = Number(await readFile(path.join(cwd, "worker.pid"), "utf8"));
  };
  // Only this fixture's spawned worker, and only as a failing-test safety net.
  cleanup.push(async () => { if (worker) { try { process.kill(worker, "SIGKILL"); } catch {} } });
  const stopped = async () => {
    await ready();
    await until(async () => {
      try { process.kill(worker!, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }, "the check left its spinning worker alive");
  };
  return { cwd, ready, stopped, argv: (mode: string) => [process.execPath, "runner.cjs", mode] };
}

test("the existing configured deadline bounds a whole check, even a runner spawning a spinning child", async () => {
  const f = await fixture();
  const homeDir = path.join(f.cwd, "home");
  await mkdir(homeDir);
  const initial = await loadConfiguration({ projectRoot: f.cwd, homeDir });
  expect(initial.verification.timeoutMs).toBe(DEFAULT_CHECK_TIMEOUT_MS);
  expect(DEFAULT_CHECK_TIMEOUT_MS).toBe(600_000);
  await mkdir(path.join(f.cwd, ".casper"));
  await writeFile(path.join(f.cwd, ".casper/project.yaml"), "verification:\n  timeoutMs: 2000\n");
  const config = await loadConfiguration({ projectRoot: f.cwd, homeDir });
  const registry = VerifierRegistry.forProject({ project: { root: f.cwd }, commands: { test: `"${process.execPath}" runner.cjs wait` } } as ProjectModel,
    config.verification.timeoutMs, undefined, {
      // Keep this deadline test about an executing worker, not shell startup latency.
      wrap: () => ({ file: process.execPath, args: ["runner.cjs", "wait"], shell: false }),
    });
  const pending = registry.run(["test"]);
  try { await f.ready(); }
  catch (error) { throw new Error(`${error}; check result: ${JSON.stringify(await pending)}`); }
  const [result] = await pending;
  expect(result).toMatchObject({ status: "fail", ended: "timeout", reason: "Timed out after 2000ms" });
  await f.stopped();
}, 20_000);

test.skipIf(process.platform === "win32")("a real parallel Bun test timeout stops its spinning worker in a separate process group", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "casper-bun-check-worker-"));
  cleanup.push(() => removeTempDir(cwd));
  let worker: number | undefined;
  // A failing regression still stops its fixture worker; the worker also has a bounded CPU guard.
  cleanup.push(async () => { if (worker) { try { process.kill(worker, "SIGKILL"); } catch {} } });
  await writeFile(path.join(cwd, "spin.test.ts"), `
    import { test } from "bun:test";
    import { writeFileSync } from "node:fs";
    test("spinning worker", () => {
      process.on("SIGTERM", () => {});
      writeFileSync("worker.json", JSON.stringify({ pid: process.pid, parent: process.ppid }));
      const end = Date.now() + 20000;
      while (Date.now() < end) {}
    }, 30000);
  `);
  await writeFile(path.join(cwd, "other.test.ts"), `import { test } from "bun:test"; test("other worker", () => {});`);
  const pending = runCommandCheck({ name: "test", argv: [process.execPath, "test", "--parallel", "./spin.test.ts", "./other.test.ts"],
    cwd, timeoutMs: 3000, sandbox: false });
  try {
    await until(() => Bun.file(path.join(cwd, "worker.json")).exists(), "Bun's parallel test worker did not start");
    const identity = JSON.parse(await readFile(path.join(cwd, "worker.json"), "utf8")) as { pid: number; parent: number };
    worker = identity.pid;
    const table = await posixProcessPlatform.list();
    const runner = table.get(identity.parent);
    const child = table.get(worker);
    expect(runner).toBeDefined();
    expect(child).toBeDefined();
    expect(child!.parent).toBe(runner!.pid);
    // Unlike the synthetic fixture above, Bun's real parallel worker leads its own group.
    expect(child!.group).toBe(child!.pid);
    expect(child!.group).not.toBe(runner!.group);
    expect(await pending).toMatchObject({ status: "fail", ended: "timeout", reason: "Timed out after 3000ms" });
    await until(async () => {
      const current = (await posixProcessPlatform.list()).get(worker!);
      return !current || current.zombie === true || current.stamp !== child!.stamp;
    }, "the timed-out Bun check left its separate-group worker running");
  } finally { await pending; }
}, 20_000);

test("cancellation kills a spinning child even when its runner exits on TERM", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const pending = runCommandCheck({ name: "test", argv: f.argv("wait"), cwd: f.cwd, timeoutMs: 15_000, sandbox: false, signal: controller.signal });
  await f.ready();
  controller.abort();
  expect(await pending).toMatchObject({ status: "fail", reason: "Verification cancelled" });
  await f.stopped();
}, 20_000);

test.skipIf(process.platform === "win32")("a missed reparented worker cannot keep a completed check waiting on pipes", async () => {
  const f = await fixture();
  await writeFile(path.join(f.cwd, "escape.cjs"), `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    spawn(process.execPath, ["worker.cjs"], { detached: true, stdio: "inherit" });
    setInterval(() => { if (fs.existsSync("worker.pid")) process.exit(0); }, 10);
  `);
  // Simulate the discovery gap deterministically: the worker starts and is
  // reparented between OS snapshots, so no snapshot ever proves its parentage.
  const list = posixProcessPlatform.list.bind(posixProcessPlatform);
  const hidden = spyOn(posixProcessPlatform, "list").mockImplementation(async () => {
    const all = await list();
    const pid = Number(await readFile(path.join(f.cwd, "worker.pid"), "utf8").catch(() => "0"));
    all.delete(pid);
    return all;
  });
  let unconfirmed = 0;
  const pending = runCommandCheck({ name: "test", argv: [process.execPath, "escape.cjs"], cwd: f.cwd,
    timeoutMs: 10_000, sandbox: false, onCleanupFailure: () => { unconfirmed++; } });
  try {
    await f.ready();
    expect(await pending).toMatchObject({ status: "fail", reason: "Owned process cleanup is unconfirmed: output pipes remained open after command exit" });
    expect(unconfirmed).toBe(1);
  } finally { hidden.mockRestore(); await pending; }
}, 20_000);

// POSIX groups survive their leader. Windows descendant discovery is covered by
// the platform ownership tests; it cannot use that group identity after root exit.
for (const mode of ["inherited", "closed"]) {
  test.skipIf(process.platform === "win32")(`normal runner exit cleans a spinning child with ${mode} output pipes`, async () => {
    const f = await fixture();
    const pending = runCommandCheck({ name: "test", argv: f.argv(mode), cwd: f.cwd, timeoutMs: 10_000, sandbox: false });
    await f.ready();
    expect(await pending).toMatchObject({ status: "pass", exitCode: 0 });
    await f.stopped();
  }, 20_000);
}
