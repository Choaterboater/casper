import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crewShell } from "../src/crew/shell";
import { linuxSandboxProblem } from "../src/sandbox/linux";
import { ShellSandbox } from "../src/sandbox/manager";
import { runtimeEngine, type SandboxEngine } from "../src/sandbox/runtime";
import { SandboxStore } from "../src/sandbox/store";
import { needsSandbox } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function folders() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-crew-shell-")));
  cleanup.push(() => removeTempDir(base));
  const home = path.join(base, "home"), main = path.join(base, "main"), copy = path.join(base, "copy"), state = path.join(base, "state");
  for (const folder of [home, main, copy, state]) await mkdir(folder, { recursive: true });
  return { home, main, copy, store: new SandboxStore(state) };
}

test("a builder's sandbox is rooted at its copy and never asks: a write elsewhere is refused, not asked", async () => {
  const { home, main, copy, store } = await folders();
  const asked: string[] = [];
  const sandbox = new ShellSandbox({ root: () => main, home, store, tempDirs: [], askHost: (host) => { asked.push(host); return Promise.resolve("session"); },
    askWrite: (targets) => { asked.push(...targets); return Promise.resolve(true); } });
  const copySandbox = sandbox.forCopy(copy);
  cleanup.push(() => copySandbox.close());
  expect(copySandbox.root).toBe(copy);
  expect(await copySandbox.decideWrite(main, "ai")).toBe("cant-ask");
  const notes: string[] = [];
  const shell = crewShell(sandbox, copy, (line) => notes.push(line))!;
  cleanup.push(() => shell.close());
  expect(await shell.outsideWrite!(path.join(main, "a.txt"))).toMatch(/^Not done/);
  expect(await shell.approve!("ssh build-server uptime")).toContain("Not run");
  expect(notes.join("\n")).toContain("build-server");
  expect(asked).toEqual([]);
});

needsSandbox("in the real sandbox a builder's command writes in its copy and can't write in your folder", async () => {
  const { home, main, copy, store } = await folders();
  const sandbox = new ShellSandbox({ root: () => main, home, store, tempDirs: [], engine: runtimeEngine(),
    problem: () => process.platform === "linux" ? linuxSandboxProblem() : undefined });
  cleanup.push(() => sandbox.close());
  const shell = crewShell(sandbox, copy, () => {})!;
  cleanup.push(() => shell.close());
  const run = async (command: string) => {
    const wrapped = await shell.wrap(command, copy);
    try { return spawnSync("sh", ["-c", wrapped.command], { cwd: copy, encoding: "utf8" }); }
    finally { if (wrapped.id) shell.finished!(wrapped.id); }
  };
  expect((await run("echo ok > made.txt")).status).toBe(0);
  expect(await readFile(path.join(copy, "made.txt"), "utf8")).toBe("ok\n");
  expect((await run(`echo no > '${path.join(main, "evil.txt")}'`)).status).not.toBe(0);
  expect(existsSync(path.join(main, "evil.txt"))).toBe(false);
});

function recordingEngine() {
  const calls = { initialize: 0, reset: 0 };
  let ask: ((host: string, port: number | undefined) => Promise<boolean>) | undefined;
  const engine: SandboxEngine = {
    async initialize(_policy, given) { calls.initialize++; ask = given; },
    async wrap(command) { return command; },
    violations: () => [], finished() {}, setAllowedHosts() {},
    async reset() { calls.reset++; },
  };
  return { engine, calls, ask: (host: string) => ask!(host, 443) };
}

test("a builder's sandbox shares the session's runtime: one start, and closing the copy leaves the session's running", async () => {
  const { home, main, copy, store } = await folders();
  const fake = recordingEngine();
  const sandbox = new ShellSandbox({ root: () => main, home, store, tempDirs: [], engine: fake.engine, problem: () => undefined, platform: "darwin" });
  cleanup.push(() => sandbox.close());
  const copySandbox = sandbox.forCopy(copy);
  await copySandbox.wrap("true", { cwd: copy });
  await sandbox.wrap("true", { cwd: main });
  expect(fake.calls.initialize).toBe(1);
  await copySandbox.close();
  expect(fake.calls.reset).toBe(0);
  await sandbox.close();
  expect(fake.calls.reset).toBe(1);
});

