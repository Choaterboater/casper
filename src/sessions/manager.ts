import { access, realpath } from "node:fs/promises";
import path from "node:path";
import type { CasperPolicy } from "../config/load";
import type { RuntimeSession, RuntimeSessionInfo } from "../runtime/types";
import { GitWorktreeManager, WorktreeCleanupError, type WorktreePatch, type WorktreePlan, type WorktreeRelation } from "../workspace/worktree";
import { SessionBranchStore, sessionProjectKey, type NamedSessionBranch } from "./store";

export type ConfirmSessionOperation = (preview: string, question: string) => Promise<boolean>;
export type ReturnAction = "apply" | "discard";
export type VerificationStatus = "pass" | "fail" | "incomplete" | "blocked";

export interface SessionTransition {
  name: string;
  workspacePath: string;
  session: RuntimeSessionInfo;
  cleanupWarning?: string;
  preservedPath?: string;
}

export interface SessionWorkspaceOptions {
  projectRoot: string;
  gitBranch: string | null;
  policy: CasperPolicy["workspace"];
  homeDir?: string;
}

interface BranchOptions {
  getRuntime: () => Promise<RuntimeSession>;
  confirm: ConfirmSessionOperation;
  context?: string;
}

interface SwitchOptions extends BranchOptions {}

interface ReturnOptions extends SwitchOptions {
  verify: (cwd: string) => Promise<VerificationStatus>;
}

export const SESSION_BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function requireBranchingRuntime(session: RuntimeSession): asserts session is RuntimeSession & Required<Pick<RuntimeSession, "getSessionInfo" | "forkSession" | "switchSession">> {
  if (!session.getSessionInfo || !session.forkSession || !session.switchSession) {
    throw new Error("The selected runtime does not support persistent session branches");
  }
}

function now(): string {
  return new Date().toISOString();
}

async function sameFilesystemPath(left: string, right: string): Promise<boolean> {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    realpath(left).catch(() => path.resolve(left)),
    realpath(right).catch(() => path.resolve(right)),
  ]);
  return canonicalLeft === canonicalRight;
}

