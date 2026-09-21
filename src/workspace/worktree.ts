import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MAX_EXPERIMENT_PATCH_BYTES = 512 * 1024;
export const MAX_EXPERIMENT_FILES = 200;
const STDERR_LIMIT = 16 * 1024;
const SESSION_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface WorktreeRelation {
  kind: "git-worktree";
  mainWorkspace: string;
  path: string;
  branch: string;
  baseCommit: string;
}

export interface WorktreePlan extends WorktreeRelation {
  sourceWorkspace: string;
}

export class WorktreeCleanupError extends Error {
  constructor(message: string, readonly preservedPath: string) {
    super(`Worktree bytes preserved at ${preservedPath}; ${message}`);
  }
}

export interface WorktreePatch {
  patch: Buffer;
  bytes: number;
  sha256: string;
  files: string[];
  stat: string;
}

interface WorktreeEntry {
  path: string;
  branch?: string;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as Error & { stderr?: string | Buffer }).stderr;
  const detail = typeof stderr === "string" ? stderr : stderr?.toString("utf8");
  return detail?.trim() || error.message;
}

function safeGitArgs(args: string[]): string[] {
  return ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`, ...args];
}

async function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", safeGitArgs(args), {
      cwd,
      env: options.env ?? process.env,
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
    });
    return String(stdout);
  } catch (error) {
    throw new Error(`git ${args[0] ?? "command"} failed: ${errorText(error)}`);
  }
}

async function gitBytes(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", safeGitArgs(args), {
      cwd,
      env: options.env ?? process.env,
      encoding: "buffer",
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (error) {
    throw new Error(`git ${args[0] ?? "command"} failed: ${errorText(error)}`);
  }
}

async function gitWithInput(cwd: string, args: string[], input: string | Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", safeGitArgs(args), { cwd, env: process.env, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < STDERR_LIMIT) stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0] ?? "command"} failed (${signal ?? code}): ${stderr.trim()}`));
    });
    child.stdin.once("error", reject);
    child.stdin.end(input);
  });
}

function parseWorktrees(output: string): WorktreeEntry[] {
  return output.trim().split(/\n\n+/).filter(Boolean).flatMap((block) => {
    let worktreePath: string | undefined;
    let branch: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) worktreePath = line.slice("worktree ".length);
      if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length);
    }
    return worktreePath ? [{ path: path.resolve(worktreePath), branch }] : [];
  });
}

