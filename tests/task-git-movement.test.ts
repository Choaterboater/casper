import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitMovement, taskHead } from "../src/task/git-movement";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removeTempDir)); });

async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-task-git-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
  git("init", "-q"); git("config", "user.name", "t"); git("config", "user.email", "t@example.com");
  git("config", "commit.gpgsign", "false");
  const write = (name: string, text: string) => writeFile(path.join(root, name), text);
  const commit = () => { git("add", "."); git("commit", "-qm", "change"); };
  return { root, git, write, commit };
}

test("an initial task commit is task work, not incoming git work", async () => {
  const { root, write, commit } = await repo();
  const before = await taskHead(root);
  await write("new.ts", "new\n"); commit();
  expect(await gitMovement(root, before, await taskHead(root))).toEqual({ moved: false, incoming: new Map(), committed: new Set(["new.ts"]) });
});

test("incoming branch changes remain protected alongside a task commit and its amendment", async () => {
  const { root, git, write, commit } = await repo();
  await write("code.ts", "old\n"); commit();
  const base = git("rev-parse", "HEAD");
  git("switch", "-qc", "incoming");
  await write("incoming.ts", "incoming\n"); commit();
  git("switch", "-qc", "task", base);
  const before = await taskHead(root);
  await write("code.ts", "task\n"); commit();
  git("merge", "--no-edit", "incoming");
  await write("code.ts", "amended\n"); git("add", "."); git("commit", "--amend", "--no-edit", "-q");
  const movement = await gitMovement(root, before, await taskHead(root));
  expect(movement).toHaveProperty("moved", true);
  expect("incoming" in movement ? [...movement.incoming.keys()] : movement).toEqual(["incoming.ts"]);
  expect("committed" in movement ? [...movement.committed] : movement).toEqual(["code.ts"]);
});

test("a same-file nonconflicting merge retains task-commit provenance", async () => {
  const { root, git, write, commit } = await repo();
  const original = "task = 0\n\nunchanged = 0\n\nincoming = 0\n";
  await write("code.ts", original); commit();
  const base = git("rev-parse", "HEAD");
  git("switch", "-qc", "incoming");
  await write("code.ts", original.replace("incoming = 0", "incoming = 1")); commit();
  git("switch", "-qc", "task", base);
  const before = await taskHead(root);
  await write("code.ts", original.replace("task = 0", "task = 1")); commit();
  git("merge", "--no-edit", "incoming");
  const movement = await gitMovement(root, before, await taskHead(root));
  expect(movement).toHaveProperty("moved", true);
  expect("incoming" in movement ? [...movement.incoming.keys()] : movement).toEqual(["code.ts"]);
  expect("committed" in movement ? [...movement.committed] : movement).toEqual(["code.ts"]);
});

test("committed paths survive a later commit restoring the original tree", async () => {
  const { root, write, commit } = await repo();
  await write("code.ts", "original\n"); commit();
  const before = await taskHead(root);
  await write("code.ts", "task\n"); commit();
  await write("code.ts", "original\n"); commit();
  expect(await gitMovement(root, before, await taskHead(root))).toEqual({ moved: false, incoming: new Map(), committed: new Set(["code.ts"]) });
});
