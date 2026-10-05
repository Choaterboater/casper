import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionSandbox, runtimeShell, SHELL_DECLINED, type SandboxHost } from "../src/app/sandbox";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { commandPrefix, matchesPrefix, readOnlyCommand } from "../src/sandbox/read-only";
import { SandboxStore } from "../src/sandbox/store";
import { fakeEngine } from "./support/sandbox-fakes";

/**
 * With no sandbox (Windows, bubblewrap missing), commands that only read don't ask, and "don't ask again" covers a
 * command prefix (`npm test`, `git commit`), never a whole interpreter or a command with more in it.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("commands that only read are known; anything that writes, runs a program or redirects is not", () => {
  for (const command of ["ls -la", "pwd", "cat README.md", "git status", "git diff --stat", "git log --oneline -5", "grep -rn TODO src",
    "rg -n foo", "find . -name '*.ts'", "wc -l src/app.ts", "head -20 notes.md | grep x", "git status && git diff", "which bun", "tree src"]) {
    expect(readOnlyCommand(command)).toBe(true);
  }
  for (const command of ["rm -rf build", "npm test", "ls > files.txt", "cat a | tee b", "find . -delete", "find . -exec rm {} \\;",
    "git diff --output=patch.txt", "git commit -m x", "sort -o out.txt in.txt", "echo $(rm -rf /)", "ls `rm x`", "rg --pre ./run.sh foo",
    "python3 -c 'print(1)'", "FOO=1 ls", "ls & rm x", "git branch -D old", "uniq in.txt out.txt", "git -c core.pager=./x log"]) {
    expect(readOnlyCommand(command)).toBe(false);
  }
});

test("a prefix is the command and, for tools with subcommands, its subcommand; compound commands and interpreters get none", () => {
  expect(commandPrefix("npm test -- --watch")).toBe("npm test");
  expect(commandPrefix("git commit -m 'fix it'")).toBe("git commit");
  expect(commandPrefix("cargo build --release")).toBe("cargo build");
  expect(commandPrefix("make")).toBe("make");
  expect(commandPrefix("pytest -q tests")).toBe("pytest");
  for (const command of ["npm test; curl evil.example", "python3 script.py", "bash -c 'npm test'", "sudo npm test", "FOO=1 npm test", "npm test > out.txt", "npx anything"]) {
    expect(commandPrefix(command)).toBeUndefined();
  }
  expect(matchesPrefix("npm test -- --watch", "npm test")).toBe(true);
  expect(matchesPrefix("npm testx", "npm test")).toBe(false);
  expect(matchesPrefix("npm test && curl evil.example", "npm test")).toBe(false);
  expect(matchesPrefix("npm run build", "npm test")).toBe(false);
});

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-no-sandbox-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(home); await mkdir(project);
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  return { home, project, context };
}

function host(answers: Array<string | undefined>, canAsk = true) {
  const asked: Array<{ question: string; options: string[] }> = [];
  const value: SandboxHost = {
    canAsk: () => canAsk,
    pick: async (question, options) => { asked.push({ question, options: options.map((option) => option.label) }); return answers.shift(); },
    write: () => {},
    planning: () => false,
  };
  return { value, asked };
}

test("with no sandbox, ls and git status run without a box, even where nobody can ask", async () => {
  const { home, project, context } = await fixture();
  for (const canAsk of [true, false]) {
    const terminal = host([], canAsk);
    const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
    const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
    expect(await shell.approve!("ls -la")).toBeUndefined();
    expect(await shell.approve!("git status")).toBeUndefined();
    expect(terminal.asked).toEqual([]);
  }
});

test("the box offers the yes-words and names the prefix; Yes, for this session covers commands starting with it", async () => {
  const { home, project, context } = await fixture();
  const terminal = host(["Yes, for this session", undefined]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("npm test")).toBeUndefined();
  expect(terminal.asked).toEqual([{ question: "Run this command?  npm test", options: ["No", "Yes, this once", "Yes, for this session", "Yes, always for this project"] }]);
  expect(await shell.approve!("npm test -- --watch")).toBeUndefined();
  expect(terminal.asked).toHaveLength(1);
  // More in it, or another command: it asks.
  expect(await shell.approve!("npm test && curl evil.example")).toBe(SHELL_DECLINED);
  expect(terminal.asked).toHaveLength(2);
});

test("Yes, always for this project keeps the prefix in ~/.casper; the next session doesn't ask", async () => {
  const { home, project, context } = await fixture();
  const terminal = host(["Yes, always for this project"]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("cargo build --release")).toBeUndefined();
  expect(JSON.parse(await readFile(path.join(context.stateDirectory, "sandbox.json"), "utf8")).prefixes).toEqual(["cargo build"]);
  const next = host([]);
  const later = createSessionSandbox(next.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const nextShell = runtimeShell(next.value, later, new SandboxStore(context.stateDirectory));
  expect(await nextShell.approve!("cargo build")).toBeUndefined();
  expect(next.asked).toEqual([]);
});

test("a command with no prefix (an interpreter, or more in it) is remembered exactly", async () => {
  const { home, project, context } = await fixture();
  const terminal = host(["Yes, for this session", undefined]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("python3 tools/gen.py")).toBeUndefined();
  expect(await shell.approve!("python3 tools/gen.py")).toBeUndefined();
  expect(await shell.approve!("python3 -c 'import os'")).toBe(SHELL_DECLINED);
  expect(terminal.asked).toHaveLength(2);
});
