/**
 * The app's side of undo: a copy before and after each task, the saved receipt, and the /undo, /redo, /diff and
 * /receipt commands. Nothing here calls a model. Undo puts back files in this folder only; it says so each time it
 * can't reach something (secret files, big files, nested repositories, MCP servers, devices).
 */
import { storedTaskResult } from "./json-events";
import { undoChangedChoices } from "./safe-choices";
import type { OutputWriter } from "./commands";
import { tildePath } from "../new/scaffold";
import { readProjectText, removeProjectFile, writeProjectFile } from "../platform/files";
import type { RuntimeSession } from "../runtime/types";
import { ReceiptStore, type ReceiptUndo, type StoredReceipt } from "../task/receipts";
import { formatTaskResult, receiptVerdict, UNDO_NOTHING_CHANGED, type TaskResult } from "../task/result";
import path from "node:path";
import { coveredBy, leftOutWhy, UndoStore, type LeftOut, type UndoSnapshot } from "../task/undo";
import { isSecretFile } from "../secrets/files";
import { redactPreview, terminalText } from "../tui/format";
import { buildNextRow, type NextRow } from "../tui/next-row";
import type { InteractiveTerminal } from "../tui/terminal";

export interface UndoHost {
  readonly output: OutputWriter;
  readonly terminal: InteractiveTerminal;
  readonly interactive: boolean;
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

function hasCopies(receipt: StoredReceipt): receipt is StoredReceipt & { undo: ReceiptUndo } {
  return Boolean(receipt.undo && "before" in receipt.undo && receipt.undo.paths.length);
}

export class TaskUndo {
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
    const snapshot: UndoSnapshot = store ? await store.snapshot(signal) : { unavailable: "Casper has no state folder for this project" };
    return { root, snapshot, mark: markOf(session), sessionId: sessionIdOf(session) };
  }

