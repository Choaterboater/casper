import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UndoStore } from "../src/task/undo";
import { posixOnly, posixSymlinks } from "./support/platform";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(options: { git?: boolean } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-undo-"));
  roots.push(base);
  const root = path.join(base, "project"), state = path.join(base, "home", ".casper", "projects", "project-0123456789abcdef");
  await mkdir(root, { recursive: true });
  if (options.git) {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } });
    git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
    await writeFile(path.join(root, "a.py"), "a = 1\n"); await writeFile(path.join(root, "c.py"), "c = 3\n");
    await writeFile(path.join(root, "run.sh"), "#!/bin/sh\necho hi\n"); await chmod(path.join(root, "run.sh"), 0o755);
    git("add", "-A"); git("commit", "-qm", "first");
  }
  return { base, root, state, store: new UndoStore({ stateDirectory: state, root }) };
}

async function repoFingerprint(root: string): Promise<string> {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } }).toString();
  const hash = createHash("sha256");
  hash.update(await readFile(path.join(root, ".git", "index")));
  hash.update(await readFile(path.join(root, ".git", "HEAD")));
  hash.update(git("stash", "list")); hash.update(git("for-each-ref"));
  return hash.digest("hex");
}

const tree = (snapshot: Awaited<ReturnType<UndoStore["snapshot"]>>) => {
  if (!("tree" in snapshot)) throw new Error(`no copy: ${snapshot.unavailable}`);
  return snapshot.tree;
};

