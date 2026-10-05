import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectProject } from "../src/project/inspect";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// Git prints C:/Users/... on Windows. The project root must be in the system's own form (C:\Users\...), the same as
// every other path Casper builds, or a plain comparison (undo's "this folder", the session's folder) says no.
test("a git project's root is in the system's own path form, the same as its folder", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-root-")));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  await mkdir(path.join(root, "src"));
  const top = await inspectProject(root);
  expect(top.isGit).toBe(true);
  expect(top.root).toBe(path.resolve(top.root));
  expect(top.root).toBe(top.cwd);
  const inner = await inspectProject(path.join(root, "src"));
  expect(inner.root).toBe(top.root);
});
