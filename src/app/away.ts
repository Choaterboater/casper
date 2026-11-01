/**
 * Walk-away jobs (decision 51): the terminal closed or SSH dropped while a task ran, on macOS or Linux. Casper doesn't
 * quit. The same task goes on with the same answers you gave this session, servers and slow commands; what it writes
 * goes to the job's log; a question that would show a box is held until you answer it from Casper in any terminal;
 * at the end it writes the usual receipt (undo included), records the result, notifies you and exits.
 */
import { appendFileSync } from "node:fs";
import path from "node:path";
import type { CasperApp } from "../app";
import { stayAfterHangUp } from "../platform/hang-up";
import { hideCommandSecrets } from "../secrets/files";
import { desktopNotify } from "../jobs/notify";
import { ANSWER_TEXT_LIMIT, jobLog, jobsDirectory, liveJobSync, newJobId, pruneJobs, readAnswer, removeAnswer, writeJob, writeJobSync,
  type JobQuestion, type JobRecord } from "../jobs/store";
import { formatShortReceipt } from "../task/result";
import { redactPreview } from "../tui/format";
import type { AwayAsker, AwayQuestion, TerminalOutput } from "../tui/terminal";

/** A job stops on its own after this much work (time spent waiting on you doesn't count). */
export const WORK_LIMIT_MS = 4 * 60 * 60_000;
/** A question waits this long for you; then the job ends with a receipt that says what it waited on. */
export const WAIT_LIMIT_MS = 24 * 60 * 60_000;
/** The job's log stops growing here. */
const LOG_BYTES = 8 * 1024 * 1024;

/** Test seams; the defaults are the real clock, platform and notifications. */
export interface WalkAwaySeams {
  platform?: NodeJS.Platform;
  notify?: (text: string) => Promise<boolean>;
  pollMs?: number;
  workLimitMs?: number;
  waitLimitMs?: number;
}

const oneLine = (text: string, max: number) => redactPreview(hideCommandSecrets(text).text).replace(/\s+/g, " ").trim().slice(0, max);

/** "fix the VLAN script" → the row's and the notification's few words. */
export function jobTitle(request: string): string { return oneLine(request, 80) || "the task"; }

