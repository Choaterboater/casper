import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DEPENDENCY_FOLDERS, linkDependencies, unlinkDependencies } from "../src/crew/copies";
import { GitWorktreeManager } from "../src/workspace/worktree";
import { removeTempDir } from "./support/temp-dir";

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const git = async (cwd: string, ...args: string[]) => String((await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout);

async function repository() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-crew-copies-")));
  cleanup.push(() => removeTempDir(root));
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

test("a commit in a kept copy (the sandbox off) leaves its start where it was, so its work is all in the patch", async () => {
  const { repo, manager } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, repo));
  await writeFile(path.join(copy.path, "a.txt"), "crew\n");
  await git(copy.path, "commit", "-am", "builder");
  const [found] = await manager.crewCopies();
  expect(found!.baseCommit).toBe(copy.baseCommit);
  expect(new TextDecoder().decode((await manager.capturePatch(found!)).patch)).toContain("+crew");
});

test("/crew apply goes by lines: a change next to your unsaved edit in the same file lands; the AI's builders check whole files", async () => {
  const { repo, manager } = await repository();
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  await writeFile(path.join(repo, "long.txt"), `${lines.join("\n")}\n`);
  await git(repo, "add", "-A"); await git(repo, "commit", "-m", "long");
  const copy = await manager.create(await manager.planCrew("abc123", 1, repo));
  await writeFile(path.join(copy.path, "long.txt"), `${["crew", ...lines.slice(1)].join("\n")}\n`);
  await writeFile(path.join(repo, "long.txt"), `${[...lines.slice(0, -1), "yours"].join("\n")}\n`);
  const patch = await manager.capturePatch(copy);
  await expect(manager.applyCrew(copy, patch, { wholeFiles: true })).rejects.toThrow("long.txt changed in your folder too");
  await manager.applyCrew(copy, patch);
  const text = await readFile(path.join(repo, "long.txt"), "utf8");
  expect(text).toStartWith("crew\n");
  expect(text).toEndWith("yours\n");
});

test("a copy from the folder as it is has your unsaved and new files; only changes after it started block its work", async () => {
  const { repo, manager } = await repository();
  await writeFile(path.join(repo, "a.txt"), "yours\n");
  await writeFile(path.join(repo, "types.txt"), "new type\n");
  const copy = await manager.create(await manager.planCrew("abc123", 1, repo, { fromFolder: true }));
  expect(await readFile(path.join(copy.path, "a.txt"), "utf8")).toBe("yours\n");
  expect(await readFile(path.join(copy.path, "types.txt"), "utf8")).toBe("new type\n");
  expect((await manager.capturePatch(copy)).files).toEqual([]);
  await writeFile(path.join(copy.path, "a.txt"), "yours\ncrew\n");
  await writeFile(path.join(copy.path, "b.txt"), "crew b\n");
  const patch = await manager.capturePatch(copy);
  expect(patch.files.sort()).toEqual(["a.txt", "b.txt"]);
  // /crew finds it again with the same start, so it shows only the builder's work.
  const [found] = await manager.crewCopies();
  expect(found!.baseCommit).toBe(copy.baseCommit);
  expect((await manager.capturePatch(found!)).files.sort()).toEqual(["a.txt", "b.txt"]);
  expect(await manager.changedInFolder(copy, ["a.txt", "b.txt", "types.txt"])).toEqual([]);
  await manager.applyCrew(found!, patch, { wholeFiles: true });
  expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("yours\ncrew\n");
  expect(await readFile(path.join(repo, "b.txt"), "utf8")).toBe("crew b\n");
  expect(await readFile(path.join(repo, "types.txt"), "utf8")).toBe("new type\n");
  expect((await git(repo, "log", "--oneline")).trim().split("\n")).toHaveLength(1);
  expect(await git(repo, "diff", "--cached", "--name-only")).toBe("");

  // A change in your folder after the copy started still blocks.
  const second = await manager.create(await manager.planCrew("def456", 1, repo, { fromFolder: true }));
  await writeFile(path.join(second.path, "types.txt"), "crew type\n");
  await writeFile(path.join(repo, "types.txt"), "yours again\n");
  expect(await manager.changedInFolder(second, ["types.txt"])).toEqual(["types.txt"]);
  await expect(manager.applyCrew(second, await manager.capturePatch(second), { wholeFiles: true })).rejects.toThrow("types.txt changed in your folder too");
  // A new commit since: nothing is applied.
  await writeFile(path.join(repo, "types.txt"), "new type\n");
  await git(repo, "add", "-A"); await git(repo, "commit", "-m", "yours");
  await expect(manager.applyCrew(second, await manager.capturePatch(second))).rejects.toThrow(/commit/i);
});

test("a same-size change in your folder, a second before the check, still blocks the AI's builder (Git's racy-file guard is kept)", async () => {
  // Git trusts a file whose size, times and inode match its index entry. With whole-second times (Linux builds of
  // Git), a rewrite in the second the file was added matches, and only the index's own time tells Git to look at
  // the contents. A copy of the index with a new time loses that, so the check must keep the index's time.
  const { repo, manager } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, repo));
  await writeFile(path.join(copy.path, "a.txt"), "crew\n");
  for (let attempt = 0; attempt < 5; attempt++) {
    while (Date.now() % 1000 > 100) await Bun.sleep(5);
    const second = Math.floor(Date.now() / 1000);
    await writeFile(path.join(repo, "a.txt"), "a\n");
    await git(repo, "add", "a.txt");
    await writeFile(path.join(repo, "a.txt"), "y\n");
    if (Math.floor(Date.now() / 1000) !== second) continue;
    await Bun.sleep(1000 - (Date.now() % 1000) + 20);
    expect(await manager.changedInFolder(copy, ["a.txt"])).toEqual(["a.txt"]);
    return;
  }
  throw new Error("could not write the file and add it within one second");
}, 15_000);

test("/crew apply names the files whose lines clash with yours", async () => {
  const { repo, manager } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, repo));
  await writeFile(path.join(copy.path, "a.txt"), "crew\n");
  await writeFile(path.join(repo, "a.txt"), "yours\n");
  await expect(manager.applyCrew(copy, await manager.capturePatch(copy))).rejects.toThrow("a.txt changed in your folder too; nothing was applied");
  expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("yours\n");
});
