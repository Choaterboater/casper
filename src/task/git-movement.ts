/** Read-only questions about the project's HEAD, separate from Casper's private undo git. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HASH_LIMIT } from "./changes";
import { safeGitArgs } from "../platform/git";
import type { TreeEntry } from "./undo";

const exec = promisify(execFile);
export const GIT_MOVEMENT_UNKNOWN = "Casper cannot separate the task's edits from git's changes (the branch baseline could not be read)";
export const GIT_OVERLAP = "git and the task both changed it; Casper cannot safely separate them";
export const BRANCH_MOVED_LINE = "– The branch moved during this task: changes git brought in are not counted, and undo leaves them alone";

interface ReflogMark { count: number; digest: string }
export type TaskHead = { head: string | null; branch: string | null; prefix: string; reflog?: ReflogMark } | { none: true } | { unavailable: true };

async function projectGit(root: string, args: string[]): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key)) env[key] = value;
  const { stdout } = await exec("git", safeGitArgs(args), { cwd: root, env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    encoding: "buffer", timeout: 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return stdout;
}

/** Bound history reads; an expired, rewritten or over-budget log is never guessed at. */
async function headLog(root: string): Promise<string[]> {
  const raw = (await projectGit(root, ["reflog", "show", "-1001", "--format=%H%x00%gs", "-z", "HEAD"])).toString();
  const fields = raw.split("\0");
  const records: string[] = [];
  for (let at = 0; at + 1 < fields.length; at += 2) records.push(`${fields[at]}\0${fields[at + 1]}`);
  return records;
}
function logMark(records: string[]): ReflogMark {
  const anchor = records.slice(0, 16);
  return { count: anchor.length, digest: createHash("sha256").update(JSON.stringify(anchor)).digest("hex") };
}

export async function taskHead(root: string): Promise<TaskHead> {
  try {
    if ((await projectGit(root, ["rev-parse", "--is-inside-work-tree"])).toString().trim() !== "true") return { unavailable: true };
    const branch = await projectGit(root, ["symbolic-ref", "-q", "HEAD"]).then((out) => out.toString().trim()).catch((error) => {
      if (error.code === 1) return null; // Detached HEAD, not an unreadable branch.
      throw error;
    });
    const head = await projectGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).then((out) => out.toString().trim()).catch((error) => {
      if (error.code === 1 && branch) return null; // An unborn branch.
      throw error;
    });
    if (head !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) return { unavailable: true };
    const prefix = (await projectGit(root, ["rev-parse", "--show-prefix"])).toString().replace(/\r?\n$/, "");
    const reflog = head === null ? logMark([]) : await headLog(root).then(logMark).catch(() => undefined);
    return { head, branch, prefix, ...(reflog ? { reflog } : {}) };
  } catch (error) {
    return /not a git repository/i.test(String((error as { stderr?: Buffer }).stderr ?? "")) ? { none: true } : { unavailable: true };
  }
}

async function entries(root: string, state: Extract<TaskHead, { head: string | null }>): Promise<Map<string, TreeEntry>> {
  const tree = new Map<string, TreeEntry>();
  if (!state.head) return tree;
  const raw = (await projectGit(root, ["ls-tree", "-r", "-z", "--full-name", state.head, "--", "."])).toString();
  for (const record of raw.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) (?:blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (!match || !match[3]!.startsWith(state.prefix)) throw new Error("unreadable tree");
    tree.set(match[3]!.slice(state.prefix.length), { mode: match[1]!, sha: match[2]! });
  }
  return tree;
}

export type GitMovement = { moved: boolean; incoming: Map<string, TreeEntry | undefined>; committed: Set<string> } | { unavailable: string; moved: boolean };

export function headMoved(before: TaskHead, after: TaskHead): boolean {
  return "head" in before && "head" in after && (before.head !== after.head || before.branch !== after.branch);
}

