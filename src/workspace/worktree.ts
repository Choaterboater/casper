import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { safeGitArgs } from "../platform/git";
import { isOutside } from "../platform/inside";

const execFileAsync = promisify(execFile);

/**
 * Like Promise.all, but waits for every call to end before failing with the first error (in order). With
 * Promise.all a failing git call returned while another git was still running in the folder; on Windows that
 * folder can't be removed or renamed until it ends.
 */
async function allDone<T extends readonly unknown[] | []>(work: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const settled = await Promise.allSettled(work as readonly unknown[]);
  const values: unknown[] = [];
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason;
    values.push(result.value);
  }
  return values as { -readonly [K in keyof T]: Awaited<T[K]> };
}

export const MAX_EXPERIMENT_PATCH_BYTES = 512 * 1024;
export const MAX_EXPERIMENT_FILES = 200;
const STDERR_LIMIT = 16 * 1024;
const SESSION_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A crew copy's branch: casper/crew-<id>-<part>. */
const CREW_BRANCH = /^casper\/crew-[a-z0-9]{6}-[1-9]$/;
export const isCrewBranch = (branch: string): boolean => CREW_BRANCH.test(branch);
/** The subject of the commit a builder's copy starts from when your folder had unsaved changes (never on a branch of yours). */
const FOLDER_START = "Casper: the folder as it was when a builder started";
/** Git's identity for that commit; it is Casper's, never yours. */
const CASPER_IDENTITY = { GIT_AUTHOR_NAME: "Casper", GIT_AUTHOR_EMAIL: "casper@localhost", GIT_COMMITTER_NAME: "Casper", GIT_COMMITTER_EMAIL: "casper@localhost" };

export interface WorktreeRelation {
  kind: "git-worktree";
  mainWorkspace: string;
  path: string;
  branch: string;
  baseCommit: string;
  /** Set when baseCommit is a commit of your folder as it was (unsaved changes included): your HEAD then. */
  startHead?: string;
}