test("while a builder's command runs, a host nobody allowed is refused, not asked (the proxy can't tell whose it is)", async () => {
  const { home, main, copy, store } = await folders();
  const fake = recordingEngine();
  const asked: string[] = [];
  const mainNotes: string[] = [], copyNotes: string[] = [];
  const sandbox = new ShellSandbox({ root: () => main, home, store, tempDirs: [], engine: fake.engine, problem: () => undefined, platform: "darwin",
    askHost: (host) => { asked.push(host); return Promise.resolve("once"); }, note: (line) => mainNotes.push(line) });
  cleanup.push(() => sandbox.close());
  const copySandbox = sandbox.forCopy(copy, (line) => copyNotes.push(line));
  cleanup.push(() => copySandbox.close());
  const run = await copySandbox.wrap("curl https://example.org", { cwd: copy });
  expect(await fake.ask("example.org")).toBe(false);
  expect(asked).toEqual([]);
  expect(copyNotes.join("\n")).toContain("example.org");
  copySandbox.finished(run.id);
  expect(await fake.ask("example.org")).toBe(true);
  expect(asked).toEqual(["example.org"]);
});

test("a builder's sandbox keeps your private paths private and can't write the shared git folder", async () => {
  const { home, main, copy, store } = await folders();
  await mkdir(path.join(main, ".git", "worktrees", "copy"), { recursive: true });
  await writeFile(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(path.join(main, ".git", "worktrees", "copy", "commondir"), "../..\n");
  await writeFile(path.join(copy, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "copy")}\n`);
  const sandbox = new ShellSandbox({ root: () => main, home, store, tempDirs: [], settings: { project: { denyRead: ["secret.txt"] } } });
  const policy = sandbox.forCopy(copy).policy();
  expect(policy.denyRead).toContain(path.join(main, "secret.txt"));
  expect(policy.denyRead).toContain(path.join(copy, "secret.txt"));
  expect(policy.allowWrite).toContain(path.join(main, ".git", "worktrees", "copy"));
  expect(policy.allowWrite).not.toContain(path.join(main, ".git"));
  for (const shared of ["refs", "packed-refs", "HEAD", "objects"]) expect(policy.denyWrite).toContain(path.join(main, ".git", shared));
  // Your own session still writes its git folder.
  expect(sandbox.policy().allowWrite).toContain(main);
});

needsSandbox("in the real sandbox, closing a builder's shell leaves the session's proxy running", async () => {
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  const { home, main, copy, store } = await folders();
  const sandbox = new ShellSandbox({ root: () => main, home, store, tempDirs: [], engine: runtimeEngine(),
    problem: () => process.platform === "linux" ? linuxSandboxProblem() : undefined });
  cleanup.push(() => sandbox.close());
  const before = await sandbox.wrap("true", { cwd: main });
  sandbox.finished(before.id);
  const port = SandboxManager.getProxyPort();
  expect(port).toBeDefined();
  const shell = crewShell(sandbox, copy, () => {})!;
  const wrapped = await shell.wrap("true", copy);
  expect(spawnSync("sh", ["-c", wrapped.command], { cwd: copy }).status).toBe(0);
  shell.finished!(wrapped.id!);
  await shell.close();
  expect(SandboxManager.getProxyPort()).toBe(port);
  const after = await sandbox.wrap("true", { cwd: main });
  expect(spawnSync("sh", ["-c", after.command], { cwd: main }).status).toBe(0);
  sandbox.finished(after.id);
});

needsSandbox("in the real sandbox a builder can't read your private file in your folder, nor move your branches", async () => {
  const { home, main, store } = await folders();
  const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  git(main, "init", "-b", "main");
  for (const [key, value] of [["user.name", "Casper Test"], ["user.email", "casper@example.invalid"]]) git(main, "config", key!, value!);
  await writeFile(path.join(main, "a.txt"), "one\n");
  git(main, "add", "-A"); git(main, "commit", "-m", "one");
  await writeFile(path.join(main, "a.txt"), "two\n");
  git(main, "commit", "-am", "two");
  await writeFile(path.join(main, "secret.txt"), "TOPSECRET\n");
  const copy = path.join(home, "copy");
  expect(git(main, "worktree", "add", "-b", "casper/crew-abc123-1", copy).status).toBe(0);
  const head = git(main, "rev-parse", "main").stdout.trim();
  const sandbox = new ShellSandbox({ root: () => main, home, store, tempDirs: [], engine: runtimeEngine(), settings: { project: { denyRead: ["secret.txt"] } },
    problem: () => process.platform === "linux" ? linuxSandboxProblem() : undefined });
  cleanup.push(() => sandbox.close());
  const shell = crewShell(sandbox, copy, () => {})!;
  cleanup.push(() => shell.close());
  const run = async (command: string) => {
    const wrapped = await shell.wrap(command, copy);
    try { return spawnSync("sh", ["-c", wrapped.command], { cwd: copy, encoding: "utf8" }); }
    finally { if (wrapped.id) shell.finished!(wrapped.id); }
  };
  expect((await run(`cat '${path.join(main, "secret.txt")}'`)).stdout).not.toContain("TOPSECRET");
  expect((await run("git update-ref refs/heads/main HEAD~1")).status).not.toBe(0);
  expect((await run("git status --short")).status).toBe(0);
  expect(git(main, "rev-parse", "main").stdout.trim()).toBe(head);
});