export async function gitMovement(root: string, before: TaskHead, after: TaskHead): Promise<GitMovement> {
  const moved = headMoved(before, after);
  if ("none" in before && "none" in after) return { moved: false, incoming: new Map(), committed: new Set() };
  if (!("head" in before) || !("head" in after) || before.prefix !== after.prefix || (before.head && !after.head)) {
    return { unavailable: GIT_MOVEMENT_UNKNOWN, moved };
  }
  if (!moved && before.reflog?.digest === after.reflog?.digest) return { moved: false, incoming: new Map(), committed: new Set() };
  try {
    const incoming = new Map<string, TreeEntry | undefined>();
    // Keep path provenance even when a later merge's blob includes both contributions, or the
    // task subsequently restores the starting bytes. A final tree comparison loses that history.
    const committed = new Set<string>();
    // A commit (including amend) and a cherry-pick are the task's work, not an incoming branch.
    // Read HEAD's actual transitions, not ancestry: amend replaces a commit, and cherry-pick creates
    // a new one. Checking the retained suffix also catches expired/rewritten reflogs.
    const records = await headLog(root);
    if (!before.reflog || !after.reflog || logMark(records).digest !== after.reflog.digest) throw new Error("unreadable reflog");
    const matches: number[] = [];
    for (let index = before.reflog.count ? 0 : records.length; index <= records.length; index++) {
      if (logMark(records.slice(index, index + before.reflog.count)).digest === before.reflog.digest) matches.push(index);
    }
    if (matches.length !== 1 || matches[0]! > 1000) throw new Error("changed or ambiguous reflog");
    const count = matches[0]!;
    let previous = before;
    let incomingMove = false;
    for (const record of records.slice(0, count).reverse()) {
      const [head, action = ""] = record.split("\0");
      if (!head || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new Error("unreadable reflog entry");
      const next = { ...after, head };
      const own = /^(?:commit(?: \((?:initial|amend)\))?|cherry-pick): /.test(action);
      if (!own) incomingMove = true;
      const [oldTree, newTree] = await Promise.all([entries(root, previous), entries(root, next)]);
      for (const file of new Set([...oldTree.keys(), ...newTree.keys()])) {
        const old = oldTree.get(file), entry = newTree.get(file);
        if (old?.sha !== entry?.sha || old?.mode !== entry?.mode) {
          if (own) committed.add(file);
          else incoming.set(file, entry);
        }
      }
      previous = next;
    }
    if (previous.head !== after.head) throw new Error("missing HEAD transition");
    // A branch can change without a new reflog record (e.g. branch -m); it is still a move.
    return { moved: incomingMove || before.branch !== after.branch, incoming, committed };
  } catch { return { unavailable: GIT_MOVEMENT_UNKNOWN, moved: true }; }
}

/** The file on disk when it is git's copy of `entry` written with Windows line endings (core.autocrlf, eol=crlf), else
 * undefined. Only line endings are compared, so no project filter ever runs; a binary file, a link, a submodule or a
 * blob that already has CR LF is never treated this way. */
export async function crlfCheckout(root: string, file: string, entry: TreeEntry | undefined): Promise<Buffer | undefined> {
  if (!entry || entry.mode === "160000" || entry.mode === "120000") return undefined;
  let disk: Buffer;
  try {
    const full = path.join(root, file);
    const info = await lstat(full);
    if (!info.isFile() || info.size > HASH_LIMIT) return undefined;
    disk = await readFile(full);
  } catch { return undefined; }
  if (!disk.includes(13)) return undefined;
  const blob = await projectBlob(root, entry).catch(() => undefined);
  if (!blob || blob.includes(0) || blob.includes(13)) return undefined;
  return disk.toString("latin1").replace(/\r\n/g, "\n") === blob.toString("latin1") ? disk : undefined;
}

/** Exact blob bytes, never textconv, LFS or a clean/smudge filter. Only called for files Undo already copies. */
export async function projectBlob(root: string, entry: TreeEntry): Promise<Buffer> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.sha)) throw new Error("unreadable blob id");
  return projectGit(root, ["cat-file", "blob", entry.sha]);
}