  /** After the receipt's checks: the second copy, the saved receipt, and what the receipt says about undo. Never
   * throws: a failure makes undo unavailable, with the reason. Returns the change summary (--stat) to print. */
  async finish(start: TaskUndoStart, input: { request: string; task: TaskResult; session: RuntimeSession | undefined; servers: readonly string[] }): Promise<{ stat: string }> {
    const { task } = input;
    const changed = [...new Set([...(task.changedPaths ?? []), ...(task.changedDuringChecks ?? [])])];
    let undo: StoredReceipt["undo"] = null;
    let stat = "";
    const store = this.store(start.root);
    if (!("tree" in start.snapshot) || !store) {
      const reason = "unavailable" in start.snapshot ? start.snapshot.unavailable : "Casper has no state folder for this project";
      task.undo = changed.length || task.possibleMutations ? { available: false, reason } : { available: false, reason: UNDO_NOTHING_CHANGED };
      undo = { unavailable: reason };
    } else {
      const after = await store.snapshot();
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
        const kept: LeftOut[] = [];
        const paths = (await store.changes(before.tree, after.tree).catch(() => [])).flatMap((change) => {
          const already = !change.from && change.to ? notCopiedBefore(change.path) : undefined;
          if (already) { kept.push(already); return []; }
          return [change.path];
        });
        // Files the task's own tools edited that no copy holds (ignored, secret): undo can't put them back either.
        const edited = (task.observedEdits ?? []).flatMap((file) => {
          const relative = path.relative(start.root, path.resolve(start.root, file)).split(path.sep).join("/");
          return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? [relative] : [];
        });
        const all = [...before.left, ...after.left, ...kept];
        for (const file of edited) {
          if (paths.includes(file) || all.some((entry) => entry.path === file)) continue;
          const ignored = coveredBy(before.ignored, file) ?? coveredBy(after.ignored, file);
          if (ignored !== undefined || isSecretFile(file)) all.push({ path: file, why: isSecretFile(file) ? "secret" : "ignored" });
        }
        const wanted = new Set([...changed, ...edited, ...kept.map((entry) => entry.path)]);
        const unique = [...new Map(all.filter((entry) => wanted.has(entry.path)).map((entry) => [entry.path, entry])).values()]
          .sort((a, b) => a.path.localeCompare(b.path));
        const left = unique.map((entry) => ({ path: entry.path, why: leftOutWhy(entry) }));
        if (paths.length) {
          task.undo = { available: true, ...(left.length ? { left } : {}) };
          stat = await store.diff(before.tree, after.tree, { stat: true, ...(kept.length ? { paths } : {}) }).catch(() => "");
        } else task.undo = { available: false, reason: left.length ? `Casper keeps no copy of ${names(left.map((entry) => entry.path))}` : UNDO_NOTHING_CHANGED };
        undo = { before: before.tree, after: after.tree, paths, left: unique,
          ...(input.servers.length ? { servers: [...input.servers] } : {}) };
      }
    }
    const receipts = this.receipts();
    if (!receipts) return { stat };
    try {
      const n = await receipts.add({ createdAt: new Date().toISOString(), kind: "task", request: redactPreview(input.request).slice(0, 200), root: start.root,
        sessionId: start.sessionId ?? sessionIdOf(input.session),
        conversation: start.mark === undefined ? null : { before: start.mark, after: markOf(input.session) ?? null },
        undo, task: storedTaskResult({ ...task, receipt: undefined }) });
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

  /** "Next: 1 Undo · 2 Show diff" for a task that can be undone. */
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
    if (!/^(?:\d{1,9})?$/.test(argument)) { this.write(`${USAGE[kind]}\n`); return undefined; }
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
      this.refuse(`Task ${n} is already undone.${this.host.interactive ? " 1 Redo" : ` casper /redo ${n} puts its files back.`}`);
      this.offer(buildNextRow({ undo: { label: "Redo", command: `/redo ${n}` } }));
      return;
    }
    const store = this.store(receipt.root)!;
    const plan = await store.plan(undo.after, undo.before, undo.paths);
    if (!(await this.confirmPartial("Undo", n, plan.changedSince, plan.ready.length, signal))) return;
    const redo = await store.snapshot(signal);
    if (!("tree" in redo)) { this.refuse(`Nothing was undone: Casper could not save a copy of the files first (${terminalText(redo.unavailable)}).`); return; }
    await store.keep(n, "redo", redo.tree);
    const applied = await store.apply(plan.ready, undo.before, signal);
    await this.receipts()!.update(n, (saved) => ({ ...saved, undo: { ...(saved.undo as ReceiptUndo), undone: { at: new Date().toISOString(), restored: applied.restored, redo: redo.tree } } }));
    const lines = [applied.restored.length
      ? `✓ Undone — ${files(applied.restored.length)} ${applied.restored.length === 1 ? "is" : "are"} back as ${applied.restored.length === 1 ? "it was" : "they were"} before task ${n}: ${names(applied.restored)}`
      : `• Nothing was put back for task ${n}.`];
    for (const skipped of applied.skipped) lines.push(`• Not put back: ${terminalText(skipped.path)} (${terminalText(skipped.why)})`);
    if (plan.changedSince.length) lines.push(`• Left as you changed them: ${names(plan.changedSince)}`);
    lines.push(...this.limits(undo, plan.blocked));
    if (applied.restored.length) lines.push(await this.tellConversation(receipt, applied.restored, "undo"));
    this.write(`${lines.join("\n")}\n`);
    if (applied.restored.length) this.offer(buildNextRow({ undo: { label: "Redo", command: `/redo ${n}` } }));
  }

  async redo(argument: string, signal?: AbortSignal): Promise<void> {
    const receipt = await this.pickReceipt("redo", argument);
    if (!receipt || !this.sameFolder(receipt)) return;
    if (receipt.setting) { await this.undoSetting(receipt, "redo"); return; }
    const n = receipt.n;
    const undo = receipt.undo && "before" in receipt.undo ? receipt.undo : undefined;
    if (!undo?.undone) { this.refuse(`Task ${n} is not undone, so there is nothing to redo.`); return; }
    const store = this.store(receipt.root)!;
    const plan = await store.plan(undo.before, undo.undone.redo, undo.undone.restored);
    if (!(await this.confirmPartial("Redo", n, plan.changedSince, plan.ready.length, signal))) return;
    const applied = await store.apply(plan.ready, undo.undone.redo, signal);
    await this.receipts()!.update(n, (saved) => {
      const { undone: _undone, ...rest } = saved.undo as ReceiptUndo;
      return { ...saved, undo: rest };
    });
    const lines = [applied.restored.length
      ? `✓ Redone — ${files(applied.restored.length)} ${applied.restored.length === 1 ? "is" : "are"} back as task ${n} left ${applied.restored.length === 1 ? "it" : "them"}: ${names(applied.restored)}`
      : `• Nothing was put back for task ${n}.`];
    for (const skipped of applied.skipped) lines.push(`• Not put back: ${terminalText(skipped.path)} (${terminalText(skipped.why)})`);
    if (plan.changedSince.length) lines.push(`• Left as you changed them: ${names(plan.changedSince)}`);
    if (applied.restored.length) lines.push(await this.tellConversation(receipt, applied.restored, "redo"));
    this.write(`${lines.join("\n")}\n`);
    if (applied.restored.length) this.offer(buildNextRow({ undo: { label: "Undo", command: `/undo ${n}` } }));
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
    if (left.length) lines.push(`• Undo can't put back: ${left.slice(0, MAX_NAMES).map((entry) => `${terminalText(entry.path)} (${entry.why})`).join(", ")}${left.length > MAX_NAMES ? ` … +${left.length - MAX_NAMES} more` : ""}`);
    for (const server of undo.servers ?? []) lines.push(`• Undo only puts back files in this folder; it can't undo changes made through ${terminalText(server)}.`);
    return lines;
  }

  /** Rewinds the conversation when nothing was said since the task in this same conversation; otherwise tells the
   * model in one short note. A one-shot `casper /undo` has no conversation to change. */
  private async tellConversation(receipt: StoredReceipt, restored: readonly string[], kind: "undo" | "redo"): Promise<string> {
    const session = this.host.liveSession;
    if (!session) return "• The conversation is not changed: only files were put back.";
    const same = receipt.sessionId !== null && sessionIdOf(session) === receipt.sessionId;
    if (kind === "undo" && same && receipt.conversation && session.rewindTo && markOf(session) === receipt.conversation.after) {
      try { if (await session.rewindTo(receipt.conversation.before, receipt.conversation.after)) return `• Conversation rewound to before task ${receipt.n}.`; } catch { /* keep it, with a note */ }
    }
    if (!session.appendContext) return "• The conversation is not changed: only files were put back.";
    const note = kind === "undo"
      ? `The user undid task ${receipt.n}. These files are back as they were before it: ${restored.join(", ")}.`
      : `The user redid task ${receipt.n}. These files are back as the task left them: ${restored.join(", ")}.`;
    try { await session.appendContext(note); } catch { return "• The conversation is not changed: only files were put back."; }
    return kind === "undo" ? `• Conversation kept — ${same ? "you've talked since, so " : ""}Casper told the model the files were put back.`
      : "• Casper told the model the files are back.";
  }

  private async undoSetting(receipt: StoredReceipt, kind: "undo" | "redo"): Promise<void> {
    const setting = receipt.setting!;
    const n = receipt.n;
    if (kind === "undo" && setting.undone) {
      this.refuse(`Task ${n} is already undone.${this.host.interactive ? " 1 Redo" : ` casper /redo ${n} saves it again.`}`);
      this.offer(buildNextRow({ undo: { label: "Redo", command: `/redo ${n}` } }));
      return;
    }
    if (kind === "redo" && !setting.undone) { this.refuse(`Task ${n} is not undone, so there is nothing to redo.`); return; }
    const store = this.store(receipt.root)!;
    const text = async (id: string | null) => id === null ? undefined : (await store.readBlob(id)).toString("utf8");
    const [before, after] = [await text(setting.before), await text(setting.after)];
    const [expected, wanted] = kind === "undo" ? [after, before] : [before, after];
    const now = await readProjectText(receipt.root, setting.file, 256 * 1024).catch(() => null);
    if (now !== expected) { this.refuse(`${setting.file} changed after task ${n}, so Casper left it as it is.`); return; }
    if (wanted === undefined) await removeProjectFile(receipt.root, setting.file);
    else await writeProjectFile(receipt.root, setting.file, wanted, { mode: "replace", fileMode: 0o644 });
    await this.receipts()!.update(n, (saved) => ({ ...saved, setting: kind === "undo" ? { ...saved.setting!, undone: { at: new Date().toISOString() } } : { ...saved.setting!, undone: undefined } }));
    await this.host.reloadProject().catch(() => {});
    this.write(kind === "undo" ? `✓ Undone — ${setting.file} is back as it was before task ${n} (${terminalText(setting.line)} is no longer saved).\n`
      : `✓ Redone — ${terminalText(setting.line)} is saved in ${setting.file} again.\n`);
    this.offer(buildNextRow({ undo: kind === "undo" ? { label: "Redo", command: `/redo ${n}` } : { label: "Undo", command: `/undo ${n}` } }));
  }

  // ---- /diff and /receipt ------------------------------------------------------------------------------------

  /** /diff [n|list]: this task's changes, also outside git. False when no task has run in this folder (the caller
   * shows the git view instead). */
  async diff(argument: string, signal?: AbortSignal): Promise<boolean> {
    const receipts = this.receipts();
    const root = this.host.activeRoot();
    if (argument === "list") {
      const recent = (await receipts?.list(30) ?? []).flatMap(({ receipt }) => typeof receipt !== "string" && receipt.root === root && hasCopies(receipt) ? [receipt] : []).slice(0, 9);
      if (!recent.length) { this.write("No task has changed files in this folder yet.\n"); return true; }
      const label = (receipt: StoredReceipt) => `Task ${receipt.n} · ${time(receipt.createdAt)} · ${terminalText(receipt.request).replace(/\s+/g, " ").slice(0, 60)}`;
      if (!this.host.interactive) {
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
    if (argument && !/^\d{1,9}$/.test(argument)) { this.write(`${USAGE.diff}\n`); return true; }
    if (argument) {
      const found = await receipts?.get(Number(argument)) ?? "missing";
      if (found === "missing") { this.write(`No receipt ${Number(argument)}. /receipt list shows recent ones.\n`); return true; }
      if (found === "unreadable") { this.write(`Receipt ${Number(argument)} can't be read.\n`); return true; }
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
    const patch = await this.store(receipt.root)!.diff(receipt.undo.before, receipt.undo.after);
    if (!patch.trim()) { this.write(`No changes in task ${receipt.n}.\n`); return; }
    this.host.terminal.writePanel(`Changes in task ${receipt.n}`, patch, { diff: true });
    const notes = [receipt.undo.undone ? `• Task ${receipt.n} is undone; this is what it changed.` : "", ...this.limits(receipt.undo, [])].filter(Boolean);
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
    if (argument && !/^\d{1,9}$/.test(argument)) { this.write(`${USAGE.receipt}\n`); return true; }
    const found = argument ? await receipts?.get(Number(argument)) ?? "missing" : await receipts?.latest() ?? "missing";
    if (found === "missing") {
      if (!argument) return false;
      this.write(`No receipt ${Number(argument)}. /receipt list shows recent ones.\n`);
      return true;
    }
    if (found === "unreadable") { this.write(`Receipt ${Number(argument)} can't be read.\n`); return true; }
    this.write(`Task ${found.n} · ${time(found.createdAt)} · ${terminalText(found.request).replace(/\s+/g, " ")}\n${summary(found)}\n`);
    if (found.task) this.write(`${formatTaskResult({ ...found.task, receipt: found.n })}\n`);
    if (found.undo && "undone" in found.undo && found.undo.undone) this.write(`• Undone at ${time(found.undo.undone.at)}; /redo ${found.n} puts the files back.\n`);
    return true;
  }
}

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "--:--" : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Line 1 of a saved receipt: its verdict, or what a setting receipt saved. */
function summary(receipt: StoredReceipt): string {
  if (receipt.setting) return `✓ Saved ${terminalText(receipt.setting.line)} in ${receipt.setting.file}${receipt.setting.undone ? " (undone)" : ""}`;
  const verdict = receipt.task ? receiptVerdict(receipt.task) : undefined;
  return terminalText(verdict ?? "• No receipt text");
}
