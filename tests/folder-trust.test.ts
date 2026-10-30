import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectStateDirectory } from "../src/project/model";
import { folderTrust, migrateFolderTrust, saveFolderTrust, TRUST_MIGRATED, type TrustGit } from "../src/project/trust";
import { inspectProject } from "../src/project/inspect";
import { cleanEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });

async function place() {
  // Git names folders by their real path (macOS's /var is /private/var), as Casper's project root does.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-trust-")));
  roots.push(root);
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  return { root, home };
}

async function gitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const run = Bun.spawnSync(["git", "init", "-q", dir], { env: cleanEnv() });
  expect(run.exitCode).toBe(0);
}

const info = (root: string, isGit = false) => ({ cwd: root, root, name: path.basename(root), gitBranch: null, isGit });

test("a folder is trusted only once you trust it; Not now saves nothing; home and the top of a drive never are", async () => {
  const { root, home } = await place();
  const project = path.join(root, "project");
  await mkdir(project);
  expect(await folderTrust(info(project), home)).toEqual({ trusted: false, why: "new" });
  await saveFolderTrust(project, home, true);
  expect(await folderTrust(info(project), home)).toEqual({ trusted: true, from: project });
  const saved = JSON.parse(await readFile(path.join(projectStateDirectory(project, home), "trust.json"), "utf8"));
  expect(saved).toMatchObject({ version: 1, trusted: true });
  await saveFolderTrust(project, home, false);
  expect(await folderTrust(info(project), home)).toEqual({ trusted: false, why: "new" });
  // Home is never trusted, even with a record (a hand-made one, or an older Casper's).
  await mkdir(projectStateDirectory(home, home), { recursive: true });
  await writeFile(path.join(projectStateDirectory(home, home), "trust.json"), JSON.stringify({ version: 1, trusted: true }));
  expect(await folderTrust(info(home), home)).toEqual({ trusted: false, why: "home" });
  expect(await folderTrust(info(path.parse(home).root), home)).toEqual({ trusted: false, why: "drive" });
  await expect(saveFolderTrust(home, home, true)).rejects.toThrow("never trusts your home folder");
});

test("below a trusted folder: a plain folder is covered, a repository of its own asks for itself", async () => {
  const { root, home } = await place();
  const projects = path.join(root, "Projects");
  await mkdir(path.join(projects, "notes"), { recursive: true });
  await saveFolderTrust(projects, home, true);
  // Same project: no git root of its own.
  expect(await folderTrust(info(path.join(projects, "notes")), home)).toEqual({ trusted: true, from: projects });
  // A repository cloned into it later is its own project.
  const cloned = path.join(projects, "cloned");
  await gitRepo(cloned);
  expect(await folderTrust(info(cloned, true), home)).toEqual({ trusted: false, why: "new" });
});

test("a worktree of a trusted repository is that project's; a folder whose .git only points at it is not", async () => {
  const { root, home } = await place();
  const main = path.join(root, "main");
  await gitRepo(main);
  const env = cleanEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" });
  await writeFile(path.join(main, "a.txt"), "a\n");
  expect(Bun.spawnSync(["git", "-C", main, "add", "a.txt"], { env }).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-C", main, "commit", "-qm", "a"], { env }).exitCode).toBe(0);
  const worktree = path.join(root, "experiment");
  expect(Bun.spawnSync(["git", "-C", main, "worktree", "add", "-q", worktree], { env }).exitCode).toBe(0);
  // Saved as Casper saves it when you trust the main checkout: under the root it opened (git's own name for it).
  await saveFolderTrust((await inspectProject(main)).root, home, true);
  const opened = await inspectProject(worktree);
  expect(await folderTrust(opened, home)).toMatchObject({ trusted: true });
  // Git names folders its own way (C:/... on Windows, a real path elsewhere): a form that differs only in spelling
  // still finds the answer saved under the opened root.
  const spelled: TrustGit = async (args, cwd) => {
    const run = Bun.spawnSync(["git", ...args], { cwd, env: cleanEnv() });
    const out = run.exitCode === 0 ? run.stdout.toString().trim() : undefined;
    return out && args.includes("--git-common-dir") ? `${out}/../.git` : out;
  };
  expect(await folderTrust(opened, home, { git: spelled })).toMatchObject({ trusted: true });
  // A downloaded folder with a .git file naming the trusted repository is not one of its worktrees.
  const posing = path.join(root, "posing");
  await mkdir(posing);
  await writeFile(path.join(posing, ".git"), `gitdir: ${path.join(main, ".git")}\n`);
  expect(await folderTrust(info(posing, true), home)).toEqual({ trusted: false, why: "new" });
});

test("once, folders Casper already kept state for count as trusted; home's doesn't, and a folder opened later still asks", async () => {
  const { root, home } = await place();
  const before = path.join(root, "before");
  const later = path.join(root, "later");
  await mkdir(before); await mkdir(later);
  await mkdir(projectStateDirectory(before, home), { recursive: true });
  await mkdir(projectStateDirectory(home, home), { recursive: true });
  expect(migrateFolderTrust(home)).toBe(1);
  expect(await folderTrust(info(before), home)).toMatchObject({ trusted: true });
  expect(await folderTrust(info(home), home)).toEqual({ trusted: false, why: "home" });
  expect(await Bun.file(path.join(home, ".casper", TRUST_MIGRATED)).exists()).toBe(true);
  // A later folder's state, made after the migration, is not trusted by it.
  await mkdir(projectStateDirectory(later, home), { recursive: true });
  expect(migrateFolderTrust(home)).toBe(0);
  expect(await folderTrust(info(later), home)).toEqual({ trusted: false, why: "new" });
});

test("no Casper state before: the migration trusts nothing and runs only once", async () => {
  const { home } = await place();
  expect(migrateFolderTrust(home)).toBe(0);
  expect(migrateFolderTrust(home)).toBe(0);
});

test("a project Casper makes for you opens trusted; one it couldn't make is not", async () => {
  const { buildProject } = await import("../src/app/new-project");
  const { root, home } = await place();
  const made = path.join(root, "made");
  await mkdir(made);
  const result = (status: "ready" | "not_created", dir: string) => ({ status, exitCode: status === "ready" ? 0 as const : 1 as const, dir, displayDir: dir, name: path.basename(dir), checks: [], notes: [], kept: [] });
  const flow = (status: "ready" | "not_created") => ({ pick: async () => undefined, write: () => {}, homeDir: home, create: async (options: { parent: string; name: string }) => result(status, path.join(options.parent, options.name)) });
  await buildProject(flow("ready"), root, "empty", "made");
  expect(await folderTrust(info(made), home)).toMatchObject({ trusted: true });
  await buildProject(flow("not_created"), root, "empty", "missing");
  expect(await folderTrust(info(path.join(root, "missing")), home)).toEqual({ trusted: false, why: "new" });
});