test("in a git repo: a changed, an added and a removed file go back byte for byte, and the repo's own .git is untouched", async () => {
  const { root, state, store } = await setup({ git: true });
  const fingerprint = await repoFingerprint(root);
  const before = tree(await store.snapshot());
  await writeFile(path.join(root, "a.py"), "a = 2\n");
  await writeFile(path.join(root, "b.py"), "b = 2\n");
  await rm(path.join(root, "c.py"));
  await writeFile(path.join(root, "run.sh"), "#!/bin/sh\necho bye\n");
  const after = tree(await store.snapshot());
  await store.record(1, before, after);
  expect((await store.changes(before, after)).map((change) => change.path)).toEqual(["a.py", "b.py", "c.py", "run.sh"]);
  const plan = await store.plan(after, before);
  expect(plan.changedSince).toEqual([]);
  const applied = await store.apply(plan.ready, before);
  expect(applied).toEqual({ restored: ["a.py", "b.py", "c.py", "run.sh"], skipped: [] });
  expect(await readFile(path.join(root, "a.py"), "utf8")).toBe("a = 1\n");
  expect(await readFile(path.join(root, "c.py"), "utf8")).toBe("c = 3\n");
  expect(await readFile(path.join(root, "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
  if (process.platform !== "win32") expect((await stat(path.join(root, "run.sh"))).mode & 0o111).not.toBe(0);
  expect(await lstat(path.join(root, "b.py")).catch(() => undefined)).toBeUndefined();
  expect(await repoFingerprint(root)).toBe(fingerprint);
  expect((await stat(path.join(state, "undo.git"))).isDirectory()).toBe(true);
  if (process.platform !== "win32") expect((await stat(path.join(state, "undo.git"))).mode & 0o077).toBe(0);
});

test("in a folder that is not a git repo the same round trip works, and dependency and cache folders are never copied", async () => {
  const { root, store } = await setup();
  await mkdir(path.join(root, "node_modules", "x"), { recursive: true });
  await mkdir(path.join(root, ".venv", "lib"), { recursive: true });
  await mkdir(path.join(root, ".next", "cache"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "x", "index.js"), "x\n");
  await writeFile(path.join(root, ".venv", "lib", "site.py"), "v\n");
  await writeFile(path.join(root, ".next", "cache", "page.js"), "p\n");
  await writeFile(path.join(root, "notes.txt"), "one\n");
  const before = tree(await store.snapshot());
  await writeFile(path.join(root, "notes.txt"), "two\n");
  await mkdir(path.join(root, "src", "deep"), { recursive: true });
  await writeFile(path.join(root, "src", "deep", "new.py"), "new\n");
  await writeFile(path.join(root, "node_modules", "x", "index.js"), "changed by an install\n");
  const after = tree(await store.snapshot());
  expect((await store.changes(before, after)).map((change) => change.path)).toEqual(["notes.txt", "src/deep/new.py"]);
  const applied = await store.apply((await store.plan(after, before)).ready, before);
  expect(applied.restored).toEqual(["notes.txt", "src/deep/new.py"]);
  expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("one\n");
  // The folders the task made are gone again (they are empty); an install's change is not Casper's to undo.
  expect(await readdir(root)).toEqual(expect.not.arrayContaining(["src"]));
  expect(await readFile(path.join(root, "node_modules", "x", "index.js"), "utf8")).toBe("changed by an install\n");
});

test("a file edited after the task is skipped and keeps the user's bytes; the other files still go back", async () => {
  const { root, store } = await setup();
  await writeFile(path.join(root, "a.py"), "a1\n"); await writeFile(path.join(root, "notes.py"), "n1\n");
  const before = tree(await store.snapshot());
  await writeFile(path.join(root, "a.py"), "a2\n"); await writeFile(path.join(root, "notes.py"), "n2\n");
  const after = tree(await store.snapshot());
  await writeFile(path.join(root, "notes.py"), "the user's own edit\n");
  const plan = await store.plan(after, before);
  expect(plan.changedSince).toEqual(["notes.py"]);
  expect(plan.ready.map((change) => change.path)).toEqual(["a.py"]);
  await store.apply(plan.ready, before);
  expect(await readFile(path.join(root, "a.py"), "utf8")).toBe("a1\n");
  expect(await readFile(path.join(root, "notes.py"), "utf8")).toBe("the user's own edit\n");
});

test("secret files and files over 8 MB are never copied, so they are named as left out", async () => {
  const { root, store } = await setup();
  await writeFile(path.join(root, ".env"), "TOKEN=abc123\n");
  await writeFile(path.join(root, "big.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
  await writeFile(path.join(root, "ok.txt"), "fine\n");
  const snapshot = await store.snapshot();
  if (!("tree" in snapshot)) throw new Error("no copy");
  expect(snapshot.left).toEqual([{ path: ".env", why: "secret" }, { path: "big.bin", why: "big" }]);
  const listed = execFileSync("git", ["--git-dir", store.gitDir, "ls-tree", "-r", "--name-only", snapshot.tree], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } }).toString();
  expect(listed.trim().split("\n")).toEqual(["ok.txt"]);
});

test("with no git on the PATH, undo says git is not installed", async () => {
  const { store } = await setup();
  const saved = process.env.PATH;
  process.env.PATH = path.join(os.tmpdir(), "no-such-folder-for-git");
  try { expect(await store.snapshot()).toEqual({ unavailable: "git is not installed" }); }
  finally { process.env.PATH = saved; }
});

test("more files than the limit makes undo unavailable, in plain words", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-undo-limit-"));
  roots.push(base);
  await Promise.all(["a", "b", "c"].map((name) => writeFile(path.join(base, name), name)));
  const store = new UndoStore({ stateDirectory: path.join(base, ".state"), root: base, fileLimit: 2 });
  expect(await store.snapshot()).toEqual({ unavailable: "this folder has more than 2 files" });
});

posixSymlinks("a folder the model replaced with a link out comes back as a real folder; nothing is written or removed outside", async () => {
  const { base, root, store } = await setup();
  const outside = path.join(base, "outside");
  await mkdir(outside); await writeFile(path.join(outside, "keep.txt"), "outside\n");
  await mkdir(path.join(root, "src")); await writeFile(path.join(root, "src", "m.py"), "m\n");
  const before = tree(await store.snapshot());
  await rm(path.join(root, "src"), { recursive: true });
  await symlink(outside, path.join(root, "src"));
  const after = tree(await store.snapshot());
  // A file made through the link after the task is outside the folder: never deleted through the link.
  await writeFile(path.join(outside, "m.py"), "made outside\n");
  const plan = await store.plan(after, before);
  const applied = await store.apply(plan.ready, before);
  expect(applied.skipped).toEqual([]);
  expect((await lstat(path.join(root, "src"))).isDirectory()).toBe(true);
  expect(await readFile(path.join(root, "src", "m.py"), "utf8")).toBe("m\n");
  expect((await readdir(outside)).sort()).toEqual(["keep.txt", "m.py"]);
  expect(await readFile(path.join(outside, "m.py"), "utf8")).toBe("made outside\n");
});

posixSymlinks("a new file under a linked folder is not deleted through the link", async () => {
  const { base, root, store } = await setup();
  const outside = path.join(base, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(root, "linked"));
  const before = tree(await store.snapshot());
  await writeFile(path.join(outside, "new.txt"), "outside\n");
  const after = tree(await store.snapshot());
  // Git does not go through links, so the file under the link is not part of the task's copies at all.
  expect(await store.changes(before, after)).toEqual([]);
  await store.apply((await store.plan(after, before)).ready, before);
  expect(await readFile(path.join(outside, "new.txt"), "utf8")).toBe("outside\n");
});

posixOnly("a hostile repo config and an inherited GIT_DIR never reach the user's repository", async () => {
  const { base, root, store } = await setup({ git: true });
  const marker = path.join(base, "ran");
  const hook = path.join(base, "hook.sh");
  await writeFile(hook, `#!/bin/sh\ntouch ${marker}\n`); await chmod(hook, 0o755);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } });
  git("config", "core.fsmonitor", hook); git("config", "core.hooksPath", base);
  await writeFile(path.join(base, "post-index-change"), `#!/bin/sh\ntouch ${marker}\n`); await chmod(path.join(base, "post-index-change"), 0o755);
  const fingerprint = await repoFingerprint(root);
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(root, ".git"); process.env.GIT_INDEX_FILE = path.join(root, ".git", "index"); process.env.GIT_WORK_TREE = root;
  try {
    const before = tree(await store.snapshot());
    await writeFile(path.join(root, "a.py"), "a = 9\n");
    const after = tree(await store.snapshot());
    await store.apply((await store.plan(after, before)).ready, before);
    expect(await readFile(path.join(root, "a.py"), "utf8")).toBe("a = 1\n");
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  expect(await lstat(marker).catch(() => undefined)).toBeUndefined();
  expect(await repoFingerprint(root)).toBe(fingerprint);
});