export class AwayJob implements AwayAsker {
  record: JobRecord;
  readonly directory: string;
  readonly log: string;
  /** Why it stopped before its task ended, in plain words. */
  stopReason?: string;
  private logged = 0;
  private worked = 0;
  private workingSince = Date.now();
  private workTimer?: ReturnType<typeof setTimeout>;
  private questions: Promise<unknown> = Promise.resolve();
  private finished = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly app: CasperApp, directory: string, record: JobRecord, private readonly cancel: () => void,
    private readonly seams: WalkAwaySeams = {}) {
    this.directory = directory;
    this.record = record;
    this.log = jobLog(directory, record.id);
  }

  /** Where the job's screen goes now: its log, plain text, owner only. */
  output(): TerminalOutput {
    return { isTTY: false, columns: 100, rows: 40, write: (text: string) => {
      if (this.logged > LOG_BYTES || !text) return;
      this.logged += Buffer.byteLength(text);
      const kept = this.logged > LOG_BYTES ? `${text}\n[Casper stopped writing this log at ${LOG_BYTES / 1024 / 1024} MB; the job still runs.]\n` : text;
      try { appendFileSync(this.log, kept, { mode: 0o600 }); } catch { /* the job goes on without its log */ }
    } };
  }

  start(): void { this.workingSince = Date.now(); this.armWorkLimit(); }

  private armWorkLimit(): void {
    clearTimeout(this.workTimer);
    const left = (this.seams.workLimitMs ?? WORK_LIMIT_MS) - this.worked;
    this.workTimer = setTimeout(() => this.stop(`stopped after ${hours(this.seams.workLimitMs ?? WORK_LIMIT_MS)} of work`), Math.max(0, left));
    this.workTimer.unref?.();
  }

  private stop(why: string): void {
    if (this.finished || this.stopReason) return;
    this.stopReason = why;
    this.app.output.write(`[job] ${why}; stopping here.\n`);
    this.cancel();
  }

  private save(change: (record: JobRecord) => JobRecord): Promise<void> {
    this.writes = this.writes.then(async () => {
      this.record = change(this.record);
      await writeJob(this.directory, this.record).catch(() => {});
    });
    return this.writes;
  }

  private notify(text: string): void {
    if (this.app.projectContext?.notifications === false) return;
    void (this.seams.notify ?? desktopNotify)(text).catch(() => false);
  }

  /** A box held until you answer it in another Casper, one at a time. */
  ask(question: AwayQuestion, signal?: AbortSignal): Promise<string[] | undefined> {
    const turn = this.questions.then(() => this.hold(question, signal));
    this.questions = turn.catch(() => {});
    return turn;
  }

  private async hold(question: AwayQuestion, signal?: AbortSignal): Promise<string[] | undefined> {
    if (this.finished || signal?.aborted || this.app.closing) return undefined;
    const held: JobQuestion = { id: newJobId(), kind: question.kind, question: question.question.slice(0, 8_000),
      choices: question.choices.slice(0, 20).map((choice) => ({ label: choice.label, ...(choice.description ? { description: choice.description } : {}) })),
      askedAt: new Date().toISOString(),
      ...(question.preview ? { preview: question.preview.slice(0, 64_000) } : {}), ...(question.multi ? { multi: true } : {}),
      ...(question.typed ? { typed: true } : {}), ...(question.from ? { from: question.from } : {}), ...(question.hint ? { hint: question.hint } : {}) };
    // Waiting isn't work.
    this.worked += Date.now() - this.workingSince;
    clearTimeout(this.workTimer);
    await removeAnswer(this.directory, this.record.id).catch(() => {});
    await this.save((record) => ({ ...record, status: "waiting", question: held, updatedAt: held.askedAt }));
    this.app.output.write(`[job] Waiting on you: ${oneLine(question.question, 200)}\n`);
    this.notify(`Waiting on you: ${jobTitle(this.record.request)} · ${oneLine(question.question, 80)}`);
    const pollMs = this.seams.pollMs ?? 1_000;
    const deadline = Date.now() + (this.seams.waitLimitMs ?? WAIT_LIMIT_MS);
    let answer: string[] | undefined, note: string | undefined;
    try {
      for (;;) {
        if (signal?.aborted || this.finished || this.app.closing) break;
        const read = await readAnswer(this.directory, this.record.id, held.id);
        if (read) { answer = read.picked ?? undefined; note = read.note; break; }
        if (Date.now() >= deadline) {
          this.stop(`waited ${hours(this.seams.waitLimitMs ?? WAIT_LIMIT_MS)} for you: ${oneLine(question.question, 120)}`);
          break;
        }
        await Bun.sleep(pollMs);
      }
    } finally {
      await removeAnswer(this.directory, this.record.id).catch(() => {});
      if (!this.finished) {
        await this.save(({ question: _answered, ...record }) => ({ ...record, status: "running", updatedAt: new Date().toISOString() }));
        this.workingSince = Date.now();
        if (!this.stopReason) this.armWorkLimit();
      }
    }
    if (answer !== undefined) this.app.output.write("[job] You answered from another terminal.\n");
    // Words typed with a No are direction for the task, as at the keyboard: the AI reads them at its next step.
    if (note && question.kind === "approve" && answer?.[0] === question.choices[0]?.label) {
      const line = note;
      queueMicrotask(() => { if (!this.app.closing) this.app.terminal.submitDuringWork(line); });
    }
    return answer;
  }

  /** The task ended (and anything you queued during it): the result, a notification, then Casper exits. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.workTimer);
    const task = this.app.getLastTaskResult();
    const answer = this.app.lastAnswer.trim().slice(0, ANSWER_TEXT_LIMIT);
    const why = this.stopReason ?? (task?.execution === "cancelled" ? "the task was stopped" : undefined);
    const status = why ? "stopped" as const : "done" as const;
    await this.save(({ question: _none, ...record }) => ({ ...record, status, endedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      ...(why ? { why } : {}), ...(answer ? { answer } : {}),
      ...(task ? { receipt: { text: formatShortReceipt(task).slice(0, 32_000), ...(task.receipt ? { n: task.receipt } : {}) } } : {}) }));
    this.app.output.write(`[job] ${status === "done" ? "Done" : `Stopped: ${why}`}. The result is waiting for you in Casper.\n`);
    await pruneJobs(this.directory).catch(() => {});
    this.notify(status === "done" ? `Done: ${jobTitle(this.record.request)}` : `Stopped: ${jobTitle(this.record.request)} (${why})`);
  }
}

function hours(ms: number): string {
  const value = ms / 3_600_000;
  if (value >= 1) return `${Number.isInteger(value) ? value : value.toFixed(1)} hour${value === 1 ? "" : "s"}`;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Writes to a terminal that is gone fail; they must not end the job. */
function quietStdio(): void {
  for (const stream of [process.stdout, process.stderr, process.stdin]) stream.on("error", () => {});
}

/**
 * The terminal went away (it closed, SSH dropped, its tmux window was killed). While a task runs, on macOS or Linux,
 * Casper stays and the task becomes a job; true when it did. Otherwise (no task, Windows, a script, another job already
 * working in this folder) Casper ends as before. Synchronous: it runs as the hang-up arrives.
 */
export function leaveOnHangUp(app: CasperApp, cancel: () => void, seams: WalkAwaySeams = {}): boolean {
  if (app.away) return true;
  const platform = seams.platform ?? process.platform;
  if (platform === "win32" || !app.interactive || !app.commandActive || !app.modelTaskActive || app.closing || !app.projectContext || app.onEvent) return false;
  const directory = jobsDirectory(app.projectContext.stateDirectory);
  // One job a folder: two AIs never edit the same files on their own.
  if (liveJobSync(directory)) return false;
  const now = new Date().toISOString();
  const root = app.activeWorkspaceRoot();
  const record: JobRecord = { version: 1, id: newJobId(), pid: process.pid, root, folder: path.basename(root),
    request: jobTitle(app.lastTaskRequest ?? ""), leftAt: now, updatedAt: now, status: "running" };
  try { writeJobSync(directory, record); } catch { return false; }
  stayAfterHangUp();
  quietStdio();
  const job = new AwayJob(app, directory, record, cancel, seams);
  app.away = job;
  app.terminal.leave(job.output(), job);
  app.output.write(`[job] The terminal closed; this task keeps going on this computer as job ${record.id}.\n`);
  job.start();
  return true;
}
