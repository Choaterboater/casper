import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SAFE_DEFAULT_POLICY } from "../src/config/load";
import type { RuntimeEventListener, RuntimeForkOptions, RuntimeSession, RuntimeSessionInfo, RuntimeSwitchOptions } from "../src/runtime/types";
import { SessionWorkspaceManager } from "../src/sessions/manager";
import { cleanEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", env: cleanEnv() });
  return String(stdout);
}

const isLink = async (file: string) => (await lstat(file).catch(() => undefined))?.isSymbolicLink() ?? false;

/** A repository whose main folder has installed (ignored) node_modules and .venv, as a JS or Python project does. */
async function project(ignore: string): Promise<{ home: string; repo: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-branch-deps-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  await mkdir(home);
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "core.autocrlf", "false");
  await git(repo, "config", "user.name", "Casper Test");
  await git(repo, "config", "user.email", "casper@example.invalid");
  await writeFile(path.join(repo, "tracked.txt"), "base\n");
  await writeFile(path.join(repo, ".gitignore"), ignore);
  await git(repo, "add", "tracked.txt", ".gitignore");
  await git(repo, "commit", "-m", "base");
  await mkdir(path.join(repo, "node_modules", "left-pad"), { recursive: true });
  await writeFile(path.join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  await mkdir(path.join(repo, ".venv"));
  await writeFile(path.join(repo, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
  return { home, repo };
}

class ForkingSession implements RuntimeSession {
  private serial = 1;
  private info: RuntimeSessionInfo;
  readonly contexts: string[] = [];

  constructor(private readonly folder: string, cwd: string, sessionFile: string) {
    this.info = { cwd, sessionId: "fake-main", sessionFile, name: "main" };
  }

  getSessionInfo = (): RuntimeSessionInfo => ({ ...this.info });
  forkSession = async (options: RuntimeForkOptions): Promise<RuntimeSessionInfo> => {
    const sessionFile = path.join(this.folder, `${options.name}-${this.serial++}.jsonl`);
    await writeFile(sessionFile, await readFile(this.info.sessionFile));
    this.info = { cwd: options.cwd, sessionId: `fake-${this.serial}`, sessionFile, name: options.name };
    if (options.context) this.contexts.push(options.context);
    return this.getSessionInfo();
  };
  switchSession = async (options: RuntimeSwitchOptions): Promise<RuntimeSessionInfo> => {
    await access(options.sessionFile);
    this.info = { cwd: options.cwd, sessionId: `fake-${this.serial++}`, sessionFile: options.sessionFile };
    return this.getSessionInfo();
  };
  appendContext = async (text: string): Promise<void> => { this.contexts.push(text); };
  setTools = (): void => {};
  prompt = async (): Promise<void> => {};
  abort = async (): Promise<void> => {};
  subscribe = (_listener: RuntimeEventListener): (() => void) => () => {};
  getState = () => ({ cwd: this.info.cwd, isStreaming: false });
}

async function start(ignore: string) {
  const { home, repo } = await project(ignore);
  const file = path.join(home, "main.jsonl");
  await writeFile(file, "main");
  const runtime = new ForkingSession(home, repo, file);
  const manager = await SessionWorkspaceManager.open({ projectRoot: repo, gitBranch: "main", homeDir: home, policy: SAFE_DEFAULT_POLICY.workspace });
  return { home, repo, runtime, manager };
}

// `node_modules/` (a folder pattern) does not match a link, so a left link would be an untracked file in the patch;
// `node_modules` does match it, and an ignored file makes the return refuse. Both are common.
const IGNORES = ["node_modules/\n.venv/\n", "node_modules\n.venv\n"];

describe("/branch experiments and the project's dependency folders", () => {
  test("a branch links the main folder's dependency folders and tells its AI they are shared", async () => {
    const { repo, runtime, manager } = await start(IGNORES[0]!);
    const previews: string[] = [];
    const child = await manager.branch("deps", { getRuntime: async () => runtime, confirm: async (preview) => { previews.push(preview); return true; }, context: "branch context" });
    expect(child?.linked).toEqual(["node_modules", ".venv"]);
    expect(previews[0]).toContain("dependency folders: node_modules, .venv");
    expect(await isLink(path.join(child!.workspacePath, "node_modules"))).toBe(true);
    expect(await readFile(path.join(child!.workspacePath, "node_modules", "left-pad", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    const context = runtime.contexts.at(-1)!;
    expect(context.startsWith("branch context\n\n")).toBe(true);
    expect(context).toContain("Linked from the main folder, not copied: node_modules, .venv.");
    expect(context).toContain("`rm node_modules`, no trailing slash");
    expect(await isLink(path.join(repo, "node_modules"))).toBe(false);
  });

  test("a main folder with no dependency folders links nothing and adds no note", async () => {
    const { home, repo } = await project("node_modules/\n");
    await removeTempDir(path.join(repo, "node_modules"));
    await removeTempDir(path.join(repo, ".venv"));
    const file = path.join(home, "main.jsonl");
    await writeFile(file, "main");
    const runtime = new ForkingSession(home, repo, file);
    const manager = await SessionWorkspaceManager.open({ projectRoot: repo, gitBranch: "main", homeDir: home, policy: SAFE_DEFAULT_POLICY.workspace });
    const previews: string[] = [];
    const child = await manager.branch("plain", { getRuntime: async () => runtime, confirm: async (preview) => { previews.push(preview); return true; }, context: "branch context" });
    expect(child?.linked).toBeUndefined();
    expect(previews[0]).not.toContain("dependency folders");
    expect(runtime.contexts.at(-1)).toBe("branch context");
  });

  for (const ignore of IGNORES) {
    test(`apply checks with the links in place, then applies a patch without them (${JSON.stringify(ignore.split("\n")[0])})`, async () => {
      const { repo, runtime, manager } = await start(ignore);
      const child = await manager.branch("apply-deps", { getRuntime: async () => runtime, confirm: async () => true });
      await writeFile(path.join(child!.workspacePath, "tracked.txt"), "candidate\n");
      let checkedWithDependencies = false;
      const previews: string[] = [];
      const result = await manager.returnToMain("apply", {
        getRuntime: async () => runtime,
        confirm: async (preview) => { previews.push(preview); return true; },
        verify: async (cwd) => {
          checkedWithDependencies = await isLink(path.join(cwd, "node_modules")) && await isLink(path.join(cwd, ".venv"));
          return "pass";
        },
      });
      expect(checkedWithDependencies).toBe(true);
      expect(result?.cleanupWarning).toBeUndefined();
      expect(previews[0]).toContain('changed files (1): ["tracked.txt"]');
      expect(previews[0]).not.toContain("node_modules");
      expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("candidate\n");
      expect(await git(repo, "status", "--porcelain", "--untracked-files=all")).toBe(" M tracked.txt\n");
      expect(await readFile(path.join(repo, "node_modules", "left-pad", "index.js"), "utf8")).toBe("module.exports = 1;\n");
      expect(await readFile(path.join(repo, ".venv", "pyvenv.cfg"), "utf8")).toBe("home = /usr/bin\n");
      expect(await isLink(path.join(result!.preservedPath!, "node_modules"))).toBe(false);
    }, 30_000);

    test(`discard drops the experiment and leaves the main folder's dependencies whole (${JSON.stringify(ignore.split("\n")[0])})`, async () => {
      const { repo, runtime, manager } = await start(ignore);
      const child = await manager.branch("discard-deps", { getRuntime: async () => runtime, confirm: async () => true });
      await writeFile(path.join(child!.workspacePath, "new.txt"), "throwaway\n");
      const previews: string[] = [];
      const result = await manager.returnToMain("discard", {
        getRuntime: async () => runtime,
        confirm: async (preview) => { previews.push(preview); return true; },
        verify: async () => { throw new Error("discard runs no checks"); },
      });
      expect(result?.cleanupWarning).toBeUndefined();
      expect(previews[0]).toContain('changed files (1): ["new.txt"]');
      expect(previews[0]).not.toContain("node_modules");
      await expect(access(child!.workspacePath)).rejects.toThrow();
      expect(await isLink(path.join(result!.preservedPath!, "node_modules"))).toBe(false);
      expect(await readFile(path.join(repo, "node_modules", "left-pad", "index.js"), "utf8")).toBe("module.exports = 1;\n");
      expect(await readFile(path.join(repo, ".venv", "pyvenv.cfg"), "utf8")).toBe("home = /usr/bin\n");
      expect(await git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
    }, 30_000);
  }

  test("a branch that fails to open takes its links out first, so its worktree goes and the main folder's dependencies stay", async () => {
    // With `node_modules/` a left link is an untracked file, and removal refuses a worktree that has one.
    const { repo, runtime, manager } = await start(IGNORES[0]!);
    runtime.forkSession = async () => { throw new Error("fork failed"); };
    const previews: string[] = [];
    await expect(manager.branch("broken", { getRuntime: async () => runtime, confirm: async (preview) => { previews.push(preview); return true; } }))
      .rejects.toThrow("fork failed");
    const planned = /new worktree: (.+)/.exec(previews[0]!)![1]!;
    await expect(access(planned)).rejects.toThrow();
    expect((await git(repo, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
    expect(await readFile(path.join(repo, "node_modules", "left-pad", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(await readFile(path.join(repo, ".venv", "pyvenv.cfg"), "utf8")).toBe("home = /usr/bin\n");
  }, 30_000);

  // Git on Windows checks a tracked link out as a plain file unless symlinks are turned on.
  test.skipIf(process.platform === "win32")("a dependency link the repository tracks is never taken out, so the patch never deletes it", async () => {
    const { repo, runtime, manager } = await start(IGNORES[0]!);
    await mkdir(path.join(repo, "third"));
    await writeFile(path.join(repo, "third", "lib.txt"), "third party\n");
    await symlink("third", path.join(repo, "vendor"));
    await git(repo, "add", "third/lib.txt", "vendor");
    await git(repo, "commit", "-m", "vendored link");
    const child = await manager.branch("tracked-link", { getRuntime: async () => runtime, confirm: async () => true });
    expect(child?.linked).toEqual(["node_modules", ".venv"]);
    // Declined: the tracked link is still there, as Git checked it out.
    expect(await manager.returnToMain("discard", { getRuntime: async () => runtime, confirm: async () => false, verify: async () => "pass" })).toBeUndefined();
    expect(await readlink(path.join(child!.workspacePath, "vendor"))).toBe("third");
    expect(await git(child!.workspacePath, "status", "--porcelain", "--untracked-files=no")).toBe("");
    await writeFile(path.join(child!.workspacePath, "tracked.txt"), "candidate\n");
    const previews: string[] = [];
    const result = await manager.returnToMain("apply", {
      getRuntime: async () => runtime, confirm: async (preview) => { previews.push(preview); return true; }, verify: async () => "pass",
    });
    expect(result?.cleanupWarning).toBeUndefined();
    expect(previews[0]).toContain('changed files (1): ["tracked.txt"]');
    expect(await readlink(path.join(repo, "vendor"))).toBe("third");
    expect(await git(repo, "status", "--porcelain", "--untracked-files=all")).toBe(" M tracked.txt\n");
  }, 30_000);

  test("a return that is not approved puts the links back so the branch keeps working", async () => {
    const { runtime, manager } = await start(IGNORES[1]!);
    const child = await manager.branch("declined", { getRuntime: async () => runtime, confirm: async () => true });
    const declined = await manager.returnToMain("discard", { getRuntime: async () => runtime, confirm: async () => false, verify: async () => "pass" });
    expect(declined).toBeUndefined();
    expect(await isLink(path.join(child!.workspacePath, "node_modules"))).toBe(true);
    expect(await isLink(path.join(child!.workspacePath, ".venv"))).toBe(true);
    // A return that stops after the yes (the runtime cannot start, say) leaves you on the branch, links in place.
    await expect(manager.returnToMain("discard", {
      getRuntime: async () => { throw new Error("runtime unavailable"); }, confirm: async () => true, verify: async () => "pass",
    })).rejects.toThrow("runtime unavailable");
    expect(manager.activeName).toBe("declined");
    expect(await isLink(path.join(child!.workspacePath, "node_modules"))).toBe(true);
  });
});
