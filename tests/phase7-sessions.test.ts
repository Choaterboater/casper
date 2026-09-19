import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CasperApp } from "../src/app";
import { loadConfiguration, SAFE_DEFAULT_POLICY } from "../src/config/load";
import { loadProjectContext } from "../src/project/context";
import type {
  AgentRuntime,
  RuntimeEventListener,
  RuntimeForkOptions,
  RuntimeSession,
  RuntimeSessionInfo,
  RuntimeStartOptions,
  RuntimeSwitchOptions,
} from "../src/runtime/types";
import { SessionWorkspaceManager } from "../src/sessions/manager";
import { SessionBranchStore, sessionProjectKey, type NamedSessionBranch } from "../src/sessions/store";
import { SkillRegistry } from "../src/skills/registry";
import { GitWorktreeManager } from "../src/workspace/worktree";

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return String(stdout);
}

async function repository(prefix = "casper-phase7-repo-"): Promise<{ home: string; repo: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  await mkdir(home);
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Casper Test");
  await git(repo, "config", "user.email", "casper@example.invalid");
  await writeFile(path.join(repo, "tracked.txt"), "base\n");
  await writeFile(path.join(repo, ".gitignore"), "secret.env\n");
  await git(repo, "add", "tracked.txt", ".gitignore");
  await git(repo, "commit", "-m", "base");
  return { home, repo };
}

class BranchRuntimeSession implements RuntimeSession {
  private serial = 1;
  private info: RuntimeSessionInfo;
  readonly contexts: string[] = [];

  constructor(private readonly sessionDirectory: string, cwd: string, sessionFile: string) {
    this.info = { cwd, sessionId: "fake-main", sessionFile, name: "main" };
  }

  getSessionInfo = (): RuntimeSessionInfo => ({ ...this.info });

  forkSession = async (options: RuntimeForkOptions): Promise<RuntimeSessionInfo> => {
    const sessionFile = path.join(this.sessionDirectory, `${options.name}-${this.serial++}.jsonl`);
    await writeFile(sessionFile, await readFile(this.info.sessionFile));
    this.info = { cwd: options.cwd, sessionId: `fake-${this.serial}`, sessionFile, name: options.name };
    if (options.context) this.contexts.push(options.context);
    return this.getSessionInfo();
  };

  switchSession = async (options: RuntimeSwitchOptions): Promise<RuntimeSessionInfo> => {
    await access(options.sessionFile);
    this.info = { cwd: options.cwd, sessionId: `fake-${this.serial++}`, sessionFile: options.sessionFile };
    if (options.context) this.contexts.push(options.context);
    return this.getSessionInfo();
  };

  appendContext = async (text: string): Promise<void> => { this.contexts.push(text); };
  setTools = (): void => {};
  prompt = async (): Promise<void> => {};
  abort = async (): Promise<void> => {};
  subscribe = (_listener: RuntimeEventListener): (() => void) => () => {};
  getState = () => ({ cwd: this.info.cwd, isStreaming: false });
}

class BranchRuntime implements AgentRuntime {
  starts = 0;
  constructor(readonly session: BranchRuntimeSession) {}
  async start(_options: RuntimeStartOptions): Promise<RuntimeSession> { this.starts++; return this.session; }
  async dispose(): Promise<void> {}
}

