import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cleanEnv } from "./support/env";
import { emptyFolderNote } from "../src/flows/plan-store";

async function folder(...names: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "casper-empty-"));
  for (const name of names) await mkdir(path.join(root, name), { recursive: true });
  return root;
}

function git(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: cleanEnv(), stderr: "pipe", stdout: "pipe" });
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
}

describe("a folder empty except for .casper", () => {
  test("gets the note on how to put a repository here", async () => {
    const root = await folder(".casper/plans");
    try {
      const note = await emptyFolderNote(root);
      expect(note).toContain("git init");
      expect(note).toContain("git checkout -t origin/");
      expect(note).toContain("keep it");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("a folder with nothing in it, or with real files, gets no note", async () => {
    const empty = await folder();
    const real = await folder(".casper");
    await writeFile(path.join(real, "README.md"), "x");
    try {
      expect(await emptyFolderNote(empty)).toBe("");
      expect(await emptyFolderNote(real)).toBe("");
    } finally { await rm(empty, { recursive: true, force: true }); await rm(real, { recursive: true, force: true }); }
  });

  test("the note's steps put the repository at the top of the folder, where git clone . refuses", async () => {
    const source = await folder();
    const target = await folder(".casper/plans");
    try {
      await writeFile(path.join(source, "app.js"), "ok\n");
      expect(git(source, "init", "-q").code).toBe(0);
      expect(git(source, "add", "app.js").code).toBe(0);
      expect(git(source, "commit", "-qm", "first").code).toBe(0);
      const url = pathToFileURL(source).href;
      expect(git(target, "clone", url, ".").out).toContain("already exists and is not an empty directory");

      expect(git(target, "init", "-q").code).toBe(0);
      expect(git(target, "remote", "add", "origin", url).code).toBe(0);
      expect(git(target, "fetch", "-q", "origin").code).toBe(0);
      expect(git(target, "remote", "show", "origin").out).toContain("HEAD branch: main");
      expect(git(target, "checkout", "-q", "-t", "origin/main").code).toBe(0);
      expect(await readFile(path.join(target, "app.js"), "utf8")).toBe("ok\n");
      expect((await stat(path.join(target, ".casper/plans"))).isDirectory()).toBe(true);
    } finally { await rm(source, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
  });
});
