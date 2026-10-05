import { afterAll, beforeAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyPath, fileToolGate, gitInternalsCommand, hooksPathTargets, PRIVATE_PATHS, privatePathCommand } from "../src/platform/project-paths";
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
  expect(fileToolGate("write", { path: ".git/hooks/pre-commit", content: "x" }, context)).toBe("Not done: .git/hooks belongs to git itself. Casper doesn't let the AI change it.");
  expect(fileToolGate("edit", { path: ".git/config", edits: [] }, context)).toBe("Not done: .git/config belongs to git itself. Casper doesn't let the AI change it.");
  expect(fileToolGate("write", { path: "vendor/lib/.git", content: "gitdir: /tmp/x" }, context)).toContain(".git belongs to git itself");
  expect(hooksPathTargets(project, home)).toEqual([path.join(project, ".githooks")]);
  expect(fileToolGate("write", { path: ".githooks/pre-push", content: "x" }, context)).toBe("Not done: .githooks belongs to git itself. Casper doesn't let the AI change it.");
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
  expect(fileToolGate("write", { path: path.join(main, "gitdata/hooks/pre-commit"), content: "x" }, treeContext)).toContain("belongs to git itself");
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
  // Quotes, a full path to git, git inside sh -c, a read flag hidden in the value and cd into .git don't get past it.
  for (const risky of [`git config "core.hooksPath" /tmp/h`, `git config 'alias.x' '!sh evil'`, `sh -c "git config core.hooksPath /tmp/h"`,
    "/usr/bin/git config core.hooksPath /tmp/h", `git config core.hooksPath "/tmp/x -l "`, `git config alias.x "!sh --list "`,
    "git --git-dir .git config core.hooksPath /tmp/h", "git config set pager.log ./x", "git config --edit", "cd .git && echo x > hooks/pre-commit"]) {
    expect([risky, gitInternalsCommand(risky, project, home)]).toEqual([risky, expect.stringMatching(/^Not run:/)]);
  }
  for (const safe of ["cat .git/config", "ls -la .git/hooks", "git config --get core.hooksPath", "git config --global --get user.name", "git config user.email a@b.c", "cat .gitignore > x", "git log --oneline > log.txt", "git status"]) {
    expect([safe, gitInternalsCommand(safe, project, home)]).toEqual([safe, undefined]);
  }
});

test("a session in Casper's own worktree folder can still edit its project files", async () => {
  const tree = path.join(home, ".casper/worktrees/abc123/fix-login");
  await mkdir(path.join(tree, "src"), { recursive: true });
  const treeContext = { root: tree, home };
  expect(fileToolGate("write", { path: "src/a.ts", content: "x" }, treeContext)).toBeUndefined();
  expect(fileToolGate("edit", { path: path.join(tree, "src/a.ts"), edits: [] }, treeContext)).toBeUndefined();
  // The rest of ~/.casper stays off limits from there.
  expect(fileToolGate("write", { path: "~/.casper/settings.json", content: "x" }, treeContext)).toContain("Casper doesn't let the AI change it.");
  expect(fileToolGate("write", { path: "../other/src/a.ts", content: "x" }, treeContext)).toContain("Casper doesn't let the AI change it.");
});

test("a shell command that names ~/.ssh or another private place is refused, even with no sandbox", () => {
  for (const command of ["cat ~/.ssh/config", "grep -i hostname $HOME/.ssh/config", "cat \"$HOME/.ssh/id_test\"", "ls ${HOME}/.aws",
    `cat ${home}/.ssh/config`, "cd ~ && cat .ssh/config", "cp ~/.netrc /tmp/x", "tar czf k.tgz ~/.ssh",
    // -i is ssh's key file only for ssh: for diff, less or xxd it is a flag, and the next word is read.
    "diff -i ~/.ssh/config /dev/null", "less -i ~/.ssh/config", "xxd -i ~/.ssh/id_test", "echo ssh; diff -i ~/.ssh/config x"]) {
    expect([command, privatePathCommand(command, context)]).toEqual([command, expect.stringMatching(/^Not run: this command reads ~\/\.(ssh|aws|netrc), which is private \(keys and logins\)\./)]);
  }
  // ssh's own key file is read by ssh, not shown to the AI; other commands and names pass.
  for (const command of ["ssh -i ~/.ssh/lab_key root@10.0.0.5 uptime", "scp -o IdentityFile=~/.ssh/lab app.py build-server:/opt/", "ssh build-server uptime",
    "ssh -i ~/.ssh/a -i ~/.ssh/b build-server uptime", "sudo ssh -i ~/.ssh/lab root@10.0.0.5 id",
    "cat ./ssh/config", "ls ~/Projects", "echo .sshrc", "cat notes/.ssh-hosts.md"]) {
    expect([command, privatePathCommand(command, context)]).toEqual([command, undefined]);
  }
});

