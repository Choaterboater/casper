/**
 * The app's side of undo: a copy before and after each task, the saved receipt, and the /undo, /redo, /diff and
 * /receipt commands. Nothing here calls a model. Undo puts back files in this folder only; it says so each time it
 * can't reach something (secret files, big files, nested repositories, MCP servers, devices).
 */
import { crlfCheckout, gitMovement, headMoved, taskHead, projectBlob, GIT_MOVEMENT_UNKNOWN, GIT_OVERLAP, type TaskHead } from "../task/git-movement";
import { storedTaskResult } from "./json-events";
import { undoChangedChoices, undoUnsureChoices } from "./safe-choices";
import type { OutputWriter } from "./commands";
import { tildePath } from "../new/scaffold";
import { readProjectText, removeProjectFile, writeProjectFile } from "../platform/files";
import type { RuntimeSession } from "../runtime/types";
import { RECEIPTS_KEPT, ReceiptStore, type ReceiptUndo, type StoredReceipt } from "../task/receipts";
import { CHANGED_BY_OTHERS, formatTaskResult, receiptVerdict, receiptView, UNDO_NOTHING_CHANGED, type TaskResult } from "../task/result";
import { receiptDetail } from "../tui/receipt-card";
import path from "node:path";
import { HASH_LIMIT } from "../task/changes";
import { coveredBy, leftOutWhy, UndoStore, type LeftOut, type UndoApplied, type UndoPlan, type UndoSnapshot } from "../task/undo";
import { isSecretFile } from "../secrets/files";
import { redactPreview, terminalText } from "../tui/format";
import { buildNextRow, type NextRow } from "../tui/next-row";
import type { InteractiveTerminal } from "../tui/terminal";
import { isOutside } from "../platform/inside";

export interface UndoHost {
  readonly output: OutputWriter;
  readonly terminal: InteractiveTerminal;
  readonly interactive: boolean;
  /** --verbose: /receipt prints the full form, never the card. */
  readonly verbose?: boolean;
  /** The conversation, only when it is already running (undo never starts a model session). */
  readonly liveSession?: RuntimeSession;
  readonly homeDir: string;
  stateDirectory(): string | undefined;
  /** The folder tasks run in now (a /branch work tree, or the project). */
  activeRoot(): string;
  /** Reads the project's settings again after a setting was undone or redone. */
  reloadProject(): Promise<void>;
  /** The last task's result in this session, for /receipt with no number. */
  lastTask(): TaskResult | undefined;
}

/** What a task keeps from its start: the copy, the conversation position, and the conversation. */
export interface TaskUndoStart {
  root: string;
  head: TaskHead;
  snapshot: UndoSnapshot;
  mark: string | null | undefined;
  sessionId: string | null;
}

const MAX_NAMES = 8;
const USAGE = { undo: "Usage: /undo [task number]", redo: "Usage: /redo [task number]", diff: "Usage: /diff [task number | list]", receipt: "Usage: /receipt [task number | list]" };

/** An undo or redo that did nothing because it can't: a one-shot run exits 1 with this message. */
export class UndoRefused extends Error {
  override readonly name = "UndoRefused";
}

function names(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_NAMES).map((file) => terminalText(file)).join(", ");
  return paths.length > MAX_NAMES ? `${shown} … +${paths.length - MAX_NAMES} more` : shown;
}

function files(count: number): string { return `${count} ${count === 1 ? "file" : "files"}`; }

function sessionIdOf(session: RuntimeSession | undefined): string | null {
  try { return session?.getSessionInfo?.().sessionId ?? null; } catch { return null; }
}

function markOf(session: RuntimeSession | undefined): string | null | undefined {
  try { return session?.conversationMark?.(); } catch { return undefined; }
}

/** A task whose files Casper has copies of. */
export type UndoableTask = StoredReceipt & { undo: ReceiptUndo };

function hasCopies(receipt: StoredReceipt): receipt is UndoableTask {
  return Boolean(receipt.undo && "before" in receipt.undo && receipt.undo.paths.length);
}

export class TaskUndo {
  /** The files the last /undo or /redo put back (a one-shot --json run reports them as changed). */
  lastRestored: string[] = [];

  constructor(private readonly host: UndoHost) {}

  private receipts(): ReceiptStore | undefined {
    const state = this.host.stateDirectory();
    return state ? new ReceiptStore(state) : undefined;
  }

  private store(root: string): UndoStore | undefined {
    const state = this.host.stateDirectory();
    return state ? new UndoStore({ stateDirectory: state, root }) : undefined;
  }

  private write(text: string): void { this.host.output.write(text); }

  private offer(row: NextRow | undefined): void { if (this.host.interactive) this.host.terminal.offerNext(row); }

  /** Refuses in words: printed in a session, an error (exit 1) in a one-shot run. */
  private refuse(message: string): void {
    if (!this.host.interactive) throw new UndoRefused(message);
    this.write(`${message}\n`);
  }

  // ---- A task ------------------------------------------------------------------------------------------------

  /** Before the task: a copy of the folder and where the conversation is. Never throws. */
  async begin(root: string, session: RuntimeSession | undefined, signal?: AbortSignal): Promise<TaskUndoStart> {
    const store = this.store(root);
    const head = await taskHead(root);
    const snapshot: UndoSnapshot = store ? await store.snapshot(signal) : { unavailable: "Casper has no state folder for this project" };
    return { root, head, snapshot, mark: markOf(session), sessionId: sessionIdOf(session) };
  }

