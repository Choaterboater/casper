import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { posixProcessPlatform, ProcessCleanupError } from "../src/platform/processes";
import { BackgroundCommands } from "../src/runtime/background-commands";
import * as stalls from "../src/runtime/stalled-commands";
import { casperBashOperations } from "../src/runtime/pi";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(expected: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000;
  while (!await expected()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(30);
  }
}

test.skipIf(process.platform === "win32")("shell timeout kills real Bun workers in their separate groups", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "casper-shell-tree-"));
  cleanup.push(() => removeTempDir(cwd));
  let worker: number | undefined;
  cleanup.push(async () => { if (worker) { try { process.kill(worker, "SIGKILL"); } catch {} } });
  await writeFile(path.join(cwd, "spin.test.ts"), `
    import { test } from "bun:test";
    import { writeFileSync } from "node:fs";
    test("spinning worker", () => {
      process.on("SIGTERM", () => {});
      writeFileSync("worker.pid", String(process.pid));
      const end = Date.now() + 30000;
      while (Date.now() < end) {}
    }, 35000);
  `);
  await writeFile(path.join(cwd, "other.test.ts"), `import { test } from "bun:test"; test("other", () => {});`);
  // Capture the rejection immediately while waiting for the process's readiness marker.
  const pending = casperBashOperations(undefined).exec(`"${process.execPath}" test --parallel=2 ./spin.test.ts ./other.test.ts`, cwd,
    { timeout: 5, onData() {} }).then(value => ({ value, error: "" }), error => ({ error: String(error) }));
  try {
    await until(() => Bun.file(path.join(cwd, "worker.pid")).exists(), "worker never started");
    worker = Number(await readFile(path.join(cwd, "worker.pid"), "utf8"));
    const identity = (await posixProcessPlatform.list()).get(worker)!;
    expect(identity.group).toBe(worker);
    expect((await pending).error).toContain("timeout:5");
    await until(async () => {
      const now = (await posixProcessPlatform.list()).get(worker!);
      return !now || now.zombie === true || now.stamp !== identity.stamp;
    }, "shell left its Bun worker alive");
  } finally { await pending; }
}, 25_000);

test("owned shell preserves output and exit code and rejects pre-cancelled work", async () => {
  let output = "";
  const bash = casperBashOperations(undefined);
  expect(await bash.exec("printf shell-output; exit 7", process.cwd(), { timeout: 10, onData: chunk => { output += chunk; } })).toEqual({ exitCode: 7 });
  expect(output).toBe("shell-output");
  await expect(bash.exec("echo never", process.cwd(), { signal: AbortSignal.abort(), onData() {} })).rejects.toThrow("aborted");
}, 20_000);

test("unconfirmed shell cleanup notifies the host without permanently blocking later commands", async () => {
  const failure = new ProcessCleanupError();
  let blocked = 0, approved = 0, started = 0;
  const bash = casperBashOperations({ wrap: async command => ({ command }), approve: async () => { approved++; return undefined; },
    onCleanupFailure: error => { expect(error).toBe(failure); blocked++; } }, { exec: async () => {
      started++;
      if (started === 1) throw failure;
      return { exitCode: 0 };
    } });
  await expect(bash.exec("fixture", process.cwd(), { onData() {} })).rejects.toBe(failure);
  await expect(bash.exec("next", process.cwd(), { onData() {} })).resolves.toEqual({ exitCode: 0 });
  expect({ blocked, approved, started }).toEqual({ blocked: 1, approved: 2, started: 2 });
});

test("a stalled command must not translate unconfirmed cleanup into a normal stall result", async () => {
  const failure = new ProcessCleanupError();
  let blocked = 0;
  const watching = spyOn(stalls, "watchStall").mockImplementation(({ onStall }) => {
    queueMicrotask(onStall);
    return { output() {}, stop() {} };
  });
  try {
    const bash = casperBashOperations({ wrap: async command => ({ command }), stallSeconds: () => 1,
      onCleanupFailure: () => { blocked++; } }, { exec: async () => { throw failure; } });
    await expect(bash.exec("fixture", process.cwd(), { onData() {} })).rejects.toBe(failure);
    expect(blocked).toBe(1);
  } finally { watching.mockRestore(); }
});

test("failed background adoption preserves unconfirmed cleanup instead of replacing it with timeout", async () => {
  const failure = new ProcessCleanupError();
  const commands = new BackgroundCommands({ notify() {}, limitSeconds: 0.01, max: 0 });
  let blocked = 0;
  const bash = casperBashOperations({ wrap: async command => ({ command }), background: () => commands,
    onCleanupFailure: () => { blocked++; } }, { exec: async (_command, _cwd, { signal }) => {
      await new Promise<void>(resolve => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw failure;
    } });
  try {
    await expect(bash.exec("fixture", process.cwd(), { onData() {} })).rejects.toBe(failure);
    expect(blocked).toBe(1);
  } finally { await commands.close(); }
});