function branchRecord(options: {
  existing?: NamedSessionBranch;
  name: string;
  parent: string | null;
  session: RuntimeSessionInfo;
  workspacePath: string;
  gitBranch: string | null;
  worktree?: WorktreeRelation;
}): NamedSessionBranch {
  const timestamp = now();
  return {
    name: options.name,
    parent: options.parent,
    sessionId: options.session.sessionId,
    sessionFile: options.session.sessionFile,
    workspacePath: path.resolve(options.workspacePath),
    gitBranch: options.gitBranch,
    worktree: options.worktree,
    status: "open",
    createdAt: options.existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function branchPreview(name: string, source: string, plan?: WorktreePlan): string {
  const lines = [
    "Session branch confirmation",
    `name: ${JSON.stringify(name)}`,
    "conversation: clone the active Pi session branch",
    `source workspace: ${source}`,
  ];
  if (plan) {
    lines.push(
      `git branch: ${plan.branch}`,
      `base commit: ${plan.baseCommit}`,
      `new worktree: ${plan.path}`,
      "return: candidate diff must be reviewed, then explicitly applied or discarded",
    );
  } else {
    lines.push("workspace: shared with the parent session (isolation disabled or unavailable)");
  }
  return `${lines.join("\n")}\n`;
}

function terminalSafe(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`);
}

function patchPreview(branch: NamedSessionBranch, action: ReturnAction, patch: WorktreePatch, verification?: VerificationStatus): string {
  return [
    "Return-to-main confirmation",
    `session branch: ${JSON.stringify(branch.name)}`,
    `action: ${action}`,
    `candidate workspace: ${branch.workspacePath}`,
    `main workspace: ${branch.worktree!.mainWorkspace}`,
    `verification: ${verification ?? "not required for discard"}`,
    `changed files (${patch.files.length}): ${JSON.stringify(patch.files)}`,
    `diff bytes: ${patch.bytes}`,
    `diff sha256: ${patch.sha256}`,
    patch.stat ? `diff stat:\n${terminalSafe(patch.stat)}` : "diff stat: no changes",
    "reviewed diff (terminal controls escaped; SHA-256 identifies original bytes):",
    patch.patch.length ? terminalSafe(patch.patch.toString("utf8")) : "(no changes)",
    action === "apply"
      ? "Casper will apply this exact diff without committing, switch to main, then unregister the temporary worktree and Git branch. Candidate files are retained in a local recovery directory."
      : "Casper will switch to main and unregister the temporary worktree and Git branch. Candidate files are retained in a local recovery directory, not permanently deleted.",
    "",
  ].join("\n");
}

export class SessionWorkspaceManager {
  private boundRuntime?: RuntimeSession;

  private constructor(
    private readonly store: SessionBranchStore,
    private readonly worktrees: GitWorktreeManager | undefined,
    private readonly policy: CasperPolicy["workspace"],
    private readonly initialGitBranch: string | null,
    private currentName: string,
  ) {}

  static async open(options: SessionWorkspaceOptions): Promise<SessionWorkspaceManager> {
    const projectRoot = await realpath(options.projectRoot).catch(() => path.resolve(options.projectRoot));
    const worktrees = await GitWorktreeManager.open(projectRoot, options.homeDir);
    const projectKey = worktrees?.projectKey ?? sessionProjectKey(projectRoot);
    const primaryWorkspace = worktrees?.primaryWorkspace ?? projectRoot;
    const store = await SessionBranchStore.open({ projectKey, primaryWorkspace, homeDir: options.homeDir });
    const current = projectRoot === primaryWorkspace ? "main" : store.list().find((branch) => branch.status === "open" && path.resolve(branch.workspacePath) === projectRoot)?.name
      ?? "main";
    return new SessionWorkspaceManager(store, worktrees, options.policy, options.gitBranch, current);
  }

  get activeName(): string {
    return this.currentName;
  }

  /** Bind a newly-created runtime to the saved active conversation before recording it. */
  async resumeActive(runtime: RuntimeSession): Promise<void> {
    if (this.boundRuntime === runtime) return;
    const saved = this.store.get(this.currentName);
    if (saved) {
      requireBranchingRuntime(runtime);
      if (!await sameFilesystemPath(runtime.getState().cwd, saved.workspacePath)) throw new Error("Saved session workspace does not match startup cwd");
      if (saved.worktree) await this.worktrees!.validate(saved.worktree);
      await access(saved.sessionFile);
      if (runtime.getSessionInfo().sessionFile !== saved.sessionFile) {
        await runtime.switchSession({ cwd: saved.workspacePath, sessionFile: saved.sessionFile });
      }
    }
    this.boundRuntime = runtime;
  }

  /** Keep the named workspace bound to its new conversation after clear/resume. */
  async rememberConversation(runtime: RuntimeSession): Promise<void> {
    requireBranchingRuntime(runtime);
    const session = runtime.getSessionInfo();
    const existing = this.store.get(this.currentName);
    const expected = existing?.workspacePath ?? this.store.primaryWorkspace;
    if (!await sameFilesystemPath(session.cwd, expected)) throw new Error("Conversation workspace does not match the active named workspace.");
    await this.store.upsert(existing ? { ...existing, sessionId: session.sessionId, sessionFile: session.sessionFile, updatedAt: now() }
      : branchRecord({ name: this.currentName, parent: null, session, workspacePath: expected, gitBranch: this.initialGitBranch }));
  }

  renderTree(): string {
    const records = this.store.list();
    const main = records.find((branch) => branch.name === "main");
    const lines = ["Session", `${this.currentName === "main" ? "●" : "○"} main${main ? `  ${main.gitBranch ?? "no-git"}  ${main.workspacePath}` : `  ${this.store.primaryWorkspace}`}`];
    for (const branch of records.filter((candidate) => candidate.name !== "main")) {
      const marker = branch.name === this.currentName ? "●" : branch.status === "open" ? "○" : "×";
      const relation = branch.worktree ? `worktree ${branch.workspacePath} · ${branch.gitBranch}` : `shared ${branch.workspacePath}`;
      const outcome = branch.status === "open"
        ? branch.cleanupPending ? " · cleanup pending" : ""
        : ` · ${branch.status}${branch.cleanupPending ? " (cleanup pending)" : ""}`;
      lines.push(`├─ ${marker} ${branch.name}  ${relation}${outcome}${branch.preservedPath ? ` · recovery ${branch.preservedPath}` : ""}`);
    }
    return `${lines.join("\n")}\n`;
  }

  async branch(name: string, options: BranchOptions): Promise<SessionTransition | undefined> {
    this.validateNewName(name);
    if (this.currentName !== "main") throw new Error("Create experimental branches from main; switch or return to main first");
    const sourceWorkspace = this.store.primaryWorkspace;
    let plan: WorktreePlan | undefined;
    if (this.policy.isolateWhen.experimentalBranch && this.worktrees) {
      plan = await this.worktrees.plan(name, sourceWorkspace);
    }
    const approved = await options.confirm(
      branchPreview(name, sourceWorkspace, plan),
      "Create this exact session branch? Type yes: ",
    );
    if (!approved) return undefined;

    const runtime = await options.getRuntime();
    requireBranchingRuntime(runtime);
    await this.resumeActive(runtime);
    const sourceSession = runtime.getSessionInfo();
    if (!await sameFilesystemPath(sourceSession.cwd, sourceWorkspace)) {
      throw new Error("Active runtime workspace no longer matches the main session branch");
    }
    const existingMain = this.store.get("main");
    const main = branchRecord({
      existing: existingMain,
      name: "main",
      parent: null,
      session: sourceSession,
      workspacePath: sourceWorkspace,
      gitBranch: existingMain?.gitBranch ?? this.initialGitBranch,
    });

    let relation: WorktreeRelation | undefined;
    try {
      relation = plan ? await this.worktrees!.create(plan) : undefined;
      const workspacePath = relation?.path ?? sourceWorkspace;
      const target = await runtime.forkSession({ cwd: workspacePath, name, context: options.context });
      const child = branchRecord({
        name,
        parent: "main",
        session: target,
        workspacePath,
        gitBranch: relation?.branch ?? main.gitBranch,
        worktree: relation,
      });
      try {
        await this.store.insert(child, [main]);
      } catch (error) {
        await runtime.switchSession({ cwd: main.workspacePath, sessionFile: main.sessionFile }).catch(() => {});
        if (relation) await this.worktrees!.remove(relation).catch(() => {});
        throw error;
      }
      this.currentName = name;
      return { name, workspacePath, session: target };
    } catch (error) {
      if (relation && runtime.getState().cwd !== sourceWorkspace) {
        await runtime.switchSession({ cwd: main.workspacePath, sessionFile: main.sessionFile }).catch(() => {});
      }
      if (relation) await this.worktrees!.remove(relation).catch(() => {});
      throw error;
    }
  }

  async switch(name: string, options: SwitchOptions): Promise<SessionTransition | undefined> {
    if (!SESSION_BRANCH_NAME_PATTERN.test(name)) throw new Error("Invalid session branch name");
    if (name === this.currentName) throw new Error(`Already on session branch ${JSON.stringify(name)}`);
    const current = this.store.get(this.currentName);
    if (current?.worktree && name === "main") {
      throw new Error("An isolated experiment must return with `/switch main apply` or `/switch main discard`");
    }
    const target = this.store.get(name);
    if (!target || target.status !== "open" || target.cleanupPending) throw new Error(`Open session branch not found: ${name}`);
    await access(target.workspacePath).catch(() => { throw new Error(`Session workspace is missing: ${target.workspacePath}`); });
    await access(target.sessionFile).catch(() => { throw new Error(`Pi session file is missing: ${target.sessionFile}`); });
    const approved = await options.confirm([
      "Session switch confirmation",
      `from: ${JSON.stringify(this.currentName)}`,
      `to: ${JSON.stringify(name)}`,
      `workspace: ${target.workspacePath}`,
      `Pi session: ${target.sessionFile}`,
      "",
    ].join("\n"), "Switch to this exact session branch? Type yes: ");
    if (!approved) return undefined;
    if (target.worktree) {
      if (!this.worktrees) throw new Error("Git worktree support is unavailable");
      await this.worktrees.validate(target.worktree);
    }
    const runtime = await options.getRuntime();
    requireBranchingRuntime(runtime);
    await this.resumeActive(runtime);
    const source = runtime.getSessionInfo();
    const sourceRecord = this.recordCurrentSession(source);
    if (sourceRecord) await this.store.upsert(sourceRecord);
    const switched = await runtime.switchSession({ cwd: target.workspacePath, sessionFile: target.sessionFile, context: options.context });
    this.currentName = name;
    return { name, workspacePath: target.workspacePath, session: switched };
  }

  async returnToMain(action: ReturnAction, options: ReturnOptions): Promise<SessionTransition | undefined> {
    const branch = this.store.get(this.currentName);
    if (!branch?.worktree || branch.status !== "open") throw new Error("The active session branch is not an open isolated experiment");
    if (!this.worktrees) throw new Error("Git worktree support is unavailable");
    const main = this.store.get("main");
    if (!main || main.status !== "open") throw new Error("Main session metadata is unavailable");
    const verification = action === "apply" ? await options.verify(branch.workspacePath) : undefined;
    if (verification === "fail" || verification === "blocked") {
      throw new Error("Candidate verification failed or was blocked; repair or discard the experiment before returning to main");
    }
    // Verification may generate or normalize files. Capture afterwards so the
    // approved identity always describes the exact candidate being returned.
    const patch = await this.worktrees.capturePatch(branch.worktree);
    const approved = await options.confirm(
      patchPreview(branch, action, patch, verification),
      `${action === "apply" ? "Apply" : "Discard"} this exact candidate and return to main? Type yes: `,
    );
    if (!approved) return undefined;

    const runtime = await options.getRuntime();
    requireBranchingRuntime(runtime);
    await this.resumeActive(runtime);
    const candidateSession = runtime.getSessionInfo();
    const switched = await runtime.switchSession({ cwd: main.workspacePath, sessionFile: main.sessionFile, context: options.context });
    this.currentName = "main";

    let cleanupWarning: string | undefined;
    let preservedPath: string | undefined;
    let candidateWorkspacePreserved = false;
    let outcomeCompleted = false;
    if (action === "apply") {
      try {
        await this.worktrees.apply(branch.worktree, patch);
        outcomeCompleted = true;
      } catch (error) {
        cleanupWarning = `Apply failed: ${error instanceof Error ? error.message : String(error)}`;
        candidateWorkspacePreserved = await this.workspaceStillExists(branch.workspacePath);
      }
    }
    if (action === "discard" || outcomeCompleted) {
      try {
        preservedPath = await this.worktrees.remove(branch.worktree, patch);
        outcomeCompleted = true;
      } catch (error) {
        cleanupWarning = error instanceof Error ? error.message : String(error);
        if (error instanceof WorktreeCleanupError) preservedPath = error.preservedPath;
        candidateWorkspacePreserved = await this.workspaceStillExists(branch.workspacePath);
        // A partially completed discard may remove the worktree content but
        // fail to delete its Git ref. Record the destructive outcome honestly.
        if (action === "discard" && !candidateWorkspacePreserved) outcomeCompleted = true;
      }
    }
    const timestamp = now();
    const completed: NamedSessionBranch = {
      ...branch,
      sessionId: candidateSession.sessionId,
      sessionFile: candidateSession.sessionFile,
      status: candidateWorkspacePreserved || !outcomeCompleted ? "open" : action === "apply" ? "applied" : "discarded",
      cleanupPending: cleanupWarning && !candidateWorkspacePreserved ? true : undefined,
      preservedPath,
      updatedAt: timestamp,
    };
    const updatedMain: NamedSessionBranch = {
      ...main,
      sessionId: switched.sessionId,
      sessionFile: switched.sessionFile,
      updatedAt: timestamp,
    };
    await this.store.upsertMany([updatedMain, completed]);
    return { name: "main", workspacePath: main.workspacePath, session: switched, cleanupWarning, preservedPath };
  }

  private async workspaceStillExists(workspacePath: string): Promise<boolean> {
    return access(workspacePath).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
  }

  private recordCurrentSession(session: RuntimeSessionInfo): NamedSessionBranch | undefined {
    const existing = this.store.get(this.currentName);
    if (!existing) return undefined;
    return {
      ...existing,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      workspacePath: session.cwd,
      updatedAt: now(),
    };
  }

  private validateNewName(name: string): void {
    if (!SESSION_BRANCH_NAME_PATTERN.test(name) || name === "main") {
      throw new Error("Branch name must be 1-64 letters, digits, dots, underscores, or hyphens; `main` is reserved");
    }
    if (this.store.get(name)) throw new Error(`Session branch already exists: ${name}`);
  }
}