test("a shell command that reaches ~/.ssh by .., cd, ~user, quotes, a glob or a whole-home copy is refused too", () => {
  // Casper open in ~/Documents.
  const documents = { ...context, root: path.join(home, "Documents") };
  for (const command of ["cat ../.ssh/config", "cd .. && cat .ssh/config", "cd; cat .ssh/config", `cat ~${path.basename(home)}/.ssh/config`,
    "cat ~/'.ssh'/config", "cat ~/\".ssh/config\"", "cat ~/.ss*/config", "cat ~/.s?h/id_test", "cat ~/.ssh/../.ssh/config",
    "grep -r HostName ~", "grep -R HostName ..", "tar czf /tmp/home.tgz ~", "rsync -a ~/ backup:/home/", "cp -r ~ /tmp/copy",
    "ssh -G build-server", "ssh -vG build-server", "bash -c 'cat ../.ssh/config'"]) {
    expect([command, privatePathCommand(command, documents)]).toEqual([command, expect.stringMatching(/^Not run: this command reads ~\/\.ssh/)]);
  }
  // Windows names ignore case, so ~/.SS* reaches ~/.ssh there, the same way ~/.SSH/config does.
  if (process.platform === "win32") {
    for (const command of ["cat ~/.SS*/config", "cat ~/.S?H/config"]) {
      expect([command, privatePathCommand(command, documents)]).toEqual([command, expect.stringMatching(/^Not run: this command reads ~\/\.ssh/)]);
    }
  }
  // Ordinary work next to it passes: the folder's own files, a sibling, a listing of home, ssh itself.
  for (const command of ["cat ../Projects/readme.md", "ls ..", "ls ~", "grep -r TODO .", "find ~ -name '*.md'", "cat ~/.config/*.toml",
    "cd sample-tools && python3 -m unittest discover -s tests", "ssh -v build-server uptime", "cat ~/.ssh.bak.md", "cat ~/*/config"]) {
    expect([command, privatePathCommand(command, documents)]).toEqual([command, undefined]);
  }
});

test("a project's sandbox.denyRead is private to the file tools too, not only to shell commands", () => {
  const logs = path.join(root, "outside");
  const denied = { ...context, denyRead: [logs] };
  expect(fileToolGate("read", { path: path.join(logs, "secret.txt") }, denied)).toContain("is private");
  expect(fileToolGate("grep", { pattern: "x", path: root }, denied)).toContain("holds private files");
  expect(fileToolGate("read", { path: path.join(logs, "secret.txt") }, context)).toBeUndefined();
});

test("review: a denyRead folder inside the project blocks reads of it, not a search of the project", async () => {
  await mkdir(path.join(project, "secrets"), { recursive: true });
  const denied = { ...context, denyRead: [path.join(project, "secrets")] };
  expect(fileToolGate("read", { path: "secrets/key.pem" }, denied)).toContain("this project's sandbox.denyRead");
  expect(fileToolGate("grep", { pattern: "x" }, denied)).toBeUndefined();
  expect(privatePathCommand("grep -r foo .", denied)).toBeUndefined();
  expect(privatePathCommand("cat secrets/key.pem", denied)).toContain("private");
});

/** The 8.3 short name Windows keeps for a long folder name, or undefined where there is none (8.3 names off, or
 * not Windows). A user folder like C:\Users\runneradmin is also C:\Users\RUNNER~1, and TEMP often uses that form. */
function shortName(folder: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const run = Bun.spawnSync(["cmd", "/d", "/s", "/c", `"for %I in ("${folder}") do @echo %~sI"`], { stdout: "pipe", stderr: "ignore", windowsVerbatimArguments: true });
  const short = run.stdout.toString().trim();
  return run.exitCode === 0 && short && short.toLowerCase() !== folder.toLowerCase() ? short : undefined;
}
const shortHome = await (async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "casper-long-home-folder-"));
  try { return shortName(realpathSync.native(folder)); } finally { await rm(folder, { recursive: true, force: true }); }
})();

test.skipIf(!shortHome)("a private place named by its Windows 8.3 short name is still private", async () => {
  const userHome = path.join(realpathSync.native(root), "long user name");
  await mkdir(path.join(userHome, ".ssh"), { recursive: true });
  await writeFile(path.join(userHome, ".ssh/id_test"), "key");
  const short = shortName(userHome)!;
  expect(short).not.toBe(userHome);
  const named = { ...context, home: userHome };
  for (const key of [path.join(userHome, ".ssh/id_test"), path.join(short, ".ssh/id_test"), path.join(short, ".ssh")]) {
    expect([key, classifyPath(key, named, false)]).toEqual([key, "private"]);
    expect(fileToolGate("read", { path: key }, named)).toBe("Not read: ~/.ssh is private (keys and logins). Casper keeps it from the AI.");
  }
  // And a project named by its short name is the same project.
  const shortProject = shortName(realpathSync.native(project))!;
  expect(classifyPath(path.join(shortProject, "src/a.ts"), { ...context, root: realpathSync.native(project) }, true)).toBe("inside");
});
