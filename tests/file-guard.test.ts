import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyPath, fileToolGate, gitInternalsCommand, hooksPathTargets, PRIVATE_PATHS } from "../src/platform/project-paths";
import { POSIX } from "./support/platform";

let root: string; let home: string; let project: string; let context: { root: string; home: string; agentDir: string };
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "casper-file-guard-"));
  home = path.join(root, "home"); project = path.join(root, "project");
  await mkdir(path.join(root, "outside"), { recursive: true });
  await writeFile(path.join(root, "outside/secret.txt"), "x");
  await mkdir(path.join(home, ".ssh"), { recursive: true });
  await writeFile(path.join(home, ".ssh/id_test"), "key");
  await mkdir(path.join(home, "agent"), { recursive: true });
  await mkdir(path.join(project, ".git/hooks"), { recursive: true });
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(path.join(project, ".git/config"), "[core]\n\thooksPath = .githooks\n");
  if (POSIX) {
    await symlink(path.join(root, "outside/secret.txt"), path.join(project, "notes.md"));
    await symlink(path.join(home, ".ssh"), path.join(project, "keys"));
  }
  context = { root: project, home, agentDir: path.join(home, "agent") };
});
afterAll(() => rm(root, { recursive: true, force: true }));

test("private places are refused by name for every file tool, reads and writes", () => {
  expect(PRIVATE_PATHS).toEqual(expect.arrayContaining([".ssh", ".aws", ".casper/agent/auth.json", ".casper/mcp-consent.key", ".pi/agent/auth.json", ".config/gcloud"]));
  expect(fileToolGate("read", { path: "~/.ssh/id_test" }, context)).toBe("Not read: ~/.ssh is private (keys and logins). Casper keeps it from the AI.");
  expect(fileToolGate("read", { path: path.join(home, ".casper/agent/auth.json") }, context)).toContain("~/.casper/agent/auth.json is private");
  expect(fileToolGate("read", { path: path.join(home, "agent/auth.json") }, context)).toContain("Casper's login file (auth.json) is private");
  expect(fileToolGate("ls", { path: "~/.aws" }, context)).toContain("~/.aws is private");
  expect(fileToolGate("write", { path: "~/.ssh/authorized_keys", content: "x" }, context)).toBe("Not done: ~/.ssh is private (keys and logins). Casper keeps it from the AI.");
  // grep reads hidden files under its folder, so a folder holding a private place is refused too.
  expect(fileToolGate("grep", { pattern: "x", path: "~" }, context)).toBe("Not searched: ~ holds private files (~/.ssh). Search a narrower folder.");
  // Ordinary reads inside and outside the project still work.
  expect(fileToolGate("read", { path: "src/a.ts" }, context)).toBeUndefined();
  expect(fileToolGate("grep", { pattern: "x" }, context)).toBeUndefined();
  expect(fileToolGate("read", { path: path.join(root, "outside/secret.txt") }, context)).toBeUndefined();
  expect(fileToolGate("bash", { command: "cat ~/.ssh/id_test" }, context)).toBeUndefined();
});

test.skipIf(!POSIX)("links out of the project are refused; a link to a private place is private", () => {
  expect(classifyPath(path.join(project, "notes.md"), context, false)).toBe("linksOut");
  expect(fileToolGate("read", { path: "notes.md" }, context)).toBe("Not read: notes.md is a link to a place outside this project. Casper doesn't follow links out.");
  expect(fileToolGate("edit", { path: "notes.md", edits: [] }, context)).toBe("Not done: notes.md is a link to a place outside this project. Casper doesn't follow links out.");
  expect(fileToolGate("read", { path: "keys/id_test" }, context)).toContain("~/.ssh is private");
  expect(fileToolGate("grep", { pattern: "x", path: "keys" }, context)).toContain("~/.ssh is private");
});

test("git's own files can't be written by edit or write, but can be read", () => {
  expect(fileToolGate("write", { path: ".git/hooks/pre-commit", content: "x" }, context)).toBe("Not done: .git/hooks is git's own folder. Casper doesn't let the AI change it.");
  expect(fileToolGate("edit", { path: ".git/config", edits: [] }, context)).toBe("Not done: .git/config is git's own folder. Casper doesn't let the AI change it.");
  expect(fileToolGate("write", { path: "vendor/lib/.git", content: "gitdir: /tmp/x" }, context)).toContain(".git is git's own folder");
  expect(hooksPathTargets(project, home)).toEqual([path.join(project, ".githooks")]);
  expect(fileToolGate("write", { path: ".githooks/pre-push", content: "x" }, context)).toBe("Not done: .githooks is git's own folder. Casper doesn't let the AI change it.");
  expect(fileToolGate("read", { path: ".git/config" }, context)).toBeUndefined();
  expect(fileToolGate("write", { path: ".gitignore", content: "x" }, context)).toBeUndefined();
  expect(fileToolGate("write", { path: ".github/workflows/ci.yml", content: "x" }, context)).toBeUndefined();
});

test("a worktree's shared git folder counts as git's own", async () => {
  const main = path.join(root, "main-repo"); const tree = path.join(root, "tree");
  await mkdir(path.join(main, "gitdata/worktrees/tree"), { recursive: true }); await mkdir(tree, { recursive: true });
  await writeFile(path.join(tree, ".git"), `gitdir: ${path.join(main, "gitdata/worktrees/tree")}\n`);
  await writeFile(path.join(main, "gitdata/worktrees/tree/commondir"), "../..\n");
  const treeContext = { root: tree, home };
  expect(fileToolGate("write", { path: path.join(main, "gitdata/hooks/pre-commit"), content: "x" }, treeContext)).toContain("git's own folder");
});

test("shell start-up files, git settings and Casper's own folder can't be written", () => {
  for (const file of ["~/.bashrc", "~/.zshrc", "~/.profile", "~/.gitconfig", "~/.casper/security-approved.json", "~/.pi/agent/settings.json"]) {
    expect([file, fileToolGate("write", { path: file, content: "x" }, context)]).toEqual([file, expect.stringContaining("Casper doesn't let the AI change it.")]);
  }
  expect(fileToolGate("read", { path: "~/.bashrc" }, context)).toBeUndefined();
});

test("shell commands that write git hooks or risky git settings are refused; reads pass", () => {
  expect(gitInternalsCommand("echo x > .git/hooks/pre-commit", project, home)).toBe("Not run: this command changes .git/hooks, git's own files. Casper doesn't let the AI change them. Ask the user to run it.");
  expect(gitInternalsCommand("cp evil.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit", project, home)).toContain(".git/hooks");
  expect(gitInternalsCommand("tee .git/config < x", project, home)).toContain(".git/config");
  expect(gitInternalsCommand("cp x .githooks/pre-push", project, home)).toContain(".githooks");
  expect(gitInternalsCommand("git config core.hooksPath hooks", project, home)).toContain("`git config core.hooksPath` changes how git runs programs");
  expect(gitInternalsCommand("git config --local core.fsmonitor ./x", project, home)).toContain("core.fsmonitor");
  expect(gitInternalsCommand("git config alias.st '!sh -c evil'", project, home)).toContain("alias.st");
  expect(gitInternalsCommand("git config --global user.name bot", project, home)).toContain("your own git settings");
  for (const safe of ["cat .git/config", "ls -la .git/hooks", "git config --get core.hooksPath", "git config user.email a@b.c", "git log --oneline > log.txt", "git status"]) {
    expect([safe, gitInternalsCommand(safe, project, home)]).toEqual([safe, undefined]);
  }
});