function slug(value: string): string {
  const readable = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "branch";
  return `${readable}-${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
}

function describeDirtyStatus(status: string): string {
  return status.split("\0").filter(Boolean).slice(0, 10).map((entry) => JSON.stringify(entry.slice(0, 200))).join(", ");
}

export class GitWorktreeManager {
  private constructor(
    readonly commonDir: string,
    readonly primaryWorkspace: string,
    readonly projectKey: string,
    private readonly managedRoot: string,
  ) {}

  static async open(projectRoot: string, homeDir = os.homedir()): Promise<GitWorktreeManager | undefined> {
    let commonDir: string;
    let entries: WorktreeEntry[];
    try {
      const [commonDirOutput, worktreeOutput] = await Promise.all([
        git(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        git(projectRoot, ["worktree", "list", "--porcelain"]),
      ]);
      commonDir = commonDirOutput.trim();
      entries = parseWorktrees(worktreeOutput);
    } catch {
      return undefined;
    }
    const canonicalCommonDir = await realpath(path.resolve(projectRoot, commonDir)).catch(() => path.resolve(projectRoot, commonDir));
    const primaryWorkspace = entries[0]?.path ?? path.resolve(projectRoot);
    const projectKey = createHash("sha256").update(canonicalCommonDir).digest("hex").slice(0, 20);
    const canonicalHome = await realpath(homeDir).catch(() => path.resolve(homeDir));
    return new GitWorktreeManager(
      canonicalCommonDir,
      primaryWorkspace,
      projectKey,
      path.join(canonicalHome, ".casper", "worktrees", projectKey),
    );
  }

  async plan(sessionBranch: string, sourceWorkspace: string): Promise<WorktreePlan> {
    const source = await realpath(sourceWorkspace).catch(() => path.resolve(sourceWorkspace));
    await this.assertSameRepository(source);
    if (source !== this.primaryWorkspace) throw new Error("Managed experiments must branch from the primary worktree");
    const status = await git(source, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status) {
      throw new Error(`Worktree isolation requires a clean source workspace; preserve or discard these changes first: ${describeDirtyStatus(status)}`);
    }
    const branch = `casper/${sessionBranch}`;
    await git(source, ["check-ref-format", "--branch", branch]);
    const existing = await git(source, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
    if (existing) throw new Error(`Git branch ${JSON.stringify(branch)} already exists`);
    const baseCommit = (await git(source, ["rev-parse", "HEAD"])).trim();
    const worktreePath = path.join(this.managedRoot, slug(sessionBranch));
    try {
      await access(worktreePath);
      throw new Error(`Managed worktree path already exists: ${worktreePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      kind: "git-worktree",
      sourceWorkspace: source,
      mainWorkspace: this.primaryWorkspace,
      path: worktreePath,
      branch,
      baseCommit,
    };
  }

  async create(plan: WorktreePlan): Promise<WorktreeRelation> {
    this.assertManagedPlan(plan);
    await mkdir(this.managedRoot, { recursive: true, mode: 0o700 });
    if (await realpath(this.managedRoot) !== this.managedRoot) throw new Error("Managed worktree root resolves outside Casper state");
    const lock = `${plan.path}.create-lock`;
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (!acquired) throw new Error("Managed worktree creation is locked");
    try { return await this.createOwned(plan); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }

  private async createOwned(plan: WorktreePlan): Promise<WorktreeRelation> {
    this.assertManagedPlan(plan);
    await this.assertSameRepository(plan.sourceWorkspace);
    const [currentHead, status] = await Promise.all([
      git(plan.sourceWorkspace, ["rev-parse", "HEAD"]),
      git(plan.sourceWorkspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    if (currentHead.trim() !== plan.baseCommit || status) {
      throw new Error("Source workspace changed after approval; refusing to create the worktree");
    }
    const branchExists = await git(plan.sourceWorkspace, ["show-ref", "--verify", "--quiet", `refs/heads/${plan.branch}`]).then(() => true, () => false);
    if (branchExists) throw new Error(`Git branch already exists: ${plan.branch}`);
    await mkdir(path.dirname(plan.path), { recursive: true, mode: 0o700 });
    const canonicalParent = await realpath(path.dirname(plan.path));
    if (canonicalParent !== this.managedRoot) throw new Error("Managed worktree root resolves outside Casper state");
    let created = false;
    try {
      await git(plan.sourceWorkspace, ["worktree", "add", "-b", plan.branch, plan.path, plan.baseCommit], { maxBuffer: 64 * 1024 });
      created = true;
      const createdPath = await realpath(plan.path);
      if (createdPath !== path.resolve(plan.path)) throw new Error("Created worktree resolved to an unexpected path");
      await this.assertRegistered(plan);
      return {
        kind: "git-worktree",
        mainWorkspace: plan.mainWorkspace,
        path: plan.path,
        branch: plan.branch,
        baseCommit: plan.baseCommit,
      };
    } catch (error) {
      // Never delete a same-named branch created by a concurrent process. Only
      // roll back when Git registered this exact managed path/branch pair.
      const entries = await git(plan.sourceWorkspace, ["worktree", "list", "--porcelain"])
        .then(parseWorktrees, () => []);
      const entry = entries.find((candidate) => candidate.path === path.resolve(plan.path) && candidate.branch === plan.branch);
      if (created && entry) {
        // Never force removal: even our successfully-created tree may have gained files.
        const removed = await git(plan.sourceWorkspace, ["worktree", "remove", plan.path]).then(() => true, () => false);
        if (removed) await git(plan.sourceWorkspace, ["branch", "-D", plan.branch]).catch(() => {});
      }
      throw error;
    }
  }

  async validate(relation: WorktreeRelation): Promise<void> {
    this.assertManagedRelation(relation);
    await this.assertRegistered(relation);
  }

  async capturePatch(relation: WorktreeRelation): Promise<WorktreePatch> {
    await this.validate(relation);
    const ignored = (await git(relation.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]))
      .split("\0").filter(Boolean);
    if (ignored.length && relation.path !== relation.mainWorkspace) {
      const sample = ignored.slice(0, 10).map((file) => JSON.stringify(file)).join(", ");
      throw new Error(`Experiment contains ignored files that an exact Git patch cannot represent (${sample}${ignored.length > 10 ? ", …" : ""}); preserve or remove them manually`);
    }
    const temp = await mkdtemp(path.join(os.tmpdir(), "casper-worktree-index-"));
    const env = { ...process.env, GIT_INDEX_FILE: path.join(temp, "index") };
    try {
      await git(relation.path, ["read-tree", relation.baseCommit], { env });
      await git(relation.path, ["add", "--intent-to-add", "--all", "--", "."], { env });
      const patchWork = gitBytes(relation.path, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-color", relation.baseCommit, "--"], {
        env,
        maxBuffer: MAX_EXPERIMENT_PATCH_BYTES + 1,
      }).catch((error: unknown) => {
        if (/maxBuffer|stdout/i.test(errorText(error))) {
          throw new Error(`Experiment diff exceeds ${MAX_EXPERIMENT_PATCH_BYTES} bytes; review and apply it manually`);
        }
        throw error;
      });
      // Independent, read-only views over the prepared temporary index can run
      // together, avoiding two process-latency round trips.
      const [patch, names, statOutput] = await Promise.all([
        patchWork,
        git(relation.path, ["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", relation.baseCommit, "--"], { env }),
        git(relation.path, ["diff", "--stat", "--no-ext-diff", "--no-textconv", "--no-color", relation.baseCommit, "--"], { env, maxBuffer: 64 * 1024 }),
      ]);
      const bytes = patch.length;
      if (bytes > MAX_EXPERIMENT_PATCH_BYTES) {
        throw new Error(`Experiment diff exceeds ${MAX_EXPERIMENT_PATCH_BYTES} bytes; review and apply it manually`);
      }
      const files = names.split("\0").filter(Boolean);
      if (files.length > MAX_EXPERIMENT_FILES) {
        throw new Error(`Experiment changes ${files.length} files; the safe return limit is ${MAX_EXPERIMENT_FILES}`);
      }
      const stat = statOutput.trim();
      return {
        patch,
        bytes,
        sha256: createHash("sha256").update(patch).digest("hex"),
        files,
        stat,
      };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  async apply(relation: WorktreeRelation, candidate: WorktreePatch): Promise<void> {
    this.assertManagedRelation(relation);
    await this.assertRegistered(relation);
    const [headOutput, status] = await Promise.all([
      git(relation.mainWorkspace, ["rev-parse", "HEAD"]),
      git(relation.mainWorkspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    const head = headOutput.trim();
    if (head !== relation.baseCommit) throw new Error("Main workspace HEAD changed since the experiment started; apply manually after review");
    if (status) throw new Error("Main workspace changed since the experiment started; apply manually after preserving those changes");
    if (candidate.patch.length === 0) return;
    await gitWithInput(relation.mainWorkspace, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], candidate.patch);
    await gitWithInput(relation.mainWorkspace, ["apply", "--binary", "--whitespace=nowarn", "-"], candidate.patch);
    const applied = await this.capturePatch({ ...relation, path: relation.mainWorkspace });
    if (applied.sha256 !== candidate.sha256) {
      throw new Error("Applied workspace diff does not match the reviewed candidate; both workspaces were preserved for manual recovery");
    }
  }

  async remove(relation: WorktreeRelation, expected?: WorktreePatch): Promise<string | undefined> {
    this.assertManagedRelation(relation);
    const ownedAdmin = await this.boundAdministration(relation);
    if (expected) {
      const current = await this.capturePatch(relation);
      if (current.sha256 !== expected.sha256 || current.bytes !== expected.bytes) {
        throw new Error("Candidate changed after review; refusing destructive worktree cleanup");
      }
    } else {
      const exists = await access(relation.path).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (exists) {
        const status = await git(relation.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        if (status) throw new Error("Managed worktree has unreviewed changes; refusing destructive cleanup");
      }
    }
    const [, worktreeOutput] = await Promise.all([
      this.assertSameRepository(relation.mainWorkspace),
      git(relation.mainWorkspace, ["worktree", "list", "--porcelain"]),
    ]);
    const entries = parseWorktrees(worktreeOutput);
    const entry = entries.find((candidate) => candidate.path === path.resolve(relation.path));
    if (entry && entry.branch !== relation.branch) {
      throw new Error("Worktree branch relation changed; refusing a destructive operation");
    }
    let preservedPath: string | undefined;
    if (entry) {
      // External editors cannot be locked out of a Git worktree. Retain its bytes
      // by atomic rename instead of force-deleting after a non-atomic snapshot.
      // Even ignored files written after capture and open file descriptors survive.
      const recoveryRoot = path.join(path.dirname(this.managedRoot), "recovery", this.projectKey);
      await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
      if (await realpath(recoveryRoot) !== recoveryRoot) throw new Error("Worktree recovery path resolves outside Casper state");
      if (await this.boundAdministration(relation) !== ownedAdmin) throw new Error("Worktree administration identity changed during cleanup");
      const admin = ownedAdmin;
      preservedPath = path.join(recoveryRoot, `${path.basename(relation.path)}-${randomUUID()}`);
      await rename(relation.path, preservedPath);
      try {
        // Git has no unregister-only command. Repair only this registration onto
        // a private, empty placeholder, then remove that placeholder. Candidate
        // bytes and the old pathname are never passed to a deleting command.
        // Unlike repository-wide prune this cannot drop unrelated worktree indexes.
        const placeholder = await mkdtemp(path.join(recoveryRoot, ".unregister-"));
        await writeFile(path.join(placeholder, ".git"), `gitdir: ${admin}\n`, { flag: "wx", mode: 0o600 });
        await git(relation.mainWorkspace, ["worktree", "repair", placeholder]);
        await git(relation.mainWorkspace, ["worktree", "remove", "--force", placeholder]);
      } catch (error) {
        throw new WorktreeCleanupError(`unregister failed: ${errorText(error)}`, preservedPath);
      }
    }
    const branchExists = await git(relation.mainWorkspace, ["show-ref", "--verify", "--quiet", `refs/heads/${relation.branch}`]).then(() => true, () => false);
    if (branchExists) await git(relation.mainWorkspace, ["branch", "-D", relation.branch], { maxBuffer: 64 * 1024 }).catch((error) => {
      if (preservedPath) throw new WorktreeCleanupError(errorText(error), preservedPath);
      throw error;
    });
    return preservedPath;
  }

  private async assertSameRepository(workspace: string): Promise<void> {
    const common = (await git(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const canonical = await realpath(path.resolve(workspace, common)).catch(() => path.resolve(workspace, common));
    if (canonical !== this.commonDir) throw new Error("Workspace does not belong to the expected Git repository");
  }

  private async assertRegistered(relation: WorktreeRelation): Promise<void> {
    this.assertManagedPath(relation.path, relation.path !== relation.mainWorkspace);
    const [, worktreeOutput] = await Promise.all([
      this.assertSameRepository(relation.mainWorkspace),
      git(relation.mainWorkspace, ["worktree", "list", "--porcelain"]),
    ]);
    const entries = parseWorktrees(worktreeOutput);
    const expectedPath = path.resolve(relation.path);
    const entry = entries.find((candidate) => candidate.path === expectedPath);
    if (!entry) throw new Error(`Worktree is no longer registered: ${expectedPath}`);
    if (relation.path !== relation.mainWorkspace) {
      if (entry.branch !== relation.branch) throw new Error("Worktree branch relation changed; refusing a destructive operation");
      await this.boundAdministration(relation);
    }
  }

  private async boundAdministration(relation: WorktreeRelation): Promise<string> {
    const admin = (await git(relation.path, ["rev-parse", "--absolute-git-dir"])).trim();
    if (path.dirname(admin) !== path.join(this.commonDir, "worktrees")) throw new Error("Unexpected linked-worktree administration path");
    const [backlink, head, canonical] = await Promise.all([
      readFile(path.join(admin, "gitdir"), "utf8"),
      git(relation.path, ["symbolic-ref", "HEAD"]),
      realpath(relation.path),
    ]);
    if (canonical !== relation.path || path.resolve(backlink.trim()) !== path.join(relation.path, ".git") || head.trim() !== `refs/heads/${relation.branch}`) {
      throw new Error("Worktree administration does not belong to the approved path and branch");
    }
    return admin;
  }

  private assertManagedPath(candidate: string, required = true): void {
    if (!required) return;
    const resolved = path.resolve(candidate);
    const relative = path.relative(path.resolve(this.managedRoot), resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) {
      throw new Error("Refusing to operate on a worktree outside Casper's managed directory");
    }
  }

  private assertManagedPlan(plan: WorktreePlan): void {
    this.assertManagedPath(plan.path);
    const sessionName = plan.branch.startsWith("casper/") ? plan.branch.slice("casper/".length) : "";
    if (!SESSION_BRANCH_PATTERN.test(sessionName) || path.basename(plan.path) !== slug(sessionName)
      || path.resolve(plan.sourceWorkspace) !== this.primaryWorkspace
      || plan.mainWorkspace !== this.primaryWorkspace
      || !/^[0-9a-f]{40,64}$/i.test(plan.baseCommit)) {
      throw new Error("Invalid managed worktree plan");
    }
  }

  private assertManagedRelation(relation: WorktreeRelation): void {
    const isMain = relation.path === relation.mainWorkspace;
    this.assertManagedPath(relation.path, !isMain);
    const sessionName = relation.branch.startsWith("casper/") ? relation.branch.slice("casper/".length) : "";
    if (relation.mainWorkspace !== this.primaryWorkspace
      || !/^[0-9a-f]{40,64}$/i.test(relation.baseCommit)
      || (!isMain && (!SESSION_BRANCH_PATTERN.test(sessionName) || path.basename(relation.path) !== slug(sessionName)))) {
      throw new Error("Invalid managed worktree relation");
    }
  }
}