  /** After the receipt's checks: the second copy, the saved receipt, and what the receipt says about undo. Never
   * throws: a failure makes undo unavailable, with the reason. Returns the change summary (--stat) to print. */
  async finish(start: TaskUndoStart, input: { request: string; task: TaskResult; session: RuntimeSession | undefined; servers: readonly string[] }): Promise<{ stat: string }> {
    const { task } = input;
    let undo: StoredReceipt["undo"] = null;
    let stat = "";
    const store = this.store(start.root);
    const endHead = await taskHead(start.root);
    const movement = await gitMovement(start.root, start.head, endHead);
    const blocked: Array<{ path: string; why: string }> = [];
    const gitOnly = new Set<string>();
    const committedOverlap = new Set<string>();
    // A committed edit still counts when a later edit restores its starting bytes. Undo remains
    // snapshot-based: identical ending bytes need no restoration, and HEAD is never rewritten.
    if ("committed" in movement && task.changedPaths) task.changedPaths = [...new Set([...task.changedPaths,
      ...[...movement.committed].filter((file) => !task.changedDuringChecks?.includes(file))])].sort();
    let afterSnapshot: UndoSnapshot | undefined;
    if (movement.moved) task.branchMoved = true;
    else delete task.branchMoved;
    let protectionUnknown = "unavailable" in movement;
    let uncertain = "unavailable" in movement ? movement.unavailable : undefined;
    if (!uncertain && movement.moved && "incoming" in movement && store && "tree" in start.snapshot) {
      try {
        afterSnapshot = await store.snapshot();
        if (!("tree" in afterSnapshot)) throw new Error("no ending copy");
        const copied = new Set([...await store.files(start.snapshot.tree), ...await store.files(afterSnapshot.tree)]);
        const replacements = new Map<string, { mode: string; data: Buffer } | undefined>();
        for (const [file, entry] of movement.incoming) {
          // On Windows git writes text with CR LF (core.autocrlf): those exact bytes are still git's own copy.
          const checkout = await crlfCheckout(start.root, file, entry);
          const own = movement.committed.has(file);
          if (!own && (checkout || await store.matchesHead(file, entry))) gitOnly.add(file);
          else blocked.push({ path: file, why: GIT_OVERLAP });
          // Never import a secret, oversized or otherwise excluded file into the private undo store.
          const excluded = [...start.snapshot.left, ...afterSnapshot.left].some((left) => coveredBy([left.path], file));
          if (!copied.has(file) || excluded || isSecretFile(file)) continue;
          // The merge blob contains the task's committed work too. Do not overlay it onto the
          // baseline or erase its path just because the checkout matches that combined blob.
          if (own) { committedOverlap.add(file); continue; }
          if (entry?.mode === "160000") throw new Error("incoming nested repository");
          const data = entry ? checkout ?? await projectBlob(start.root, entry) : undefined;
          if (data && data.length > HASH_LIMIT) throw new Error("incoming file is too big to copy");
          replacements.set(file, entry && data ? { mode: entry.mode, data } : undefined);
        }
        start.snapshot = { ...start.snapshot, tree: await store.overlay(start.snapshot.tree, replacements) };
        task.changedPaths = task.changedPaths?.filter((file) => !gitOnly.has(file));
        task.changedDuringChecks = task.changedDuringChecks?.filter((file) => !gitOnly.has(file));
        // Restoring the starting bytes after git changed them is still an edit against the new HEAD.
        if (task.changedPaths) task.changedPaths = [...new Set([...task.changedPaths,
          ...blocked.filter((entry) => copied.has(entry.path) && !task.changedDuringChecks?.includes(entry.path)).map((entry) => entry.path)])].sort();
        task.changedWhilePlanning = task.changedWhilePlanning?.filter((file) => !gitOnly.has(file));
      } catch { uncertain = GIT_MOVEMENT_UNKNOWN; }
    }
    if (movement.moved && "incoming" in movement) {
      const stable = await taskHead(start.root);
      if (!("head" in stable) || headMoved(endHead, stable)) { protectionUnknown = true; uncertain = GIT_MOVEMENT_UNKNOWN; }
    }
    if (uncertain && ("tree" in start.snapshot || movement.moved)) {
      start.snapshot = { unavailable: uncertain };
      task.branchChangesUnknown = true;
      task.changedPaths = undefined;
      task.changedDuringChecks = undefined;
      task.snapshotFailure = { reason: uncertain, edited: [] };
    }
    const changed = [...new Set([...(task.changedPaths ?? []), ...(task.changedDuringChecks ?? [])])];
    if (!("tree" in start.snapshot) || !store) {
      const reason = "unavailable" in start.snapshot ? start.snapshot.unavailable : "Casper has no state folder for this project";
      task.undo = task.branchChangesUnknown || changed.length || task.possibleMutations ? { available: false, reason } : { available: false, reason: UNDO_NOTHING_CHANGED };
      undo = { unavailable: reason };
    } else {
      const after = afterSnapshot ?? await store.snapshot();
      if (!("tree" in after)) {
        task.undo = { available: false, reason: after.unavailable };
        undo = { unavailable: after.unavailable };
      } else {
        const before = start.snapshot;
        // A file in the second copy but not the first is one the task made, unless it was already there and simply
        // not copied (git ignored it, it was over 8 MB, or it was inside a nested repository). Undo would delete
        // such a file, so it is left out of the task's files and named as one undo can't put back.
        const notCopiedBefore = (file: string): LeftOut | undefined => {
          const left = before.left.find((entry) => entry.path === file || coveredBy([entry.path], file));
          if (left) return { path: file, why: left.why };
          return coveredBy(before.ignored, file) ? { path: file, why: isSecretFile(file) ? "secret" : "not copied" } : undefined;
        };
        // The other way round: a file in the first copy but not the second is one the task deleted, unless it is still
        // there and simply not copied now (the task made it over 8 MB, or made its folder a nested repository). Undo
        // would find it "changed since" and refuse everything, so it is left out and named too.
        const notCopiedAfter = (file: string): LeftOut | undefined => {
          const left = after.left.find((entry) => entry.path === file || coveredBy([entry.path], file));
          return left ? { path: file, why: left.why } : undefined;
        };
        const kept: LeftOut[] = [];
        // Another program's files (changed while none of the AI's tools that write ran) are never undone.
        const others = new Set(task.changedNotByModel ?? []);
        const leftToOthers: string[] = [];
        const paths = (await store.changes(before.tree, after.tree).catch(() => [])).flatMap((change) => {
          if (gitOnly.has(change.path)) return [];
          if (others.has(change.path)) { leftToOthers.push(change.path); return []; }
          const already = !change.from && change.to ? notCopiedBefore(change.path) : change.from && !change.to ? notCopiedAfter(change.path) : undefined;
          if (already) { kept.push(already); return []; }
          return [change.path];
        });
        for (const file of committedOverlap) if (!paths.includes(file)) paths.push(file);
        paths.sort();
        // Files the task's own tools edited that no copy holds (ignored, secret), and files the task changed inside a
        // nested repository: undo can't put them back either.
        const edited = (task.observedEdits ?? []).flatMap((file) => {
          const relative = path.relative(start.root, path.resolve(start.root, file)).split(path.sep).join("/");
          return relative && !isOutside(relative) ? [relative] : [];
        });
        const all = [...before.left, ...after.left, ...kept];
        // The nested repositories the copies left out, one entry each (kept only names files inside them).
        const nested = [...before.left, ...after.left].flatMap((entry) => entry.why === "nested repo" ? [entry.path] : []);
        const inPaths = new Set(paths), named = new Set(all.map((entry) => entry.path)), editedSet = new Set(edited);
        const inside = new Map<string, string[]>();
        for (const file of new Set([...(nested.length ? changed : []), ...edited])) {
          if (inPaths.has(file) || named.has(file)) continue;
          const repo = nested.length ? coveredBy(nested, file) : undefined;
          if (repo !== undefined) { const list = inside.get(repo); if (list) list.push(file); else inside.set(repo, [file]); continue; }
          if (!editedSet.has(file)) continue;
          const ignored = coveredBy(before.ignored, file) ?? coveredBy(after.ignored, file);
          if (ignored !== undefined || isSecretFile(file)) all.push({ path: file, why: isSecretFile(file) ? "secret" : "ignored" });
        }
        const wanted = new Set([...changed, ...edited, ...kept.map((entry) => entry.path)]);
        // A nested repository with many changed files (a clone, an install) is named once, so the receipt stays small.
        for (const [repo, files] of inside) {
          if (files.length > MAX_NAMES) { all.push({ path: repo, why: "nested repo" }); wanted.add(repo); }
          else all.push(...files.map((file): LeftOut => ({ path: file, why: "nested repo" })));
        }
        const unique = [...new Map(all.filter((entry) => wanted.has(entry.path)).map((entry) => [entry.path, entry])).values()]
          .sort((a, b) => a.path.localeCompare(b.path));
        const left = unique.map((entry) => ({ path: entry.path, why: leftOutWhy(entry) }));
        if (paths.length) {
          task.undo = { available: true, ...(left.length ? { left } : {}) };
          stat = await store.diff(before.tree, after.tree, { stat: true, ...(movement.moved || kept.length ? { paths } : {}) }).catch(() => "");
        } else task.undo = { available: false, reason: left.length
          ? `Casper keeps no copy of ${names(unique.map((entry) => entry.why === "nested repo" ? `${entry.path} (${leftOutWhy(entry)})` : entry.path))}` : UNDO_NOTHING_CHANGED };
        const overlap = blocked.filter((entry) => paths.includes(entry.path));
        if (overlap.length) {
          const left = [...(task.undo?.available ? task.undo.left ?? [] : []), ...overlap];
          task.undo = paths.some((file) => !overlap.some((entry) => entry.path === file))
            ? { available: true, left } : { available: false, reason: `${names(overlap.map((entry) => entry.path))}: ${GIT_OVERLAP}` };
        }
        const unsure = (task.changedUnsure ?? []).filter((file) => paths.includes(file));
        undo = { before: before.tree, after: after.tree, paths, left: unique, ...(overlap.length ? { blocked: overlap } : {}),
          ...(leftToOthers.length ? { others: leftToOthers.sort() } : {}), ...(unsure.length ? { unsure } : {}),
          ...(input.servers.length ? { servers: [...input.servers] } : {}) };
      }
    }
    const receipts = this.receipts();
    if (!receipts) return { stat };
    try {
      const n = await receipts.add({ createdAt: new Date().toISOString(), kind: "task", request: redactPreview(input.request).slice(0, 200), root: start.root,
        sessionId: start.sessionId ?? sessionIdOf(input.session),
        conversation: start.mark === undefined ? null : { before: start.mark, after: markOf(input.session) ?? null },
        undo, ...(protectionUnknown ? { git: { unavailable: GIT_MOVEMENT_UNKNOWN } }
          : movement.moved && "incoming" in movement ? { git: { incoming: [...movement.incoming.keys()] } } : {}),
        task: storedTaskResult({ ...task, receipt: undefined }) });
      task.receipt = n;
      if (undo && "before" in undo && store) {
        await store.record(n, undo.before, undo.after);
        await store.prune(100, n).catch(() => {});
      }
    } catch (error) {
      if (task.undo?.available) task.undo = { available: false, reason: `Casper could not save the receipt (${error instanceof Error ? error.message : String(error)})` };
    }
    return { stat };
  }

