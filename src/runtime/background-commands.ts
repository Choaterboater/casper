/**
 * Slow commands: a bash command the model ran without its own timeout that is still running at the default limit
 * moves here instead of being stopped. Casper keeps it (its whole process tree, under the sandbox wrap it started
 * with), writes its output on to a log, lists it in /tasks, adds a short note to the conversation when it ends, and
 * stops it when the session ends.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stayingAfterHangUp } from "../platform/hang-up";

/** The limit for a command run without its own timeout. */
export const DEFAULT_COMMAND_LIMIT_SECONDS = 120;
/** A command the AI started with `background: true` moves to the background after this long, so a typo or a missing
 * file still fails in the call's own output. */
export const BACKGROUND_GRACE_SECONDS = 3;
/** What the bash tool's `background` option says to the AI (fixed-tokens counts it). */
export const BACKGROUND_HELP = "true: keep a long job running after this call (/tasks; a note when it ends). Not &, nohup, setsid or tmux";

const requested = new AsyncLocalStorage<boolean>();
/** The AI's bash call asked for the background (`background: true`): carried through the shell's own awaits. */
export function withBackgroundRequest<T>(on: boolean, work: () => T): T { return requested.run(on, work); }
export function backgroundRequested(): boolean { return requested.getStore() === true; }

/** The command sends something to the background itself (`nohup`, `setsid`, `disown`, a lone `&`), which Casper ends
 * with the call, or which escapes where Casper can't see or report it. `2>&1`, `&>`, `&&` and `|&` are not that. */