test("prune keeps the newest tasks' copies; git's clean-up keeps a kept copy", async () => {
  const { root, store } = await setup();
  const trees: string[] = [];
  for (const n of [1, 2, 3]) {
    await writeFile(path.join(root, "f.txt"), `version ${n}\n`);
    trees.push(tree(await store.snapshot()));
    await store.record(n, trees[n - 1]!, trees[n - 1]!);
  }
  await store.prune(2);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
  const refs = execFileSync("git", ["--git-dir", store.gitDir, "for-each-ref", "--format=%(refname)"], { env }).toString().trim().split("\n");
  expect(refs).toEqual(["refs/casper/2/after", "refs/casper/2/before", "refs/casper/3/after", "refs/casper/3/before"]);
  execFileSync("git", ["--git-dir", store.gitDir, "gc", "--quiet", "--prune=now"], { env });
  expect(execFileSync("git", ["--git-dir", store.gitDir, "cat-file", "-t", trees[2]!], { env }).toString().trim()).toBe("tree");
});

test("the diff between two copies is a patch of this task's files only", async () => {
  const { root, store } = await setup();
  await writeFile(path.join(root, "other.py"), "mine\n"); await writeFile(path.join(root, "a.py"), "old\n");
  const before = tree(await store.snapshot());
  await writeFile(path.join(root, "a.py"), "new\n");
  const after = tree(await store.snapshot());
  const patch = await store.diff(before, after);
  expect(patch).toContain("-old\n+new");
  expect(patch).not.toContain("other.py");
  expect(await store.diff(before, after, { stat: true })).toContain("a.py | 2 +-");
});