  /** "Next: 1 Show diff · 2 Undo" for a task that can be undone. */
  nextItems(task: TaskResult): { undo?: { label: string; command: string }; diff?: { label: string; command: string } } {
    if (!task.undo?.available || !task.receipt) return {};
    return { undo: { label: "Undo", command: `/undo ${task.receipt}` }, diff: { label: "Show diff", command: `/diff ${task.receipt}` } };
  }

  /** A saved setting (Remember this test command) becomes its own receipt, so /undo takes it back. */
  async recordSetting(root: string, request: string, written: { file: string; line: string; before: string | null; after: string }): Promise<number | undefined> {
    const receipts = this.receipts(), store = this.store(root);
    if (!receipts || !store) return undefined;
    const n = await receipts.add({ createdAt: new Date().toISOString(), kind: "setting", request: redactPreview(request).slice(0, 200), root, sessionId: null,
      conversation: null, undo: null, setting: { file: written.file, line: redactPreview(written.line), before: null, after: "" } });
    const before = written.before === null ? null : await store.storeText(n, "setting-before", written.before);
    const after = await store.storeText(n, "setting-after", written.after);
    await receipts.update(n, (receipt) => ({ ...receipt, setting: { ...receipt.setting!, before, after } }));
    return n;
  }

  // ---- /undo and /redo ---------------------------------------------------------------------------------------

