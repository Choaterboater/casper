import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DEPENDENCY_FOLDERS, linkDependencies, unlinkDependencies } from "../src/crew/copies";
import { GitWorktreeManager } from "../src/workspace/worktree";

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const git = async (cwd: string, ...args: string[]) => String((await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout);

async function repository() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-crew-copies-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); const repo = path.join(root, "repo");
  await mkdir(home); await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "core.autocrlf", "false");
  await git(repo, "config", "user.name", "Casper Test");
  await git(repo, "config", "user.email", "casper@example.invalid");
  await writeFile(path.join(repo, "a.txt"), "a\n");
  await writeFile(path.join(repo, "b.txt"), "b\n");
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\n*.log\n");
  await git(repo, "add", "-A"); await git(repo, "commit", "-m", "base");
  const manager = (await GitWorktreeManager.open(repo, home))!;
  return { home, repo, manager };
}

test("a crew copy starts from HEAD even when your folder has changes, and /crew can find it again", async () => {
  const { repo, manager } = await repository();
  await writeFile(path.join(repo, "b.txt"), "yours\n");
  const copy = await manager.create(await manager.planCrew("abc123", 1, repo));
  expect(copy.branch).toBe("casper/crew-abc123-1");
  expect(copy.path).toContain(path.join(".casper", "worktrees"));
  expect(await readFile(path.join(copy.path, "b.txt"), "utf8")).toBe("b\n");
  expect(await readFile(path.join(repo, "b.txt"), "utf8")).toBe("yours\n");
  const found = await manager.crewCopies();
  expect(found).toEqual([expect.objectContaining({ branch: "casper/crew-abc123-1", path: copy.path, baseCommit: copy.baseCommit })]);
  await expect(manager.planCrew("ABC!", 1, repo)).rejects.toThrow();
});

test("dependency folders are linked into the copy and taken out before its changes are read", async () => {
  const { repo, manager } = await repository();
  await mkdir(path.join(repo, "node_modules", "left-pad"), { recursive: true });
  await writeFile(path.join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  const copy = await manager.create(await manager.planCrew("abc123", 1, repo));
  expect(await linkDependencies(repo, copy.path)).toEqual(["node_modules"]);
  expect((await lstat(path.join(copy.path, "node_modules"))).isSymbolicLink()).toBe(true);
  expect(path.resolve(copy.path, await readlink(path.join(copy.path, "node_modules")))).toBe(path.join(repo, "node_modules"));
  expect(DEPENDENCY_FOLDERS).toContain(".venv");
  // A builder's work, plus a log file git ignores (a test run's output).
  await writeFile(path.join(copy.path, "a.txt"), "changed\n");
  await writeFile(path.join(copy.path, "new.txt"), "new\n");
  await writeFile(path.join(copy.path, "run.log"), "noise\n");
  await unlinkDependencies(copy.path);
  await expect(lstat(path.join(copy.path, "node_modules"))).rejects.toThrow();
  expect(await readFile(path.join(repo, "node_modules", "left-pad", "index.js"), "utf8")).toContain("module.exports");
  const patch = await manager.capturePatch(copy);
  expect(patch.files.sort()).toEqual(["a.txt", "new.txt"]);
});

test("a crew's work applies onto your folder next to your own changes, and never over them", async () => {
  const { repo, manager } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, repo));
  await writeFile(path.join(copy.path, "a.txt"), "crew\n");
  const patch = await manager.capturePatch(copy);
  // Your change to another file stays; the crew's change lands uncommitted.
  await writeFile(path.join(repo, "b.txt"), "yours\n");
  await manager.applyCrew(copy, patch);
  expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("crew\n");
  expect(await readFile(path.join(repo, "b.txt"), "utf8")).toBe("yours\n");
  expect((await git(repo, "log", "--oneline")).trim().split("\n")).toHaveLength(1);
  const kept = await manager.remove(copy, patch);
  expect(kept).toBeDefined();
  expect(await manager.crewCopies()).toEqual([]);
  expect(await git(repo, "branch", "--list", "casper/*")).toBe("");

  // You changed the same file: nothing is applied.
  const second = await manager.create(await manager.planCrew("def456", 1, repo));
  await writeFile(path.join(second.path, "b.txt"), "crew b\n");
  const clash = await manager.capturePatch(second);
  await expect(manager.applyCrew(second, clash)).rejects.toThrow(/changed/i);
  expect(await readFile(path.join(repo, "b.txt"), "utf8")).toBe("yours\n");

  // A new commit in your folder since the crew started: nothing is applied.
  await git(repo, "add", "-A"); await git(repo, "commit", "-m", "yours");
  await writeFile(path.join(second.path, "b.txt"), "b\n");
  await writeFile(path.join(second.path, "c.txt"), "c\n");
  await expect(manager.applyCrew(second, await manager.capturePatch(second))).rejects.toThrow(/commit/i);
  await expect(readFile(path.join(repo, "c.txt"), "utf8")).rejects.toThrow();
});
