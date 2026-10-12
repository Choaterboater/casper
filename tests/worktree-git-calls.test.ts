import { afterAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitWorktreeManager, retryObjectWrite } from "../src/workspace/worktree";
import { removeTempDir } from "./support/temp-dir";

// Every process this file starts, through Bun.spawn (node:child_process uses it too).
const started: Array<{ exitCode: number | null; signalCode: unknown }> = [];
const spawn = Bun.spawn;
Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
  const child = spawn(...args);
  started.push(child);
  return child;
}) as typeof Bun.spawn;
afterAll(() => { Bun.spawn = spawn; });

test("opening a folder that is not a Git repository leaves no git running there once it returns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-worktree-calls-"));
  try {
    for (let round = 0; round < 10; round++) {
      started.length = 0;
      expect(await GitWorktreeManager.open(root, path.join(root, "home"))).toBeUndefined();
      // Two git calls start together. When the first fails, the other is still running in the folder: on Windows
      // that keeps the folder busy (it can't be removed) after Casper has moved on or closed.
      expect(started.length).toBeGreaterThan(0);
      expect(started.filter((child) => child.exitCode === null && child.signalCode === null)).toEqual([]);
    }
  } finally { await removeTempDir(root); }
});

test("on Windows, a git add that loses a race to write a shared object is tried again; other errors and other systems are not", async () => {
  const race = new Error("git add failed: error: unable to write file C:/Temp/my repo/.git/objects/e6/9de29bb2d1d6434b8b29ae775ad8c2e48c5391: Permission denied\nfatal: cannot create an empty blob in the object database");
  const failing = (times: number, error: Error) => {
    let calls = 0;
    return { work: async () => { calls++; if (calls <= times) throw error; return "ok"; }, calls: () => calls };
  };
  const twice = failing(2, race);
  expect(await retryObjectWrite(twice.work, "win32", [0, 0, 0])).toBe("ok");
  expect(twice.calls()).toBe(3);
  const always = failing(9, race);
  await expect(retryObjectWrite(always.work, "win32", [0, 0])).rejects.toThrow("Permission denied");
  expect(always.calls()).toBe(3);
  const other = failing(1, new Error("git add failed: fatal: pathspec 'x' did not match any files"));
  await expect(retryObjectWrite(other.work, "win32", [0, 0])).rejects.toThrow("pathspec");
  expect(other.calls()).toBe(1);
  const linux = failing(1, race);
  await expect(retryObjectWrite(linux.work, "linux", [0, 0])).rejects.toThrow("Permission denied");
  expect(linux.calls()).toBe(1);
});