  private async pickReceipt(kind: "undo" | "redo", argument: string): Promise<StoredReceipt | undefined> {
    const receipts = this.receipts();
    if (!/^(?:\d{1,9})?$/.test(argument)) throw new Error(USAGE[kind]);
    const root = this.host.activeRoot();
    if (argument) {
      const found = await receipts?.get(Number(argument)) ?? "missing";
      if (found === "missing") { this.refuse(`No receipt ${Number(argument)}. /receipt list shows recent ones.`); return undefined; }
      if (found === "unreadable") { this.refuse(`Receipt ${Number(argument)} can't be read.`); return undefined; }
      return found;
    }
    const match = kind === "undo"
      ? (receipt: StoredReceipt) => receipt.root === root && (hasCopies(receipt) || Boolean(receipt.setting?.after))
      : (receipt: StoredReceipt) => receipt.root === root && Boolean((receipt.undo && "undone" in receipt.undo && receipt.undo.undone) || receipt.setting?.undone);
    const found = await receipts?.latest(match);
    if (!found) this.refuse(kind === "undo" ? "Nothing to undo in this folder yet." : "Nothing to redo in this folder.");
    return found;
  }

  private sameFolder(receipt: StoredReceipt): boolean {
    if (receipt.root === this.host.activeRoot()) return true;
    this.refuse(`Task ${receipt.n} ran in ${terminalText(tildePath(receipt.root, this.host.homeDir))}; /switch there first.`);
    return false;
  }

  async undo(argument: string, signal?: AbortSignal): Promise<void> {
    this.lastRestored = [];
    const receipt = await this.pickReceipt("undo", argument);
    if (!receipt || !this.sameFolder(receipt)) return;
    if (receipt.setting) { await this.undoSetting(receipt, "undo"); return; }
    const n = receipt.n;
    if (!receipt.undo || "unavailable" in receipt.undo) {
      this.refuse(`Task ${n} can't be undone: ${receipt.undo ? terminalText(receipt.undo.unavailable) : "Casper kept no copy of it"}.`);
      return;
    }
    const undo = receipt.undo;
    if (!undo.paths.length) { this.refuse(`Task ${n} changed no files Casper keeps copies of, so there is nothing to undo.`); return; }
    if (undo.undone) {
      this.refuse(`Task ${n} is already undone.${this.host.interactive ? " 2 Redo" : ` casper /redo ${n} puts its files back.`}`);
      this.offer(buildNextRow({ undo: { label: "Redo", command: `/redo ${n}` } }));
      return;
    }
    const store = this.store(receipt.root)!;
    const incoming = await this.incomingSince(receipt);
    if (!incoming) return;
    const plan = await this.undoPlan(store, undo, undo.paths, incoming);
    if (!(await this.confirmPartial("Undo", n, plan.changedSince, plan.ready.length, signal))) return;
    const unsureLeft = await this.confirmUnsure(n, plan, undo.unsure ?? [], signal);
    if (unsureLeft === undefined) return;
    const applied = await this.putBack(n, store, plan, undo.before, signal);
    if (typeof applied === "string") { this.refuse(`Nothing was undone: ${applied}.`); return; }
    this.lastRestored = applied.restored;
    const lines = [applied.restored.length
      ? `✓ Undone — ${files(applied.restored.length)} ${applied.restored.length === 1 ? "is" : "are"} back as ${applied.restored.length === 1 ? "it was" : "they were"} before task ${n}: ${names(applied.restored)}`
      : `– Nothing was put back for task ${n}.`];
    for (const skipped of applied.skipped) lines.push(`– Not put back: ${terminalText(skipped.path)} (${terminalText(skipped.why)})`);
    if (plan.changedSince.length) lines.push(`– Left as you changed them: ${names(plan.changedSince)}`);
    if (unsureLeft.length) lines.push(`– Left as ${unsureLeft.length === 1 ? "it is" : "they are"}: ${names(unsureLeft)} (Casper can't tell whether task ${n} changed ${unsureLeft.length === 1 ? "it" : "them"})`);
    if (undo.others?.length) lines.push(`– Left as ${undo.others.length === 1 ? "it is" : "they are"}: ${names(undo.others)} (${CHANGED_BY_OTHERS.replace(/^C/, "c")})`);
    lines.push(...this.limits(undo, plan.blocked));
    if (applied.restored.length) lines.push(await this.tellConversation(receipt, applied.restored, "undo"));
    this.write(`${lines.join("\n")}\n`);
    if (applied.restored.length) this.offer(buildNextRow({ undo: { label: "Redo", command: `/redo ${n}` } }));
  }