test("a file saved between the plan and the undo (while Casper asked) keeps the user's bytes", async () => {
  const { root, store } = await setup();
  await writeFile(path.join(root, "a.py"), "a1\n"); await writeFile(path.join(root, "b.py"), "b1\n");
  const before = tree(await store.snapshot());
  await writeFile(path.join(root, "a.py"), "a2\n"); await writeFile(path.join(root, "made.py"), "new\n"); await writeFile(path.join(root, "b.py"), "b2\n");
  const after = tree(await store.snapshot());
  const plan = await store.plan(after, before);
  expect(plan.ready.map((change) => change.path)).toEqual(["a.py", "b.py", "made.py"]);
  // The user saves two files after the plan was made: one edited, one the task made.
  await writeFile(path.join(root, "a.py"), "the user's edit\n");
  await writeFile(path.join(root, "made.py"), "the user kept working here\n");
  const applied = await store.apply(plan.ready, before);
  expect(applied.restored).toEqual(["b.py"]);
  expect(applied.skipped.map((entry) => entry.path).sort()).toEqual(["a.py", "made.py"]);
  expect(await readFile(path.join(root, "a.py"), "utf8")).toBe("the user's edit\n");
  expect(await readFile(path.join(root, "made.py"), "utf8")).toBe("the user kept working here\n");
  expect(await readFile(path.join(root, "b.py"), "utf8")).toBe("b1\n");
});

test("a copy lists what git ignores (a whole ignored folder as one entry), which the copy does not hold", async () => {
  const { root, store } = await setup();
  await writeFile(path.join(root, ".gitignore"), "local.cfg\nbuild/\n");
  await writeFile(path.join(root, "local.cfg"), "mine\n");
  await mkdir(path.join(root, "build", "deep"), { recursive: true });
  await writeFile(path.join(root, "build", "deep", "out.js"), "x\n");
  const snapshot = await store.snapshot();
  if (!("tree" in snapshot)) throw new Error(snapshot.unavailable);
  expect(snapshot.ignored.sort()).toEqual(["build/", "local.cfg"]);
});

posixOnly("a file the task deleted comes back with your umask's permissions, not wider ones", async () => {
  const { root, store } = await setup();
  const saved = process.umask(0o077);
  try {
    await writeFile(path.join(root, "private.yaml"), "site: lab\n", { mode: 0o600 });
    await writeFile(path.join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o700 });
    const before = tree(await store.snapshot());
    await rm(path.join(root, "private.yaml")); await rm(path.join(root, "run.sh"));
    const after = tree(await store.snapshot());
    const applied = await store.apply((await store.plan(after, before)).ready, before);
    expect(applied.restored).toEqual(["private.yaml", "run.sh"]);
    expect((await stat(path.join(root, "private.yaml"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(root, "run.sh"))).mode & 0o777).toBe(0o700);
  } finally { process.umask(saved); }
});

test("a copy is still made after git's clean-up dropped a file that only this folder's index named", async () => {
  const { root, store } = await setup();
  await writeFile(path.join(root, "a.py"), "a = 1\n");
  // An old file (not "racily clean"), so git trusts the index and does not read it again.
  const old = new Date(Date.now() - 2 * 3600_000);
  await utimes(path.join(root, "a.py"), old, old);
  tree(await store.snapshot());
  // No task kept that copy; git's clean-up run from another work tree (another index) drops its objects.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  execFileSync("git", ["--git-dir", store.gitDir, "prune", "--expire=now"], { env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } });
  await writeFile(path.join(root, "b.py"), "b = 2\n");
  const after = tree(await store.snapshot());
  expect((await store.readBlob(execFileSync("git", ["--git-dir", store.gitDir, "rev-parse", `${after}:a.py`]).toString().trim())).toString()).toBe("a = 1\n");
});
