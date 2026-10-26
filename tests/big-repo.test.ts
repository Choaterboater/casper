import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diffSnapshots, mediaLeftOut, snapshotTree } from "../src/task/changes";
import { ChangeBaseline } from "../src/verify/proof";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-big-")); dirs.push(root);
  for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
  return root;
}
async function manyFiles(root: string, folder: string, count: number): Promise<void> {
  await mkdir(path.join(root, folder), { recursive: true });
  await Promise.all(Array.from({ length: count }, (_, index) => writeFile(path.join(root, folder, `f${index}.py`), "x\n")));
}
function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

test("in a git repository the snapshot lists what git sees, so an ignored .venv of any size never breaks it", async () => {
  const root = await tree({ ".gitignore": ".venv/\nbuild/\n", "src/app.py": "a\n", "notes.txt": "untracked\n" });
  await manyFiles(root, ".venv/lib", 300);
  await manyFiles(root, "build", 5);
  git(root, "init", "-q"); git(root, "add", "src/app.py", ".gitignore"); git(root, "commit", "-qm", "init");
  const before = await snapshotTree(root, undefined, { fileLimit: 100 });
  expect([...before.keys()].sort()).toEqual([".gitignore", "notes.txt", "src/app.py"]);
  await writeFile(path.join(root, "src/app.py"), "b\n");
  await rm(path.join(root, "notes.txt"));
  await writeFile(path.join(root, "src/new.py"), "c\n");
  await writeFile(path.join(root, ".venv/lib/f1.py"), "changed\n");
  expect(diffSnapshots(before, await snapshotTree(root, undefined, { fileLimit: 100 }))).toEqual({ added: ["src/new.py"], modified: ["src/app.py"], removed: ["notes.txt"] });
});

test("git never hides a change: an ignored project folder, a nested repository and an un-ignored .venv", async () => {
  // Opened inside a folder the enclosing repository ignores: git lists nothing, so the folder is walked.
  const outer = await tree({ ".gitignore": "scratch/\n", "README.md": "outer\n", "scratch/app.py": "a\n" });
  git(outer, "init", "-q");
  const scratch = path.join(outer, "scratch");
  const ignored = await snapshotTree(scratch, undefined, { fileLimit: 100 });
  expect([...ignored.keys()]).toEqual(["app.py"]);
  await writeFile(path.join(scratch, "app.py"), "b\n");
  expect(diffSnapshots(ignored, await snapshotTree(scratch, undefined, { fileLimit: 100 }))).toEqual({ added: [], modified: ["app.py"], removed: [] });

  // A nested repository is one folder entry to git; its files are walked, its .git is not.
  const root = await tree({ "a.txt": "a\n", "nested/x.py": "x\n", "__pycache__/a.pyc": "x" });
  git(path.join(root, "nested"), "init", "-q");
  git(root, "init", "-q");
  await manyFiles(root, ".venv/lib", 300);
  const before = await snapshotTree(root, undefined, { fileLimit: 100 });
  expect([...before.keys()].sort()).toEqual(["a.txt", "nested/x.py"]);
  await writeFile(path.join(root, "nested/x.py"), "y\n");
  expect(diffSnapshots(before, await snapshotTree(root, undefined, { fileLimit: 100 }))).toEqual({ added: [], modified: ["nested/x.py"], removed: [] });
});

test("outside git, the walk skips virtual environments and Python caches", async () => {
  const root = await tree({ "app.py": "a\n", "__pycache__/app.cpython-312.pyc": "x", ".mypy_cache/x.json": "{}", ".pytest_cache/v": "" });
  await manyFiles(root, ".venv/lib", 300);
  await manyFiles(root, "venv/lib", 300);
  await writeFile(path.join(root, "venv/pyvenv.cfg"), "home = /usr/bin\n");
  // A source folder that happens to be called venv is still read.
  await writeFile(path.join(root, "src/venv/__init__.py").replace("src/venv", "pkg/venv"), "").catch(async () => {
    await mkdir(path.join(root, "pkg/venv"), { recursive: true }); await writeFile(path.join(root, "pkg/venv/__init__.py"), "");
  });
  expect([...(await snapshotTree(root, undefined, { fileLimit: 100 })).keys()].sort()).toEqual(["app.py", "pkg/venv/__init__.py"]);
});