  /** A newer receipt can make an older task's exact ending bytes committed incoming work. */
  private async incomingSince(receipt: StoredReceipt): Promise<string[] | undefined> {
    const paths = new Set<string>();
    const recent = await this.receipts()?.list(RECEIPTS_KEPT, true).catch(() => undefined);
    if (!recent) {
      this.refuse(`Task ${receipt.n} can't be put back: saved branch changes cannot be read; Casper left everything as it is.`);
      return undefined;
    }
    for (const { n, receipt: later } of recent) {
      if (n <= receipt.n) continue;
      if (typeof later !== "string" && later.root !== receipt.root) continue;
      if (typeof later === "string" || (later.git && "unavailable" in later.git)) {
        this.refuse(`Task ${receipt.n} can't be put back: a later task's branch changes cannot be read; Casper left everything as it is.`);
        return undefined;
      }
      if (later.git && "incoming" in later.git) for (const file of later.git.incoming) paths.add(file);
    }
    return [...paths];
  }

  private async undoPlan(store: UndoStore, undo: ReceiptUndo, paths = undo.paths, incoming: readonly string[] = []): Promise<UndoPlan> {
    const blocked = [...undo.blocked ?? [], ...incoming.filter((file) => paths.includes(file))
      .map((file) => ({ path: file, why: "git brought it in during a later task; Casper left it alone" }))];
    const plan = await store.plan(undo.after, undo.before, paths.filter((file) => !blocked.some((entry) => entry.path === file)));
    plan.blocked.push(...blocked.filter((entry) => paths.includes(entry.path)));
    return plan;
  }

  /** Saves the files as they are now (for /redo), puts back `plan`'s files as task `n` found them and marks the task
   * undone. A string says why nothing was put back. */
  private async putBack(n: number, store: UndoStore, plan: UndoPlan, before: string, signal?: AbortSignal): Promise<UndoApplied | string> {
    const redo = await store.snapshot(signal);
    if (!("tree" in redo)) return `Casper could not save a copy of the files first (${terminalText(redo.unavailable)})`;
    await store.keep(n, "redo", redo.tree);
    const applied = await store.apply(plan.ready, before, signal);
    // Marked undone only when something was put back: an undo that changed nothing can be tried again, and a second
    // Casper's empty undo never replaces the files a first one put back (which /redo needs).
    if (applied.restored.length) {
      await this.receipts()!.update(n, (saved) => (saved.undo as ReceiptUndo).undone ? saved
        : { ...saved, undo: { ...(saved.undo as ReceiptUndo), undone: { at: new Date().toISOString(), restored: applied.restored, redo: redo.tree } } });
    }
    return applied;
  }

  // ---- /rewind -----------------------------------------------------------------------------------------------

  /** The tasks of conversation `sessionId` in this folder that `accepts` takes (by the conversation's position before
   * and after each) and whose files can still be undone, newest first. */
  async tasksAfter(sessionId: string | null, accepts: (conversation: { before: string | null; after: string | null }) => boolean): Promise<UndoableTask[]> {
    const receipts = this.receipts();
    if (!receipts || sessionId === null) return [];
    const root = this.host.activeRoot();
    const found: UndoableTask[] = [];
    for (const { receipt } of await receipts.list(RECEIPTS_KEPT)) {
      if (typeof receipt === "string" || receipt.kind !== "task" || receipt.root !== root || receipt.sessionId !== sessionId) continue;
      if (receipt.conversation && accepts(receipt.conversation) && hasCopies(receipt) && !receipt.undo.undone) found.push(receipt);
    }
    return found;
  }

  /** /rewind's "Conversation and files": puts back the files of `tasks` (newest first), as /undo of each would. When a
   * file changed since, it changes nothing and says so (no question). True when every task's files are back. */
  async undoTasks(tasks: readonly UndoableTask[], signal?: AbortSignal): Promise<boolean> {
    this.lastRestored = [];
    const store = this.store(this.host.activeRoot());
    if (!store || !tasks.length) return Boolean(store);
    const list = tasks.map((task) => task.n).join(", ");
    const incoming = new Set<string>();
    const protectedByTask = new Map<number, string[]>();
    for (const task of tasks) {
      const later = await this.incomingSince(task);
      if (!later) return false;
      protectedByTask.set(task.n, [...new Set([...incoming, ...later])]);
      if (task.git && "incoming" in task.git) for (const file of task.git.incoming) incoming.add(file);
    }
    // First, every file must still be as the newest of these tasks that changed it left it.
    const seen = new Set<string>();
    const changed: string[] = [];
    for (const task of tasks) {
      const fresh = task.undo.paths.filter((file) => !seen.has(file) && Boolean(seen.add(file)));
      if (fresh.length) changed.push(...(await this.undoPlan(store, task.undo, fresh, protectedByTask.get(task.n))).changedSince);
    }
    const stop = (files: readonly string[], n: number) =>
      `${names(files)} changed after task ${n}, so Casper left the files and the conversation as they are. /rewind with 1 Conversation only keeps the files.`;
    if (changed.length) { this.refuse(stop(changed, tasks[0]!.n)); return false; }
    const restored: string[] = [];
    const lines: string[] = [];
    for (const task of tasks) {
      const plan = await this.undoPlan(store, task.undo, task.undo.paths, protectedByTask.get(task.n));
      // Only when a task in between changed a file back by hand: nothing more is put back from here on.
      if (plan.changedSince.length) { lines.push(`– Stopped: ${stop(plan.changedSince, task.n)}`); break; }
      const applied = await this.putBack(task.n, store, plan, task.undo.before, signal);
      if (typeof applied === "string") { lines.push(`– Stopped: nothing more was undone (${applied}).`); break; }
      restored.push(...applied.restored.filter((file) => !restored.includes(file)));
      for (const skipped of applied.skipped) lines.push(`– Not put back: ${terminalText(skipped.path)} (${terminalText(skipped.why)})`);
      lines.push(...this.limits(task.undo, plan.blocked));
    }
    this.lastRestored = restored;
    const stopped = lines.some((line) => line.startsWith("– Stopped"));
    const head = restored.length
      ? `✓ Undone task${tasks.length === 1 ? "" : "s"} ${list} — ${files(restored.length)} ${restored.length === 1 ? "is" : "are"} back as before: ${names(restored)}`
      : `– No files were put back for task${tasks.length === 1 ? "" : "s"} ${list}.`;
    this.write(`${[head, ...lines].join("\n")}\n`);
    return !stopped;
  }

