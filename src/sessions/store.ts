import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorktreeRelation } from "../workspace/worktree";

export type SessionBranchStatus = "open" | "applied" | "discarded";

export interface NamedSessionBranch {
  name: string;
  parent: string | null;
  sessionId: string;
  sessionFile: string;
  workspacePath: string;
  gitBranch: string | null;
  worktree?: WorktreeRelation;
  status: SessionBranchStatus;
  cleanupPending?: boolean;
  preservedPath?: string;
  createdAt: string;
  updatedAt: string;
}

interface BranchDocument {
  version: 1;
  projectKey: string;
  primaryWorkspace: string;
  branches: NamedSessionBranch[];
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function validWorktree(value: unknown): value is WorktreeRelation {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<WorktreeRelation>;
  return item.kind === "git-worktree"
    && validString(item.mainWorkspace)
    && validString(item.path)
    && validString(item.branch)
    && /^[0-9a-f]{40,64}$/i.test(item.baseCommit ?? "");
}

function validBranch(value: unknown): value is NamedSessionBranch {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<NamedSessionBranch>;
  return validString(item.name)
    && (item.parent === null || validString(item.parent))
    && validString(item.sessionId)
    && validString(item.sessionFile)
    && validString(item.workspacePath)
    && (item.gitBranch === null || validString(item.gitBranch))
    && (item.worktree === undefined || validWorktree(item.worktree))
    && ["open", "applied", "discarded"].includes(item.status ?? "")
    && (item.cleanupPending === undefined || typeof item.cleanupPending === "boolean")
    && (item.preservedPath === undefined || validString(item.preservedPath))
    && validString(item.createdAt)
    && validString(item.updatedAt);
}

function parseDocument(source: string, filePath: string, projectKey: string): BranchDocument {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new Error(`Invalid Casper session branch state: ${filePath}`); }
  if (typeof value !== "object" || value === null) throw new Error(`Invalid Casper session branch state: ${filePath}`);
  const document = value as Partial<BranchDocument>;
  if (document.version !== 1 || document.projectKey !== projectKey || !validString(document.primaryWorkspace)
    || !Array.isArray(document.branches) || !document.branches.every(validBranch)) {
    throw new Error(`Invalid Casper session branch state: ${filePath}`);
  }
  const names = new Set<string>();
  for (const branch of document.branches) {
    if (names.has(branch.name)) throw new Error(`Duplicate Casper session branch in ${filePath}: ${branch.name}`);
    names.add(branch.name);
  }
  return document as BranchDocument;
}

export function sessionProjectKey(identity: string): string {
  return createHash("sha256").update(path.resolve(identity)).digest("hex").slice(0, 20);
}

export class SessionBranchStore {
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    private document: BranchDocument,
    readonly filePath: string,
  ) {}

  static async open(options: {
    projectKey: string;
    primaryWorkspace: string;
    homeDir?: string;
  }): Promise<SessionBranchStore> {
    const home = options.homeDir ?? os.homedir();
    const filePath = path.join(home, ".casper", "sessions", `${options.projectKey}.json`);
    let document: BranchDocument;
    try {
      document = parseDocument(await readFile(filePath, "utf8"), filePath, options.projectKey);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      document = {
        version: 1,
        projectKey: options.projectKey,
        primaryWorkspace: path.resolve(options.primaryWorkspace),
        branches: [],
      };
    }
    return new SessionBranchStore(document, filePath);
  }

  get primaryWorkspace(): string {
    return this.document.primaryWorkspace;
  }

  list(): NamedSessionBranch[] {
    return this.document.branches.map((branch) => structuredClone(branch));
  }

  get(name: string): NamedSessionBranch | undefined {
    const branch = this.document.branches.find((candidate) => candidate.name === name);
    return branch ? structuredClone(branch) : undefined;
  }

  async upsert(branch: NamedSessionBranch): Promise<void> {
    await this.upsertMany([branch]);
  }

  async upsertMany(branches: NamedSessionBranch[]): Promise<void> {
    return this.enqueue(branches);
  }

  async insert(branch: NamedSessionBranch, alongside: NamedSessionBranch[] = []): Promise<void> {
    return this.enqueue([...alongside, branch], branch.name);
  }

  private enqueue(branches: NamedSessionBranch[], createOnlyName?: string): Promise<void> {
    if (!branches.every(validBranch)) return Promise.reject(new Error("Invalid session branch record"));
    const mutation = this.mutationTail.then(() => this.mergeAndPersist(branches, createOnlyName));
    this.mutationTail = mutation.catch(() => {});
    return mutation;
  }

  private async mergeAndPersist(branches: NamedSessionBranch[], createOnlyName?: string): Promise<void> {
    const directory = path.dirname(this.filePath);
    const lockPath = `${this.filePath}.lock`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (!acquired) throw new Error(`Casper session branch state is locked: ${this.filePath}`);
    try {
      try {
        this.document = parseDocument(await readFile(this.filePath, "utf8"), this.filePath, this.document.projectKey);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (createOnlyName && this.document.branches.some((candidate) => candidate.name === createOnlyName)) {
        throw new Error(`Session branch already exists: ${createOnlyName}`);
      }
      for (const branch of branches) {
        const index = this.document.branches.findIndex((candidate) => candidate.name === branch.name);
        if (index === -1) this.document.branches.push(structuredClone(branch));
        else this.document.branches[index] = structuredClone(branch);
      }
      this.document.branches.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
      await this.persist();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(this.document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}
