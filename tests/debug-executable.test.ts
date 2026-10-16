import { expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveTarget } from "../src/debug/config";
import { cleanEnv } from "./support/env";
import { needsSymlinks } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";
import { waitUntil } from "./support/wait";
import { existsSync } from "node:fs";

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "debug-executable-")));
  await mkdir(path.join(root, ".casper"));
  await writeFile(path.join(root, "program.py"), "pass\n");
  const configure = (command: string) => writeFile(path.join(root, ".casper/debug.json"), JSON.stringify({ targets: {
    fixture: { command, adapterID: "python", program: "program.py" },
  } }));
  return { root, configure };
}

test("a hard-linked debugger executable keeps its requested name under concurrent alias access", async () => {
  const { root, configure } = await fixture();
  const alias = path.join(root, "another-tool");
  const requested = path.join(root, "requested-tool");
  let reader: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await writeFile(alias, "fixture executable\n");
    await chmod(alias, 0o755);
    await link(alias, requested);
    await configure(requested);
    const ready = path.join(root, "ready");
    reader = Bun.spawn([process.execPath, "-e", `
      import { readFileSync, writeFileSync } from "node:fs";
      writeFileSync(process.argv[2], "ready");
      for (;;) readFileSync(process.argv[1]);
    `, alias, ready], { cwd: root, env: cleanEnv({ HOME: root }), stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 20_000, killSignal: "SIGKILL" });
    expect(await waitUntil(() => existsSync(ready), 10_000)).toBe(true);
    // macOS's inode-to-path cache is shared across processes; realpath of the leaf can
    // otherwise return another hard-link basename, changing an Apple shim's argv[0].
    for (let attempt = 0; attempt < 256; attempt++) expect((await resolveTarget(root, "fixture")).command).toBe(requested);
  } finally {
    reader?.kill("SIGKILL");
    if (reader) await reader.exited;
    await removeTempDir(root);
  }
});

needsSymlinks("debugger executable links still resolve to the actual target and cycles fail", async () => {
  const { root, configure } = await fixture();
  try {
    const executable = path.join(root, "executable");
    const second = path.join(root, "second");
    const first = path.join(root, "first");
    await writeFile(executable, "fixture executable\n");
    await chmod(executable, 0o755);
    await symlink("executable", second);
    await symlink("second", first);
    await configure(first);
    expect((await resolveTarget(root, "fixture")).command).toBe(executable);
    await symlink("cycle", path.join(root, "cycle"));
    await configure(path.join(root, "cycle"));
    await expect(resolveTarget(root, "fixture")).rejects.toThrow("too many symbolic links");
  } finally { await removeTempDir(root); }
});