test("the proof copy links .venv like node_modules instead of copying it, and tells uv not to sync it", async () => {
  // The test is a script the runtime runs, not sh: on Windows a check runs through cmd.exe.
  const root = await tree({ "src/code.py": "old\n", "tests/check.js": 'const fs = require("fs");\n'
    + 'process.exit(fs.readFileSync("src/code.py", "utf8").includes("new") && fs.existsSync(".venv/marker") && process.env.UV_NO_SYNC === "1" ? 0 : 1);\n' });
  await manyFiles(root, ".venv/lib", 300);
  await writeFile(path.join(root, ".venv/marker"), "");
  const before = await snapshotTree(root);
  const baseline = await ChangeBaseline.capture(root, { fileLimit: 100 });
  try {
    await writeFile(path.join(root, "src/code.py"), "new\n");
    const changes = diffSnapshots(before, await snapshotTree(root));
    const proof = await baseline.prove({ root, changes, check: "test", command: `${JSON.stringify(process.execPath)} tests/check.js`, timeoutMs: 20_000 });
    expect(proof).toMatchObject({ status: "proven" });
  } finally { await baseline.dispose(); }
  expect((await lstat(path.join(root, ".venv"))).isDirectory()).toBe(true);
});

async function pictures(root: string, folder: string, count: number): Promise<void> {
  await mkdir(path.join(root, folder), { recursive: true });
  await Promise.all(Array.from({ length: count }, (_, index) => writeFile(path.join(root, folder, `p${index}.${["jpg", "png", "mp4"][index % 3]}`), "x")));
}

test("pictures, videos and archives can be left out of a snapshot, so a folder full of them still lists its code", async () => {
  // A real project saved tens of thousands of photo copies next to its code: over the limit, every receipt said
  // "Changes unknown: not a project folder", and nothing could be undone.
  const root = await tree({ "src/app.py": "a\n", "data/cards.json": "[]\n", "logo.svg": "<svg/>\n" });
  await pictures(root, "data/photos", 150);
  await mkdir(path.join(root, "data/exports"), { recursive: true });
  await writeFile(path.join(root, "data/exports/week.zip"), "z");
  await expect(snapshotTree(root, undefined, { fileLimit: 100 })).rejects.toThrow("Workspace exceeds 100 files");
  const before = await snapshotTree(root, undefined, { fileLimit: 100, media: false });
  expect([...before.keys()].sort()).toEqual(["data/cards.json", "logo.svg", "src/app.py"]);
  expect(mediaLeftOut(before)).toBe(true);
  expect(mediaLeftOut(await snapshotTree(root))).toBe(false);
  await writeFile(path.join(root, "src/app.py"), "b\n");
  await writeFile(path.join(root, "data/photos/p0.jpg"), "changed");
  await pictures(root, "data/photos/new", 3);
  expect(diffSnapshots(before, await snapshotTree(root, undefined, { fileLimit: 100, media: false }))).toEqual({ added: [], modified: ["src/app.py"], removed: [] });
});

test("a task whose first snapshot listed the pictures and whose last left them out compares only the rest", async () => {
  const root = await tree({ "src/app.py": "a\n" });
  await pictures(root, "photos", 30);
  const before = await snapshotTree(root);
  expect(before.size).toBe(31);
  await writeFile(path.join(root, "src/app.py"), "b\n");
  // Neither the pictures it listed before nor any it can't see now read as removed or added.
  expect(diffSnapshots(before, await snapshotTree(root, undefined, { media: false }))).toEqual({ added: [], modified: ["src/app.py"], removed: [] });
});

test("in a git repository whose tracked pictures put it over the limit, leaving them out lists the rest", async () => {
  const root = await tree({ "src/app.py": "a\n" });
  await pictures(root, "assets", 150);
  git(root, "init", "-q"); git(root, "add", "-A"); git(root, "commit", "-qm", "init");
  await expect(snapshotTree(root, undefined, { fileLimit: 100 })).rejects.toThrow("Workspace exceeds 100 files");
  expect([...(await snapshotTree(root, undefined, { fileLimit: 100, media: false })).keys()]).toEqual(["src/app.py"]);
});