  async redo(argument: string, signal?: AbortSignal): Promise<void> {
    this.lastRestored = [];
    const receipt = await this.pickReceipt("redo", argument);
    if (!receipt || !this.sameFolder(receipt)) return;
    if (receipt.setting) { await this.undoSetting(receipt, "redo"); return; }
    const n = receipt.n;
    const undo = receipt.undo && "before" in receipt.undo ? receipt.undo : undefined;
    if (!undo?.undone) { this.refuse(`Task ${n} is not undone, so there is nothing to redo.`); return; }
    const store = this.store(receipt.root)!;
    const incoming = await this.incomingSince(receipt);
    if (!incoming) return;
    const plan = await store.plan(undo.before, undo.undone.redo, undo.undone.restored.filter((file) => !incoming.includes(file)));
    plan.blocked.push(...undo.undone.restored.filter((file) => incoming.includes(file))
      .map((file) => ({ path: file, why: "git brought it in during a later task; Casper left it alone" })));
    if (!(await this.confirmPartial("Redo", n, plan.changedSince, plan.ready.length, signal))) return;
    const applied = await store.apply(plan.ready, undo.undone.redo, signal);
    this.lastRestored = applied.restored;
    // A redo that put nothing back leaves the task undone, so it can be tried again.
    if (applied.restored.length) {
      await this.receipts()!.update(n, (saved) => {
        const { undone: _undone, ...rest } = saved.undo as ReceiptUndo;
        return { ...saved, undo: rest };
      });
    }
    const lines = [applied.restored.length
      ? `✓ Redone — ${files(applied.restored.length)} ${applied.restored.length === 1 ? "is" : "are"} back as task ${n} left ${applied.restored.length === 1 ? "it" : "them"}: ${names(applied.restored)}`
      : `– Nothing was put back for task ${n}.`];
    for (const skipped of applied.skipped) lines.push(`– Not put back: ${terminalText(skipped.path)} (${terminalText(skipped.why)})`);
    if (plan.changedSince.length) lines.push(`– Left as you changed them: ${names(plan.changedSince)}`);
    if (plan.blocked.length) lines.push(...this.limits({ ...undo, left: [], servers: [] }, plan.blocked));
    if (applied.restored.length) lines.push(await this.tellConversation(receipt, applied.restored, "redo"));
    this.write(`${lines.join("\n")}\n`);
    if (applied.restored.length) this.offer(buildNextRow({ undo: { label: "Undo", command: `/undo ${n}` } }));
  }

  /** Files Casper can't tell the task changed (a deleted file, a command or service the task left running): asked, Leave
   * them first so Enter touches nothing; a run that can't ask leaves them. Takes them out of `plan` unless you say undo
   * them too. The files left, or undefined when nothing is to be done (nothing else to put back). */
  private async confirmUnsure(n: number, plan: UndoPlan, unsure: readonly string[], signal?: AbortSignal): Promise<string[] | undefined> {
    const asked = plan.ready.filter((entry) => unsure.includes(entry.path)).map((entry) => entry.path);
    if (!asked.length) return [];
    let leave = !this.host.interactive;
    if (!leave) {
      const choices = undoUnsureChoices(asked.length);
      const answer = await this.host.terminal.pick(`Casper can't tell whether task ${n} changed ${names(asked)}: another program may have.`, choices, signal);
      if (answer === undefined) { this.write("Nothing was changed.\n"); return undefined; }
      leave = answer !== choices[1]!.label;
    }
    if (!leave) return [];
    plan.ready = plan.ready.filter((entry) => !asked.includes(entry.path));
    return asked;
  }

  /** Some files changed after the task: ask (Cancel first, so Enter changes nothing), or refuse where no one can be asked. */
  private async confirmPartial(verb: "Undo" | "Redo", n: number, changed: readonly string[], ready: number, signal?: AbortSignal): Promise<boolean> {
    if (!changed.length) return true;
    const which = `${names(changed)} changed after ${verb === "Undo" ? `task ${n}` : `task ${n} was undone`}`;
    if (!ready || !this.host.interactive) {
      this.refuse(`${which}, so Casper left everything as it is.`);
      return false;
    }
    const choices = undoChangedChoices(verb, ready);
    const answer = await this.host.terminal.pick(`${which}.`, choices, signal);
    if (answer !== choices[1]!.label) { this.write("Nothing was changed.\n"); return false; }
    return true;
  }

