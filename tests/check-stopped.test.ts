import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandCheck } from "../src/verify/command";
import { checkCommand } from "./support/check-command";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function startedFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 500 && !await Bun.file(file).exists(); attempt++) await Bun.sleep(10);
  expect(await Bun.file(file).exists()).toBe(true);
}

// On POSIX a stopped check ends by a signal and has no exit code. Windows has no signals: the stopped
// process ends with exit code 1, which is Casper's doing, not the command's, so it must not be shown as one.
test("a check Casper stops (cancelled or timed out) has no exit code of its own, on every OS", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "casper-stopped-"));
  cleanup.push(() => removeTempDir(cwd));
  const controller = new AbortController();
  const pending = runCommandCheck({ name: "test", command: checkCommand("touch:started", "sleep:10000"), cwd, timeoutMs: 20_000, signal: controller.signal });
  await startedFile(path.join(cwd, "started"));
  controller.abort();
  expect(await pending).toMatchObject({ status: "fail", reason: "Verification cancelled", exitCode: null });
  const timed = await runCommandCheck({ name: "test", command: checkCommand("touch:timed", "sleep:10000"), cwd, timeoutMs: 1500 });
  expect(timed).toMatchObject({ status: "fail", ended: "timeout", exitCode: null });
  // A command that ends on its own keeps its exit code.
  expect(await runCommandCheck({ name: "test", command: checkCommand("exit:1"), cwd, timeoutMs: 20_000 })).toMatchObject({ exitCode: 1 });
}, 30_000);
