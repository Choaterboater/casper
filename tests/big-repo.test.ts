import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diffSnapshots, snapshotTree } from "../src/task/changes";
import { ChangeBaseline } from "../src/verify/proof";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
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
  const root = await tree({ "src/code.py": "old\n", "tests/check.sh": 'grep -q new src/code.py && test -f .venv/marker && test "$UV_NO_SYNC" = 1\n' });
  await manyFiles(root, ".venv/lib", 300);
  await writeFile(path.join(root, ".venv/marker"), "");
  const before = await snapshotTree(root);
  const baseline = await ChangeBaseline.capture(root, { fileLimit: 100 });
  try {
    await writeFile(path.join(root, "src/code.py"), "new\n");
    const changes = diffSnapshots(before, await snapshotTree(root));
    const proof = await baseline.prove({ root, changes, check: "test", command: "sh tests/check.sh", timeoutMs: 20_000 });
    expect(proof).toMatchObject({ status: "proven" });
  } finally { await baseline.dispose(); }
  expect((await lstat(path.join(root, ".venv"))).isDirectory()).toBe(true);
});