  /** What undo can't reach, said every time it applies. */
  private limits(undo: ReceiptUndo, blocked: ReadonlyArray<{ path: string; why: string }>): string[] {
    const lines: string[] = [];
    const left = [...undo.left.map((entry) => ({ path: entry.path, why: leftOutWhy(entry) })), ...blocked];
    if (left.length) lines.push(`– Undo can't put back: ${left.slice(0, MAX_NAMES).map((entry) => `${terminalText(entry.path)} (${entry.why})`).join(", ")}${left.length > MAX_NAMES ? ` … +${left.length - MAX_NAMES} more` : ""}`);
    for (const server of undo.servers ?? []) lines.push(`– Undo only puts back files in this folder; it can't undo changes made through ${terminalText(server)}.`);
    return lines;
  }

  /** Rewinds the conversation when nothing was said since the task in this same conversation; otherwise tells the
   * model in one short note. A one-shot `casper /undo` has no conversation to change. */
  private async tellConversation(receipt: StoredReceipt, restored: readonly string[], kind: "undo" | "redo"): Promise<string> {
    const session = this.host.liveSession;
    if (!session) return "– The conversation is not changed: only files were put back.";
    const same = receipt.sessionId !== null && sessionIdOf(session) === receipt.sessionId;
    if (kind === "undo" && same && receipt.conversation && session.rewindTo && markOf(session) === receipt.conversation.after) {
      try { if (await session.rewindTo(receipt.conversation.before, receipt.conversation.after)) return `– Conversation rewound to before task ${receipt.n}.`; } catch { /* keep it, with a note */ }
    }
    if (!session.appendContext) return "– The conversation is not changed: only files were put back.";
    const note = kind === "undo"
      ? `The user undid task ${receipt.n}. These files are back as they were before it: ${restored.join(", ")}.`
      : `The user redid task ${receipt.n}. These files are back as the task left them: ${restored.join(", ")}.`;
    try { await session.appendContext(note); } catch { return "– The conversation is not changed: only files were put back."; }
    return kind === "undo" ? `– Conversation kept — ${same ? "you've talked since, so " : ""}Casper told the model the files were put back.`
      : "– Casper told the model the files are back.";
  }

  private async undoSetting(receipt: StoredReceipt, kind: "undo" | "redo"): Promise<void> {
    const setting = receipt.setting!;
    const n = receipt.n;
    if (kind === "undo" && setting.undone) {
      this.refuse(`Task ${n} is already undone.${this.host.interactive ? " 2 Redo" : ` casper /redo ${n} saves it again.`}`);
      this.offer(buildNextRow({ undo: { label: "Redo", command: `/redo ${n}` } }));
      return;
    }
    if (kind === "redo" && !setting.undone) { this.refuse(`Task ${n} is not undone, so there is nothing to redo.`); return; }
    const incoming = await this.incomingSince(receipt);
    if (!incoming) return;
    if (incoming.includes(setting.file)) {
      this.refuse(`Task ${n} can't be put back: git brought ${terminalText(setting.file)} in during a later task, so Casper left it alone.`);
      return;
    }
    const store = this.store(receipt.root)!;
    const text = async (id: string | null) => id === null ? undefined : (await store.readBlob(id)).toString("utf8");
    const [before, after] = [await text(setting.before), await text(setting.after)];
    const [expected, wanted] = kind === "undo" ? [after, before] : [before, after];
    const now = await readProjectText(receipt.root, setting.file, 256 * 1024).catch(() => null);
    if (now !== expected) { this.refuse(`${setting.file} changed after task ${n}, so Casper left it as it is.`); return; }
    if (wanted === undefined) await removeProjectFile(receipt.root, setting.file);
    else await writeProjectFile(receipt.root, setting.file, wanted, { mode: "replace", fileMode: 0o644 });
    this.lastRestored = [setting.file];
    await this.receipts()!.update(n, (saved) => ({ ...saved, setting: kind === "undo" ? { ...saved.setting!, undone: { at: new Date().toISOString() } } : { ...saved.setting!, undone: undefined } }));
    await this.host.reloadProject().catch(() => {});
    this.write(kind === "undo" ? `✓ Undone — ${setting.file} is back as it was before task ${n} (${terminalText(setting.line)} is no longer saved).\n`
      : `✓ Redone — ${terminalText(setting.line)} is saved in ${setting.file} again.\n`);
    this.offer(buildNextRow({ undo: kind === "undo" ? { label: "Redo", command: `/redo ${n}` } : { label: "Undo", command: `/undo ${n}` } }));
  }

  // ---- /diff and /receipt ------------------------------------------------------------------------------------

