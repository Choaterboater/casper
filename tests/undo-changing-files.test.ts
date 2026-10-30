import { afterEach, expect } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

/**
 * Home Assistant's running container rewrites its database while Casper copies the folder for undo. git stopped with
 * "confused by unstable object source data for aac8bf…", and the receipt said "Undo not available: Casper could not save
 * a copy (confused by unstable object source data …)": no undo for the whole task, and git's own words on screen.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

/** A copy made by UndoStore in a child Bun whose `git add` fails as a busy file makes it fail, `fails` times. */
async function snapshotWithBusyGit(fails: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-undo-busy-"));
  roots.push(root);
  const project = path.join(root, "project"), state = path.join(root, "state"), bin = path.join(root, "bin");
  await mkdir(path.join(project, "config"), { recursive: true }); await mkdir(state); await mkdir(bin);
  await writeFile(path.join(project, "configuration.yaml"), "http:\n");
  await writeFile(path.join(project, "config", "home-assistant_v2.db-wal"), "wal");
  const real = Bun.which("git")!;
  // The fake git: `add` stops as git does for a file being written; everything else is the real git.
  await writeFile(path.join(bin, "git"), `#!/bin/sh
for word in "$@"; do
  if [ "$word" = "add" ]; then
    n=$(cat "${root}/adds" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${root}/adds"
    if [ $n -le ${fails} ]; then echo "fatal: confused by unstable object source data for aac8bf1e2d3c4b5a69788796a5b4c3d2e1f0a9b8" >&2; exit 128; fi
    break
  fi
done
exec "${real}" "$@"
`);
  await chmod(path.join(bin, "git"), 0o755);
  const worker = `
    import { UndoStore } from ${JSON.stringify(new URL("../src/task/undo.ts", import.meta.url).href)};
    import { writeFile, utimes } from "node:fs/promises";
    process.env.PATH = ${JSON.stringify(bin)} + ":" + process.env.PATH;
    const store = new UndoStore({ root: ${JSON.stringify(project)}, stateDirectory: ${JSON.stringify(state)} });
    // The database's log is being written right now.
    const wal = ${JSON.stringify(path.join(project, "config", "home-assistant_v2.db-wal"))};
    const busy = setInterval(() => { writeFile(wal, String(Date.now())).catch(() => {}); }, 20);
    const old = new Date(Date.now() - 60_000);
    await utimes(${JSON.stringify(path.join(project, "configuration.yaml"))}, old, old);
    const copy = await store.snapshot();
    clearInterval(busy);
    await writeFile(${JSON.stringify(path.join(root, "result.json"))}, JSON.stringify(copy));
  `;
  const child = spawn(process.execPath, ["--eval", worker], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr!.on("data", (chunk) => { errors += chunk; });
  await new Promise((resolve) => child.once("close", resolve));
  expect(errors).toBe("");
  return JSON.parse(await readFile(path.join(root, "result.json"), "utf8")) as { tree?: string; left?: Array<{ path: string; why: string }>; unavailable?: string };
}

posixOnly("a file that changes while Casper copies it is left out and named; the rest of the copy stands", async () => {
  const copy = await snapshotWithBusyGit(2);
  expect(copy.unavailable).toBeUndefined();
  expect(copy.tree).toMatch(/^[0-9a-f]{40}$/);
  expect(copy.left).toEqual([{ path: "config/home-assistant_v2.db-wal", why: "changing" }]);
}, 30_000);

posixOnly("once is retried quietly; a copy that still can't be saved says so in plain words, never git's", async () => {
  expect((await snapshotWithBusyGit(1)).left).toEqual([]);
  const failed = await snapshotWithBusyGit(99);
  expect(failed.unavailable).toBe("Casper could not save a copy (files kept changing while it copied them)");
  expect(failed.unavailable).not.toContain("unstable object");
}, 30_000);