export interface WorktreePlan extends WorktreeRelation {
  sourceWorkspace: string;
  /** A crew copy starts from HEAD next to your uncommitted changes: the status they were planned with. */
  sourceStatus?: string;
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
      const [commonDirOutput, worktreeOutput] = await allDone([
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

  /**
   * A crew copy: part `part` of crew `crewId`, on branch casper/crew-<id>-<part> from HEAD. Unlike an experiment,
   * your folder may have uncommitted changes; they stay in your folder and are not in the copy. With `fromFolder`
   * (the AI's builders) the copy starts from your folder as it is instead: unsaved and new files included, in a
   * commit of Casper's own that no branch of yours points at.
   */
  async planCrew(crewId: string, part: number, sourceWorkspace: string, options: { fromFolder?: boolean } = {}): Promise<WorktreePlan> {
    const source = await realpath(sourceWorkspace).catch(() => path.resolve(sourceWorkspace));
    await this.assertSameRepository(source);
    if (source !== this.primaryWorkspace) throw new Error("A crew starts from the main folder of the project");
    const name = `crew-${crewId}-${part}`;
    if (!isCrewBranch(`casper/${name}`)) throw new Error("Invalid crew name");
    const branch = `casper/${name}`;
    const existing = await git(source, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
    if (existing) throw new Error(`Git branch ${JSON.stringify(branch)} already exists`);
    const [head, status] = await allDone([
      git(source, ["rev-parse", "HEAD"]).catch(() => { throw new Error("A crew needs at least one commit in this project"); }),
      git(source, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    const start = options.fromFolder && status ? await this.folderCommit(source, head.trim()) : undefined;
    return {
      kind: "git-worktree", sourceWorkspace: source, mainWorkspace: this.primaryWorkspace,
      path: path.join(this.managedRoot, slug(name)), branch, sourceStatus: status,
      ...(start && start !== head.trim() ? { baseCommit: start, startHead: head.trim() } : { baseCommit: head.trim() }),
    };
  }

  /** The tree of your folder as it is now (unsaved and new files, not ignored ones), from a copy of Git's index so
   * yours is not touched and unchanged files are not read again. */
  private async folderTree(workspace: string): Promise<string> {
    const temp = await mkdtemp(path.join(os.tmpdir(), "casper-folder-index-"));
    const env = { ...process.env, GIT_INDEX_FILE: path.join(temp, "index") };
    try {
      const index = path.resolve(workspace, (await git(workspace, ["rev-parse", "--git-path", "index"])).trim());
      await copyFile(index, env.GIT_INDEX_FILE).catch(() => git(workspace, ["read-tree", "HEAD"], { env }));
      await git(workspace, ["add", "--all", "--", "."], { env });
      return (await git(workspace, ["write-tree"], { env })).trim();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  /** A commit of your folder as it is, on top of HEAD; HEAD itself when nothing differs. */
  private async folderCommit(workspace: string, head: string): Promise<string> {
    const tree = await this.folderTree(workspace);
    if (tree === (await git(workspace, ["rev-parse", `${head}^{tree}`])).trim()) return head;
    return (await git(workspace, ["commit-tree", "--no-gpg-sign", tree, "-p", head, "-m", FOLDER_START], { env: { ...process.env, ...CASPER_IDENTITY } })).trim();
  }

  /** The crew copies of this project that are still here (kept to look at, or left by a crash), oldest name first. */
  async crewCopies(): Promise<WorktreeRelation[]> {
    const entries = parseWorktrees(await git(this.primaryWorkspace, ["worktree", "list", "--porcelain"]));
    const copies: WorktreeRelation[] = [];
    for (const entry of entries) {
      if (!entry.branch || !isCrewBranch(`${entry.branch}`)) continue;
      if (entry.path !== path.join(this.managedRoot, slug(entry.branch.slice("casper/".length)))) continue;
      // Where the copy started: where its branch meets your HEAD. A builder can't commit in the sandbox, but with
      // it off one could, and its commits must stay in the patch.
      const base = (await git(this.primaryWorkspace, ["merge-base", "HEAD", `refs/heads/${entry.branch}`]).catch(() => "")).trim();
      if (!/^[0-9a-f]{40,64}$/i.test(base)) continue;
      // A copy that started from your folder as it was starts at Casper's commit of it, right after your HEAD.
      const first = (await git(this.primaryWorkspace, ["log", "--reverse", "--format=%H%x00%P%x00%s", `${base}..refs/heads/${entry.branch}`]).catch(() => ""))
        .split("\n", 1)[0]!.split("\0");
      const start = first[2] === FOLDER_START && first[1] === base && /^[0-9a-f]{40,64}$/i.test(first[0] ?? "") ? first[0]! : undefined;
      copies.push({ kind: "git-worktree", mainWorkspace: this.primaryWorkspace, path: entry.path, branch: entry.branch,
        ...(start ? { baseCommit: start, startHead: base } : { baseCommit: base }) });
    }
    return copies.sort((a, b) => a.branch.localeCompare(b.branch));
  }

  /**
   * A crew's reviewed work onto your folder, uncommitted. Your own changes stay. Nothing is applied when you made a
   * commit since the crew started, or when its lines clash with yours. With `wholeFiles` (the AI's builders, applied
   * with no question) nothing is applied when a file it changed was changed in your folder after its copy started.
   */
  async applyCrew(relation: WorktreeRelation, candidate: WorktreePatch, options: { wholeFiles?: boolean } = {}): Promise<void> {
    this.assertManagedRelation(relation);
    if (!isCrewBranch(relation.branch)) throw new Error("Not a crew copy");
    await this.assertRegistered(relation);
    const head = (await git(relation.mainWorkspace, ["rev-parse", "HEAD"])).trim();
    if (head !== (relation.startHead ?? relation.baseCommit)) throw new Error("Your folder has a new commit since the crew started; nothing was applied");
    if (candidate.patch.length === 0) return;
    // A whole file, not only the lines: a change next to yours in the same file is not merged in either.
    const changed = options.wholeFiles ? await this.changedInFolder(relation, candidate.files) : [];
    if (changed.length) {
      throw new Error(`${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ` and ${changed.length - 5} more` : ""} changed in your folder too; nothing was applied`);
    }
    try { await gitWithInput(relation.mainWorkspace, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], candidate.patch); }
    catch { throw new Error("A file the crew changed was changed in your folder too; nothing was applied"); }
    await gitWithInput(relation.mainWorkspace, ["apply", "--binary", "--whitespace=nowarn", "-"], candidate.patch);
  }

  /** Which of these files in your folder differ from where the copy started (changed by you, the AI or another
   * builder since): new and deleted files too. */
  async changedInFolder(relation: WorktreeRelation, files: readonly string[]): Promise<string[]> {
    if (!files.length) return [];
    const now = await this.folderTree(relation.mainWorkspace);
    const output = await git(relation.mainWorkspace, ["diff-tree", "-r", "--name-only", "-z", "--no-renames", relation.baseCommit, now, "--",
      ...files.map((file) => `:(literal)${file}`)]);
    return output.split("\0").filter(Boolean);
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
    const [currentHead, status] = await allDone([
      git(plan.sourceWorkspace, ["rev-parse", "HEAD"]),
      git(plan.sourceWorkspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    if (currentHead.trim() !== (plan.startHead ?? plan.baseCommit) || status !== (plan.sourceStatus ?? "")) {
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
        ...(plan.startHead ? { startHead: plan.startHead } : {}),
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
    // Git run with a vanished cwd reports `posix_spawn 'git'`, which reads as "git is missing".
    if (relation.path !== relation.mainWorkspace) {
      await access(relation.path).catch((error: NodeJS.ErrnoException) => {
        throw error.code === "ENOENT" ? new Error(`Experiment worktree is missing: ${relation.path}`) : error;
      });
    }
    await this.assertRegistered(relation);
  }

  async capturePatch(relation: WorktreeRelation): Promise<WorktreePatch> {
    await this.validate(relation);
    const ignored = (await git(relation.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]))
      .split("\0").filter(Boolean);
    // A crew copy keeps what its checks left behind (caches, logs): files git ignores are not part of its work.
    if (ignored.length && relation.path !== relation.mainWorkspace && !isCrewBranch(relation.branch)) {
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
      const [patch, names, statOutput] = await allDone([
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
    const [headOutput, status] = await allDone([
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
    const [, worktreeOutput] = await allDone([
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
    const [, worktreeOutput] = await allDone([
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
    // Git on Windows prints C:/... with forward slashes; resolve before comparing with Casper's own paths.
    const admin = path.resolve((await git(relation.path, ["rev-parse", "--absolute-git-dir"])).trim());
    if (path.dirname(admin) !== path.join(this.commonDir, "worktrees")) throw new Error("Unexpected linked-worktree administration path");
    const [backlink, head, canonical] = await allDone([
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
    if (!relative || isOutside(relative) || relative.includes(path.sep)) {
      throw new Error("Refusing to operate on a worktree outside Casper's managed directory");
    }
  }

  private assertManagedPlan(plan: WorktreePlan): void {
    this.assertManagedPath(plan.path);
    const sessionName = plan.branch.startsWith("casper/") ? plan.branch.slice("casper/".length) : "";
    if (!SESSION_BRANCH_PATTERN.test(sessionName) || path.basename(plan.path) !== slug(sessionName)
      || path.resolve(plan.sourceWorkspace) !== this.primaryWorkspace
      || plan.mainWorkspace !== this.primaryWorkspace
      || !/^[0-9a-f]{40,64}$/i.test(plan.baseCommit) || (plan.startHead !== undefined && !/^[0-9a-f]{40,64}$/i.test(plan.startHead))) {
      throw new Error("Invalid managed worktree plan");
    }
  }

  private assertManagedRelation(relation: WorktreeRelation): void {
    const isMain = relation.path === relation.mainWorkspace;
    this.assertManagedPath(relation.path, !isMain);
    const sessionName = relation.branch.startsWith("casper/") ? relation.branch.slice("casper/".length) : "";
    if (relation.mainWorkspace !== this.primaryWorkspace
      || !/^[0-9a-f]{40,64}$/i.test(relation.baseCommit) || (relation.startHead !== undefined && !/^[0-9a-f]{40,64}$/i.test(relation.startHead))
      || (!isMain && (!SESSION_BRANCH_PATTERN.test(sessionName) || path.basename(relation.path) !== slug(sessionName)))) {
      throw new Error("Invalid managed worktree relation");
    }
  }
}