  /** /diff [n|list]: this task's changes, also outside git. False when no task has run in this folder (the caller
   * shows the git view instead). */
  /** `duringWork`: a task is running, so /diff list prints its list instead of a picker; a box the task opens
   * (an approval, a question) must never find a picker in its way. */
  async diff(argument: string, signal?: AbortSignal, duringWork = false): Promise<boolean> {
    const receipts = this.receipts();
    const root = this.host.activeRoot();
    if (argument === "list") {
      const recent = (await receipts?.list(30) ?? []).flatMap(({ receipt }) => typeof receipt !== "string" && receipt.root === root && hasCopies(receipt) ? [receipt] : []).slice(0, 9);
      if (!recent.length) { this.write("No task has changed files in this folder yet.\n"); return true; }
      const label = (receipt: StoredReceipt) => `Task ${receipt.n} · ${time(receipt.createdAt)} · ${terminalText(receipt.request).replace(/\s+/g, " ").slice(0, 60)}`;
      if (!this.host.interactive || duringWork) {
        this.write(`${recent.map((receipt) => `  ${label(receipt)}`).join("\n")}\n/diff <task number> shows one.\n`);
        return true;
      }
      const picked = await this.host.terminal.pick("Show the changes of which task?", recent.map((receipt) => ({ label: label(receipt),
        description: files((receipt.undo as ReceiptUndo).paths.length) })), signal);
      const chosen = recent.find((receipt) => label(receipt) === picked);
      if (!chosen) { this.write("No task picked.\n"); return true; }
      await this.showDiff(chosen);
      return true;
    }
    if (argument && !/^\d{1,9}$/.test(argument)) throw new Error(USAGE.diff);
    if (argument) {
      const found = await receipts?.get(Number(argument)) ?? "missing";
      if (found === "missing") { this.refuse(`No receipt ${Number(argument)}. /receipt list shows recent ones.`); return true; }
      if (found === "unreadable") { this.refuse(`Receipt ${Number(argument)} can't be read.`); return true; }
      await this.showDiff(found);
      return true;
    }
    const latest = await receipts?.latest((receipt) => receipt.root === root && Boolean(receipt.undo && "before" in receipt.undo));
    if (!latest) return false;
    await this.showDiff(latest);
    return true;
  }

  private async showDiff(receipt: StoredReceipt): Promise<void> {
    if (receipt.setting) { this.write(`Task ${receipt.n} saved ${terminalText(receipt.setting.line)} in ${receipt.setting.file}.\n`); return; }
    if (!receipt.undo || "unavailable" in receipt.undo) {
      this.write(`Casper kept no copy of task ${receipt.n}${receipt.undo ? ` (${terminalText(receipt.undo.unavailable)})` : ""}, so it can't show its changes.\n`);
      return;
    }
    const patch = await this.store(receipt.root)!.diff(receipt.undo.before, receipt.undo.after, receipt.git ? { paths: receipt.undo.paths } : {});
    if (!patch.trim()) { this.write(`No changes in task ${receipt.n}.\n`); return; }
    this.host.terminal.writePanel(`Changes in task ${receipt.n}`, patch, { diff: true });
    const notes = [receipt.undo.undone ? `– Task ${receipt.n} is undone; this is what it changed.` : "", ...this.limits(receipt.undo, [])].filter(Boolean);
    if (notes.length) this.write(`${notes.join("\n")}\n`);
  }

  /** /receipt [n|list]. False when there is no saved receipt to show (the caller says so). */
  async receipt(argument: string): Promise<boolean> {
    const receipts = this.receipts();
    if (argument === "list") {
      const recent = await receipts?.list(10) ?? [];
      if (!recent.length) { this.write("No saved receipts yet.\n"); return true; }
      this.write(`${recent.map(({ n, receipt }) => typeof receipt === "string" ? `  ${n}  Receipt ${n} can't be read.`
        : `  ${n}  ${time(receipt.createdAt)}  ${summary(receipt)}  · ${terminalText(receipt.request).replace(/\s+/g, " ").slice(0, 60)}`).join("\n")}\n/receipt <number> shows one.\n`);
      return true;
    }
    if (argument && !/^\d{1,9}$/.test(argument)) throw new Error(USAGE.receipt);
    const found = argument ? await receipts?.get(Number(argument)) ?? "missing" : await receipts?.latest() ?? "missing";
    if (found === "missing") {
      if (!argument) return false;
      this.refuse(`No receipt ${Number(argument)}. /receipt list shows recent ones.`);
      return true;
    }
    if (found === "unreadable") { this.refuse(`Receipt ${Number(argument)} can't be read.`); return true; }
    const task = found.task && { ...found.task, receipt: found.n };
    const card = task && this.host.terminal.rich && !this.host.verbose;
    // The card's line 1 is the verdict, so it needs no summary line above it.
    this.write(`Task ${found.n} · ${time(found.createdAt)} · ${terminalText(found.request).replace(/\s+/g, " ")}\n${card ? "" : `${summary(found)}\n`}`);
    if (task) showReceiptDetail(this.host, task);
    if (found.undo && "undone" in found.undo && found.undo.undone) this.write(`– Undone at ${time(found.undo.undone.at)}; /redo ${found.n} puts the files back.\n`);
    return true;
  }
}

/** A task's receipt in detail (/receipt): on a session's rich terminal the receipt card with every row expanded;
 * with --verbose, and on the plain terminal, the full form. */
export function showReceiptDetail(host: { readonly terminal: InteractiveTerminal; readonly output: OutputWriter; readonly verbose?: boolean }, task: TaskResult): void {
  const card = host.terminal.rich && !host.verbose ? receiptDetail(receiptView(task, { full: true }), task, host.terminal.color) : undefined;
  if (card) host.terminal.writeCard(card, formatTaskResult(task));
  // --verbose and the plain terminal: the full form, a failure red as on the receipt.
  else host.terminal.writeReceipt(`${formatTaskResult(task)}\n`);
}

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "--:--" : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Line 1 of a saved receipt: its verdict, or what a setting receipt saved. */
function summary(receipt: StoredReceipt): string {
  if (receipt.setting) return `✓ Saved ${terminalText(receipt.setting.line)} in ${receipt.setting.file}${receipt.setting.undone ? " (undone)" : ""}`;
  const verdict = receipt.task ? receiptVerdict(receipt.task) : undefined;
  return terminalText(verdict ?? "– No receipt text");
}