describe("Phase 7 sessions and worktrees", () => {
  test("review regression: concurrent same-name creation preserves the winner", async () => {
    const { home, repo } = await repository();
    const manager = (await GitWorktreeManager.open(repo, home))!;
    const plan = await manager.plan("competing", repo);
    const results = await Promise.allSettled([manager.create(plan), manager.create(plan)]);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    await access(plan.path);
    expect((await git(repo, "branch", "--list", plan.branch)).trim()).not.toBe("");
    await manager.remove(plan);
  });

  test("review regression: changes after cleanup snapshot survive in a recovery directory", async () => {
    for (const lateFile of ["late.txt", "secret.env"]) {
      const { home, repo } = await repository();
      const manager = (await GitWorktreeManager.open(repo, home))!;
      const relation = await manager.create(await manager.plan("late-cleanup", repo));
      await writeFile(path.join(relation.path, "tracked.txt"), "reviewed content\n");
      const patch = await manager.capturePatch(relation);
      const capture = manager.capturePatch.bind(manager);
      manager.capturePatch = async (candidate) => {
        const captured = await capture(candidate);
        await writeFile(path.join(relation.path, lateFile), "must survive a stale cleanup snapshot");
        return captured;
      };
      const preserved = await manager.remove(relation, patch);
      expect(preserved).toBeDefined();
      expect(await readFile(path.join(preserved!, lateFile), "utf8")).toContain("must survive");
      expect((await git(repo, "branch", "--list", relation.branch)).trim()).toBe("");
    }
  });

  test("review follow-up: cleanup preserves unrelated missing worktree registration and index", async () => {
    const { home, repo } = await repository();
    const other = path.join(home, "other"); const moved = path.join(home, "offline");
    await git(repo, "worktree", "add", "-b", "unrelated", other);
    await writeFile(path.join(other, "staged.txt"), "preserve staging"); await git(other, "add", "staged.txt");
    const admin = (await git(other, "rev-parse", "--absolute-git-dir")).trim();
    const index = await readFile(path.join(admin, "index")); await rename(other, moved);
    const manager = (await GitWorktreeManager.open(repo, home))!;
    const relation = await manager.create(await manager.plan("owned", repo));
    await manager.remove(relation, await manager.capturePatch(relation));
    expect(await readFile(path.join(admin, "index"))).toEqual(index);
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain("refs/heads/unrelated");
    await rename(moved, other);
    expect(await git(other, "status", "--porcelain")).toContain("A  staged.txt");
  });

  test("review final: redirected candidate git pointer cannot unregister another worktree", async () => {
    const { home, repo } = await repository();
    const other = path.join(home, "unrelated");
    await git(repo, "worktree", "add", "-b", "unrelated", other);
    await writeFile(path.join(other, "staged.txt"), "preserve index"); await git(other, "add", "staged.txt");
    const pointer = await readFile(path.join(other, ".git"));
    const admin = (await git(other, "rev-parse", "--absolute-git-dir")).trim();
    const index = await readFile(path.join(admin, "index"));
    await rename(other, path.join(home, "offline"));
    const manager = (await GitWorktreeManager.open(repo, home))!;
    const relation = await manager.create(await manager.plan("pointer-target", repo));
    const patch = await manager.capturePatch(relation);
    const capture = manager.capturePatch.bind(manager);
    manager.capturePatch = async (candidate) => {
      const snapshot = await capture(candidate);
      await writeFile(path.join(candidate.path, ".git"), pointer);
      return snapshot;
    };
    await expect(manager.remove(relation, patch)).rejects.toThrow("approved path and branch");
    expect(await readFile(path.join(admin, "index"))).toEqual(index);
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain("refs/heads/unrelated");
    await access(relation.path);
  });

  test("review follow-up: locked cleanup records its recovery location even when unregister fails", async () => {
    const { home, repo } = await repository(); const file = path.join(home, "main.jsonl"); await writeFile(file, "main");
    const runtime = new BranchRuntimeSession(home, repo, file);
    const options = { projectRoot: repo, gitBranch: "main", homeDir: home, policy: SAFE_DEFAULT_POLICY.workspace };
    const manager = await SessionWorkspaceManager.open(options);
    const child = await manager.branch("locked", { getRuntime: async () => runtime, confirm: async () => true });
    await git(repo, "worktree", "lock", child!.workspacePath);
    const result = await manager.returnToMain("discard", { getRuntime: async () => runtime, confirm: async () => true, verify: async () => "pass" });
    expect(result?.cleanupWarning).toContain("locked");
    expect(result?.preservedPath).toBeDefined();
    expect((await SessionWorkspaceManager.open(options)).renderTree()).toContain(result!.preservedPath!);
    expect(await readFile(path.join(result!.preservedPath!, "tracked.txt"), "utf8")).toBe("base\n");
  });

  test("review regression: ignored main files do not poison applied-diff verification", async () => {
    const { home, repo } = await repository();
    await writeFile(path.join(repo, "secret.env"), "keep main ignored content");
    const manager = (await GitWorktreeManager.open(repo, home))!;
    const relation = await manager.create(await manager.plan("ignored-main", repo));
    await writeFile(path.join(relation.path, "tracked.txt"), "candidate\n");
    const patch = await manager.capturePatch(relation);
    await manager.apply(relation, patch);
    expect(await readFile(path.join(repo, "secret.env"), "utf8")).toBe("keep main ignored content");
    await manager.remove(relation, patch);
  });

  test("review regression: restart resumes named conversation before updating outgoing linkage", async () => {
    const { home, repo } = await repository();
    const sessions = path.join(home, "sessions"); await mkdir(sessions);
    const mainFile = path.join(sessions, "main.jsonl"); await writeFile(mainFile, "original history");
    const first = new BranchRuntimeSession(sessions, repo, mainFile);
    const options = { projectRoot: repo, gitBranch: "main", homeDir: home, policy: SAFE_DEFAULT_POLICY.workspace };
    const original = await SessionWorkspaceManager.open(options);
    const child = await original.branch("restart", { getRuntime: async () => first, confirm: async () => true });
    const freshFile = path.join(sessions, "fresh.jsonl"); await writeFile(freshFile, "unrelated new session");
    const fresh = new BranchRuntimeSession(sessions, repo, freshFile);
    const restarted = await SessionWorkspaceManager.open(options);
    await restarted.switch("restart", { getRuntime: async () => fresh, confirm: async () => true });
    await restarted.returnToMain("discard", { getRuntime: async () => fresh, confirm: async () => true, verify: async () => "pass" });
    expect(fresh.getSessionInfo().sessionFile).toBe(mainFile);
    await expect(access(child!.workspacePath)).rejects.toThrow();
  });

  test("workspace isolation policy is layered and defaults to all three guarded reasons", async () => {
    const { home, repo } = await repository();
    await mkdir(path.join(home, ".casper"), { recursive: true });
    await mkdir(path.join(repo, ".casper"), { recursive: true });
    await writeFile(path.join(home, ".casper/config.yaml"), "workspace:\n  isolateWhen:\n    riskyRefactor: false\n");
    await writeFile(path.join(repo, ".casper/project.yaml"), "policy:\n  workspace:\n    isolateWhen:\n      experimentalBranch: false\n");
    const loaded = await loadConfiguration({ projectRoot: repo, homeDir: home });
    expect(loaded.policy.workspace.isolateWhen).toEqual({
      parallelAgents: true,
      riskyRefactor: false,
      experimentalBranch: false,
    });
    expect(SAFE_DEFAULT_POLICY.workspace.isolateWhen).toEqual({
      parallelAgents: true,
      riskyRefactor: true,
      experimentalBranch: true,
    });
  });

  test("a candidate worktree captures tracked and untracked changes, applies the exact reviewed patch, and cleans up", async () => {
    const { home, repo } = await repository();
    const manager = await GitWorktreeManager.open(repo, home);
    expect(manager).toBeDefined();
    const hookMarker = path.join(home, "post-checkout-ran");
    const hook = path.join(repo, ".git", "hooks", "post-checkout");
    await writeFile(hook, `#!/bin/sh\ntouch ${JSON.stringify(hookMarker)}\n`);
    await chmod(hook, 0o755);
    const plan = await manager!.plan("safe-experiment", repo);
    const relation = await manager!.create(plan);
    await expect(access(hookMarker)).rejects.toThrow();
    await writeFile(path.join(relation.path, "tracked.txt"), "candidate\n");
    await writeFile(path.join(relation.path, "new.txt"), "new file\n");
    await writeFile(path.join(relation.path, "binary.dat"), Buffer.from([0, 255, 1, 254]));
    await writeFile(path.join(relation.path, "invalid-utf8.dat"), Buffer.from([255, 254, 10]));

    const patch = await manager!.capturePatch(relation);
    expect(patch.files).toEqual(["binary.dat", "invalid-utf8.dat", "new.txt", "tracked.txt"]);
    expect(patch.patch.toString("utf8")).toContain("candidate");
    expect(patch.patch.toString("utf8")).toContain("new file");
    await writeFile(path.join(relation.path, "secret.env"), "must not be silently deleted\n");
    await expect(manager!.capturePatch(relation)).rejects.toThrow("ignored files");
    await rm(path.join(relation.path, "secret.env"));
    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("base\n");
    await expect(access(path.join(repo, "new.txt"))).rejects.toThrow();
    await expect(manager!.remove({ ...relation, branch: "main" }, patch)).rejects.toThrow("Invalid managed worktree relation");

    await manager!.apply(relation, patch);
    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("candidate\n");
    expect(await readFile(path.join(repo, "new.txt"), "utf8")).toBe("new file\n");
    expect(await readFile(path.join(repo, "binary.dat"))).toEqual(Buffer.from([0, 255, 1, 254]));
    expect(await readFile(path.join(repo, "invalid-utf8.dat"))).toEqual(Buffer.from([255, 254, 10]));
    await manager!.remove(relation, patch);
    await expect(access(relation.path)).rejects.toThrow();
    expect((await git(repo, "branch", "--list", relation.branch)).trim()).toBe("");
    expect((await git(repo, "status", "--porcelain")).trim()).not.toBe("");
    expect((await git(repo, "log", "-1", "--pretty=%s")).trim()).toBe("base");
  });

  test("isolation refuses dirty or changed source state rather than silently dropping pre-existing work", async () => {
    const { home, repo } = await repository();
    const manager = await GitWorktreeManager.open(repo, home);
    const approvedPlan = await manager!.plan("stale-approval", repo);
    await writeFile(path.join(repo, "uncommitted.txt"), "keep me");
    await expect(manager!.create(approvedPlan)).rejects.toThrow("changed after approval");
    await expect(manager!.plan("unsafe", repo)).rejects.toThrow("requires a clean source workspace");
    expect((await git(repo, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
    expect((await git(repo, "branch", "--list", approvedPlan.branch)).trim()).toBe("");
  });

  test("concurrent branch-store writers do not lose independent session branches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "casper-phase7-store-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const project = path.join(root, "project");
    await mkdir(project);
    const key = sessionProjectKey(project);
    const [left, right] = await Promise.all([
      SessionBranchStore.open({ projectKey: key, primaryWorkspace: project, homeDir: root }),
      SessionBranchStore.open({ projectKey: key, primaryWorkspace: project, homeDir: root }),
    ]);
    const record = (name: string): NamedSessionBranch => ({
      name,
      parent: "main",
      sessionId: `session-${name}`,
      sessionFile: path.join(root, `${name}.jsonl`),
      workspacePath: project,
      gitBranch: null,
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await Promise.all([left.upsert(record("left")), right.upsert(record("right"))]);
    const reopened = await SessionBranchStore.open({ projectKey: key, primaryWorkspace: project, homeDir: root });
    expect(reopened.list().map((branch) => branch.name)).toEqual(["left", "right"]);

    const [firstCreator, secondCreator] = await Promise.all([
      SessionBranchStore.open({ projectKey: key, primaryWorkspace: project, homeDir: root }),
      SessionBranchStore.open({ projectKey: key, primaryWorkspace: project, homeDir: root }),
    ]);
    const duplicateResults = await Promise.allSettled([
      firstCreator.insert(record("duplicate")),
      secondCreator.insert(record("duplicate")),
    ]);
    expect(duplicateResults.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const final = await SessionBranchStore.open({ projectKey: key, primaryWorkspace: project, homeDir: root });
    expect(final.list().filter((branch) => branch.name === "duplicate")).toHaveLength(1);
  });

  test("named branches preserve session linkage and shared-workspace switching when isolation is disabled", async () => {
    const { home, repo } = await repository();
    const sessions = path.join(home, "fake-sessions");
    await mkdir(sessions);
    const mainFile = path.join(sessions, "main.jsonl");
    await writeFile(mainFile, "main session");
    const runtime = new BranchRuntimeSession(sessions, repo, mainFile);
    const manager = await SessionWorkspaceManager.open({
      projectRoot: repo,
      gitBranch: "main",
      policy: { isolateWhen: { parallelAgents: true, riskyRefactor: true, experimentalBranch: false } },
      homeDir: home,
    });
    const confirmations: string[] = [];
    const created = await manager.branch("conversation-only", {
      getRuntime: async () => runtime,
      confirm: async (preview) => { confirmations.push(preview); return true; },
      context: "TASK_AND_PROJECT_CONTEXT",
    });
    expect(created?.workspacePath).toBe(await realpath(repo));
    expect(runtime.contexts).toContain("TASK_AND_PROJECT_CONTEXT");
    expect(manager.renderTree()).toContain("conversation-only  shared");
    const switched = await manager.switch("main", {
      getRuntime: async () => runtime,
      confirm: async (preview) => { confirmations.push(preview); return true; },
    });
    expect(switched?.name).toBe("main");
    expect(runtime.getState().cwd).toBe(await realpath(repo));
    expect(confirmations).toHaveLength(2);

    const stateDirectory = path.join(home, ".casper", "sessions");
    const [manifest] = await readdir(stateDirectory);
    await writeFile(path.join(stateDirectory, manifest), "{not valid json");
    await expect(SessionWorkspaceManager.open({
      projectRoot: repo,
      gitBranch: "main",
      policy: { isolateWhen: { parallelAgents: true, riskyRefactor: true, experimentalBranch: false } },
      homeDir: home,
    })).rejects.toThrow("Invalid Casper session branch state");
  });

  test("return-to-main verifies and shows the complete diff before applying without a commit", async () => {
    const { home, repo } = await repository();
    const sessions = path.join(home, "fake-sessions");
    await mkdir(sessions);
    const mainFile = path.join(sessions, "main.jsonl");
    await writeFile(mainFile, "main session");
    const runtime = new BranchRuntimeSession(sessions, repo, mainFile);
    const manager = await SessionWorkspaceManager.open({
      projectRoot: repo,
      gitBranch: "main",
      policy: SAFE_DEFAULT_POLICY.workspace,
      homeDir: home,
    });
    const previews: string[] = [];
    const created = await manager.branch("candidate", {
      getRuntime: async () => runtime,
      confirm: async (preview) => { previews.push(preview); return true; },
      context: "CONVERSATION_CONTEXT",
    });
    await writeFile(path.join(created!.workspacePath, "tracked.txt"), "accepted\n");
    await writeFile(path.join(created!.workspacePath, "added.txt"), "accepted \u001b[31mnew file\n");
    let verifiedCwd: string | undefined;
    const returned = await manager.returnToMain("apply", {
      getRuntime: async () => runtime,
      verify: async (cwd) => { verifiedCwd = cwd; return "pass"; },
      confirm: async (preview) => { previews.push(preview); return true; },
    });
    expect(verifiedCwd).toBe(created!.workspacePath);
    expect(previews[1]).toContain("reviewed diff (terminal controls escaped");
    expect(previews[1]).toContain("accepted \\u{1b}[31mnew file");
    expect(previews[1]).not.toContain("\u001b");
    expect(previews[1]).toContain("verification: pass");
    expect(returned?.name).toBe("main");
    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("accepted\n");
    expect(await readFile(path.join(repo, "added.txt"), "utf8")).toBe("accepted \u001b[31mnew file\n");
    expect((await git(repo, "log", "-1", "--pretty=%s")).trim()).toBe("base");
    expect(manager.renderTree()).toContain("applied");
    await expect(access(created!.workspacePath)).rejects.toThrow();
  });

  test("failed verification preserves the candidate, and discard still requires reviewed confirmation", async () => {
    const { home, repo } = await repository();
    const sessions = path.join(home, "fake-sessions");
    await mkdir(sessions);
    const mainFile = path.join(sessions, "main.jsonl");
    await writeFile(mainFile, "main session");
    const runtime = new BranchRuntimeSession(sessions, repo, mainFile);
    const manager = await SessionWorkspaceManager.open({ projectRoot: repo, gitBranch: "main", policy: SAFE_DEFAULT_POLICY.workspace, homeDir: home });
    const created = await manager.branch("reject-me", {
      getRuntime: async () => runtime,
      confirm: async () => true,
    });
    await writeFile(path.join(created!.workspacePath, "tracked.txt"), "bad candidate\n");
    await expect(manager.returnToMain("apply", {
      getRuntime: async () => runtime,
      verify: async () => "fail",
      confirm: async () => { throw new Error("approval must not run"); },
    })).rejects.toThrow("verification failed");
    expect(await readFile(path.join(created!.workspacePath, "tracked.txt"), "utf8")).toBe("bad candidate\n");
    let discardPreview = "";
    await manager.returnToMain("discard", {
      getRuntime: async () => runtime,
      verify: async () => { throw new Error("discard does not verify"); },
      confirm: async (preview) => { discardPreview = preview; return true; },
    });
    expect(discardPreview).toContain("action: discard");
    expect(discardPreview).toContain("bad candidate");
    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("base\n");
    await expect(access(created!.workspacePath)).rejects.toThrow();
  });

  test("main changes made during apply approval preserve both workspaces and keep the branch recoverable", async () => {
    const { home, repo } = await repository();
    const sessions = path.join(home, "fake-sessions");
    await mkdir(sessions);
    const mainFile = path.join(sessions, "main.jsonl");
    await writeFile(mainFile, "main session");
    const runtime = new BranchRuntimeSession(sessions, repo, mainFile);
    const manager = await SessionWorkspaceManager.open({ projectRoot: repo, gitBranch: "main", policy: SAFE_DEFAULT_POLICY.workspace, homeDir: home });
    const created = await manager.branch("main-race", { getRuntime: async () => runtime, confirm: async () => true });
    await writeFile(path.join(created!.workspacePath, "tracked.txt"), "candidate\n");
    const returned = await manager.returnToMain("apply", {
      getRuntime: async () => runtime,
      verify: async () => "pass",
      confirm: async () => {
        await writeFile(path.join(repo, "tracked.txt"), "outside main change\n");
        return true;
      },
    });
    expect(returned?.cleanupWarning).toContain("Apply failed");
    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("outside main change\n");
    expect(await readFile(path.join(created!.workspacePath, "tracked.txt"), "utf8")).toBe("candidate\n");
    expect(manager.renderTree()).toContain("○ main-race");
  });

  test("candidate changes made during approval are preserved rather than destructively discarded", async () => {
    const { home, repo } = await repository();
    const sessions = path.join(home, "fake-sessions");
    await mkdir(sessions);
    const mainFile = path.join(sessions, "main.jsonl");
    await writeFile(mainFile, "main session");
    const runtime = new BranchRuntimeSession(sessions, repo, mainFile);
    const manager = await SessionWorkspaceManager.open({ projectRoot: repo, gitBranch: "main", policy: SAFE_DEFAULT_POLICY.workspace, homeDir: home });
    const created = await manager.branch("approval-race", { getRuntime: async () => runtime, confirm: async () => true });
    await writeFile(path.join(created!.workspacePath, "tracked.txt"), "reviewed\n");
    const returned = await manager.returnToMain("discard", {
      getRuntime: async () => runtime,
      verify: async () => { throw new Error("discard does not verify"); },
      confirm: async () => {
        await writeFile(path.join(created!.workspacePath, "late.txt"), "arrived during approval\n");
        return true;
      },
    });
    expect(returned?.cleanupWarning).toContain("changed after review");
    expect(await readFile(path.join(created!.workspacePath, "late.txt"), "utf8")).toContain("during approval");
    expect(manager.renderTree()).toContain("○ approval-race");
    const resumed = await manager.switch("approval-race", { getRuntime: async () => runtime, confirm: async () => true });
    expect(resumed?.workspacePath).toBe(created!.workspacePath);
  });

  test("local tree is lazy and one-shot branch creation fails closed without creating a worktree", async () => {
    const { home, repo } = await repository();
    let starts = 0;
    let output = "";
    const app = new CasperApp({
      sessionHomeDir: home,
      runtimeFactory: () => ({
        start: async () => { starts++; throw new Error("must remain lazy"); },
        dispose: async () => {},
      }),
      loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
      loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
      loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      output: { write: (text) => { output += text; } },
    });
    cleanup.push(() => app.close());
    await app.runOnce("/tree", repo);
    await app.runOnce("/branch denied");
    expect(starts).toBe(0);
    expect(output).toContain("Session\n● main");
    expect(output).toContain("Branch creation not approved");
    expect((await git(repo, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
  });

  test("the pinned Pi adapter clones, names, resumes, and persists context through its session runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "casper-phase7-pi-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const main = path.join(root, "main");
    const branch = path.join(root, "branch");
    const agentDir = path.join(root, "agent");
    await Promise.all([mkdir(main), mkdir(branch), mkdir(agentDir)]);
    const proc = Bun.spawn([
      process.execPath,
      path.join(import.meta.dir, "fixtures/pi-session-branch.ts"),
      main,
      branch,
    ], {
      cwd: main,
      env: {
        ...process.env,
        HOME: root,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout.trim()) as {
      main: RuntimeSessionInfo;
      branch: RuntimeSessionInfo;
      switched: RuntimeSessionInfo;
      branchName: string;
      customMessages: string[];
    };
    expect(result.main.cwd).toBe(main);
    expect(result.branch.cwd).toBe(branch);
    expect(result.branch.sessionFile).not.toBe(result.main.sessionFile);
    expect(result.branchName).toBe("experiment");
    expect(result.customMessages).toContain("MAIN_CONTEXT");
    expect(result.customMessages).toContain("BRANCH_CONTEXT");
    expect(result.switched.sessionFile).toBe(result.main.sessionFile);
    expect(result.switched.cwd).toBe(main);
  });
});