export function detachesItself(command: string): boolean {
  // Quoted text is an argument ("a=1&b=2" in a URL), not the shell's.
  const bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  return /(?:^|[\s;|&(])(?:nohup|setsid|disown)(?=\s|$|;)/.test(bare) || /(?<![&|<>])&(?![&>|])/.test(bare);
}
/** Added to such a command's output when the background is there to use instead. */
export const DETACH_NOTE = "[Casper ends what a command leaves running when the call returns, or it runs on where Casper can't see or report it. For a job that should keep going after this call, run it with background: true.]";
/** At most this many at once; beyond it a slow command is stopped at the limit, as before. */
export const MAX_BACKGROUND_COMMANDS = 4;
const TAIL_CHARS = 16_384;
/** The log stops growing here, so a command that prints for hours cannot fill the disk. */
const LOG_BYTES = 64 * 1024 * 1024;
const NOTE_LINES = 20;
const NOTE_CHARS = 2_000;

export interface BackgroundCommandInfo {
  id: string;
  command: string;
  startedAt: number;
  /** Where its output goes on (a pi-bash-*.log, so reads of it get command-output secret scrubbing). */
  log?: string;
}

/** How one ended, for the person's line: "cmd-1", "ended with exit code 0", when it started, and whether the person
 * stopped it from /tasks. */
export interface EndedCommand { id: string; how: string; startedAt: number; byPerson: boolean }

export interface AdoptOptions {
  command: string;
  startedAt: number;
  /** The output so far, to start the log and the tail. */
  output: string;
  /** Settles when the command has ended; rejects when it was stopped. */
  done: Promise<{ exitCode: number | null }>;
  /** Stops the whole process tree. */
  stop(): void;
  /** A private folder for the log; the system temp folder when unset. */
  logDir?: string;
}

interface Running extends BackgroundCommandInfo {
  tail: string;
  file?: WriteStream;
  written: number;
  stop(): void;
  /** Set when Casper stopped it: the person (/tasks), the model, or the session ending. */
  stoppedBy?: "person" | "model" | "close";
  ended: Promise<void>;
}

/** The last lines of some output, short enough for a note. */
export function outputTail(text: string, lines = NOTE_LINES, chars = NOTE_CHARS): string {
  const kept = text.replace(/\s+$/, "").split("\n").slice(-lines).join("\n");
  return kept.length > chars ? `…${kept.slice(-chars)}` : kept;
}

export class BackgroundCommands {
  readonly limitSeconds: number;
  readonly max: number;
  private readonly running = new Map<string, Running>();
  private next = 0;
  private closed = false;
  /** Casper ending without close (a crash, process.exit): each tree is still killed, synchronously. */
  private readonly onExit = () => { for (const entry of this.running.values()) { entry.stoppedBy = "close"; entry.stop(); } };
  /** The terminal closed: kill them too (they run in their own process group, so no hang-up reaches them), then
   * hang up again for whoever else listens, or for the default ending (as the side pane does). */
  private readonly onHangup = () => {
    // A Casper that stays (a walk-away job, decision 51) keeps them; they stop when it ends.
    if (stayingAfterHangUp()) return;
    this.onExit();
    process.removeListener("SIGHUP", this.onHangup);
    // Windows raises SIGHUP when the console closes but can't send it: end as a hang-up would.
    try { process.kill(process.pid, "SIGHUP"); } catch { process.exit(129); }
  };

  /** `notify`: a note for the model when one ends (not when the session ends it), with what to tell the person. */
  constructor(private readonly options: { notify(text: string, command: string, ended: EndedCommand): void | Promise<void>; limitSeconds?: number; max?: number }) {
    this.limitSeconds = options.limitSeconds ?? DEFAULT_COMMAND_LIMIT_SECONDS;
    this.max = options.max ?? MAX_BACKGROUND_COMMANDS;
  }

  /** Takes over a running command; undefined when the session is ending or the limit of running ones is reached. */
  adopt(options: AdoptOptions): { id: string; log?: string; write(data: Buffer): void } | undefined {
    if (this.closed || this.running.size >= this.max) return undefined;
    const id = `cmd-${++this.next}`;
    let file: WriteStream | undefined, log: string | undefined;
    try {
      log = path.join(options.logDir ?? os.tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
      file = createWriteStream(log, { mode: 0o600 });
      file.on("error", () => { entry.file = undefined; });
      file.write(options.output);
    } catch { file = undefined; log = undefined; }
    const entry: Running = { id, command: options.command, startedAt: options.startedAt, ...(log ? { log } : {}), tail: options.output.slice(-TAIL_CHARS),
      ...(file ? { file } : {}), written: options.output.length, stop: options.stop, ended: Promise.resolve() };
    entry.ended = options.done.then(({ exitCode }) => this.end(entry, exitCode), () => this.end(entry, undefined));
    this.running.set(id, entry);
    if (this.running.size === 1) { process.once("exit", this.onExit); process.on("SIGHUP", this.onHangup); }
    return { id, ...(log ? { log } : {}), write: (data) => {
      const text = data.toString("utf8");
      entry.tail = (entry.tail + text).slice(-TAIL_CHARS);
      if (!entry.file) return;
      entry.written += data.length;
      if (entry.written <= LOG_BYTES) entry.file.write(data);
      else { entry.file.end(`\n[Casper stopped writing this log at ${LOG_BYTES / 1024 / 1024} MB; the command still runs.]\n`); entry.file = undefined; }
    } };
  }

  private async end(entry: Running, exitCode: number | null | undefined): Promise<void> {
    this.running.delete(entry.id);
    if (this.running.size === 0) { process.removeListener("exit", this.onExit); process.removeListener("SIGHUP", this.onHangup); }
    entry.file?.end();
    if (entry.stoppedBy === "close" || entry.stoppedBy === "model") return;
    const how = entry.stoppedBy === "person" ? "was stopped from /tasks" : exitCode === undefined ? "was stopped"
      : `ended with exit code ${exitCode ?? "none"}`;
    const tail = outputTail(entry.tail);
    const note = `[Background command ${entry.id} ${how}: ${entry.command.slice(0, 200)}]${tail ? `\nLast output:\n${tail}` : ""}${entry.log ? `\nFull output: ${entry.log}` : ""}`;
    try { await this.options.notify(note, entry.command, { id: entry.id, how, startedAt: entry.startedAt, byPerson: entry.stoppedBy === "person" }); }
    catch { /* the conversation is gone */ }
  }

  list(): BackgroundCommandInfo[] {
    return [...this.running.values()].map(({ id, command, startedAt, log }) => ({ id, command, startedAt, ...(log ? { log } : {}) }));
  }

  has(id: string): boolean { return this.running.has(id); }

  /** The last lines of its output so far. */
  logs(id: string, lines = 40): string | undefined {
    const entry = this.running.get(id);
    return entry ? outputTail(entry.tail, lines, TAIL_CHARS) : undefined;
  }

  /** Stops its whole process tree and waits until it ended. False when it had already ended. */
  async stop(id: string, by: "person" | "model" = "person"): Promise<boolean> {
    const entry = this.running.get(id);
    if (!entry) return false;
    entry.stoppedBy ??= by;
    entry.stop();
    await entry.ended;
    return true;
  }

  /** The session is ending: every one is stopped, with no note. */
  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.running.values()];
    for (const entry of entries) { entry.stoppedBy = "close"; entry.stop(); }
    await Promise.all(entries.map((entry) => entry.ended));
  }
}
