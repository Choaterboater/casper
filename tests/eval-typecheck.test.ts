import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { candidateTypecheck } from "./support/eval-typecheck";
import { childTestLimit } from "./support/limits";
import { removeTempDir } from "./support/temp-dir";
import { waitUntil } from "./support/wait";

const repoRoot = path.resolve(import.meta.dir, "..");

test("a candidate typecheck leaves the parent responsive and exits before workspace cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-typecheck-"));
  const workdir = path.join(root, "candidate");
  const home = path.join(root, "home");
  await mkdir(workdir);
  await mkdir(home);
  const release = path.join(workdir, "release");
  const ready = path.join(workdir, "ready");
  await writeFile(path.join(workdir, "package.json"), JSON.stringify({ scripts: {
    typecheck: `"${process.execPath.replaceAll("\\", "/")}" typecheck.ts`,
  } }));
  // The parent must service its own event loop before this child can succeed. A synchronous
  // wait instead stalls until the child's independent guard fails; no dangling process remains.
  await writeFile(path.join(workdir, "typecheck.ts"), `
    import { existsSync, writeFileSync } from "node:fs";
    writeFileSync("ready", String(process.pid));
    const deadline = Date.now() + 2500;
    while (!existsSync("release") && Date.now() < deadline) await Bun.sleep(10);
    process.exit(existsSync("release") ? 0 : 7);
  `);
  let completed = false;
  const checked = candidateTypecheck(workdir, home, repoRoot).finally(() => { completed = true; });
  // Attach the rejection handler immediately, including if setup or the readiness assertion fails.
  void checked.catch(() => {});
  try {
    expect(await waitUntil(() => existsSync(ready) || completed, 10_000)).toBe(true);
    expect(completed).toBe(false);
    await writeFile(release, "continue");
    expect(await checked).toMatchObject({ status: "pass", exitCode: 0 });
    await removeTempDir(workdir);
    expect(existsSync(workdir)).toBe(false);
  } finally {
    if (existsSync(workdir)) await writeFile(release, "continue");
    await checked.catch(() => {});
    await removeTempDir(root);
  }
}, childTestLimit());
