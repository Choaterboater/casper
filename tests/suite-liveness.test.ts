import { beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ownSpawnedTree } from "../src/platform/processes";
import { FAKE_PROGRAM_SETUP_MS, prepareFakePrograms, run } from "./fixtures/security-tools/setup";
import { cleanEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";
import { waitUntil } from "./support/wait";

// Prime the existing cross-process Windows launcher cache outside the nested cohort's
// execution guard, just as its security file does in its own setup hook.
beforeAll(prepareFakePrograms, FAKE_PROGRAM_SETUP_MS);

// The historical 995-second pass and 30-minute hang are evidence, not timing assertions.
// Exercise the blocked event-loop mechanism on a short, independently guarded child instead.
test("security fixture waits keep the worker event loop responsive until the child is reaped", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suite-liveness-"));
  const ready = path.join(root, "ready");
  const release = path.join(root, "release");
  let pending: Promise<string> | undefined;
  let completed = false;
  try {
    pending = run(root, process.execPath, ["-e", `
      import { existsSync, writeFileSync } from "node:fs";
      writeFileSync("ready", "ready");
      const deadline = Date.now() + 2500;
      while (!existsSync("release") && Date.now() < deadline) await Bun.sleep(10);
      if (!existsSync("release")) process.exit(7);
      process.stdout.write("fixture done\\n");
    `]).finally(() => { completed = true; });
    void pending.catch(() => {});
    expect(await waitUntil(() => existsSync(ready) || completed, 10_000)).toBe(true);
    expect(completed).toBe(false);
    await writeFile(release, "continue");
    expect(await pending).toBe("fixture done\n");
    // Do not discard a raw git status's significant leading space or trailing newline.
    expect(await run(root, process.execPath, ["-e", 'process.stdout.write(" M file.py\\n")'])).toBe(" M file.py\n");
  } finally {
    await writeFile(release, "continue");
    await pending?.catch(() => {});
    await removeTempDir(root);
  }
});

test("the undo-app file announcement is followed by completion alongside security setup", async () => {
  const child = Bun.spawn([process.execPath, "test", "--parallel=2", "tests/undo-app.integration.test.ts", "tests/security-ai-app.test.ts",
    "--test-name-pattern", "mid-task rebase counts 17|a one-shot /security-review never starts"], {
    cwd: path.resolve(import.meta.dir, ".."), env: cleanEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
  });
  // Bun test workers create their own groups. Observe OS parentage too so a failing
  // regression cannot orphan a spinning worker when its root is stopped.
  const owner = ownSpawnedTree(child.pid, () => child.exitCode === null && child.signalCode === null, { trackGroups: true })!;
  let timedOut = false;
  const guard = setTimeout(() => { timedOut = true; void owner.stop(); }, 20_000);
  try {
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const output = `${stdout}${stderr}`.replaceAll("\\", "/");
    expect({ status, timedOut, output }).toMatchObject({ status: 0, timedOut: false });
    expect(output).toContain("tests/undo-app.integration.test.ts:");
    expect(output).toMatch(/\b2 pass\b/);
    expect(output).toMatch(/\b0 fail\b/);
  } finally { clearTimeout(guard); await owner.stop(); }
});
