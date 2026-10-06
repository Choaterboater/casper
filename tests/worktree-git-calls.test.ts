import { afterAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitWorktreeManager } from "../src/workspace/worktree";
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
