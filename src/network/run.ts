import { spawn } from "node:child_process";
import { osSupportsProcessGroups, ownSpawnedTree, terminateTree } from "../platform/processes";

const OUTPUT_BYTES = 8192;

/** Keeps a bounded head and tail of one output stream. */
class Capture {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private size = 0;
  constructor(private readonly limit: number) {}
  add(chunk: Buffer): void {
    this.size += chunk.length;
    const headBytes = Math.min(chunk.length, this.limit / 2 - this.head.length);
    if (headBytes > 0) this.head = Buffer.concat([this.head, chunk.subarray(0, headBytes)]);
    this.tail = Buffer.concat([this.tail, chunk.subarray(Math.max(headBytes, 0))]).subarray(-this.limit / 2);
  }
  get truncated(): boolean { return this.size > this.limit; }
  text(): string {
    if (!this.truncated) return Buffer.concat([this.head, this.tail]).toString("utf8");
    return this.head.toString("utf8") + "\n[...output truncated...]\n" + this.tail.toString("utf8");
  }
}

export interface ArgvRunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Bytes kept per stream (head and tail). */
  outputBytes?: number;
}

export interface ArgvRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  /** Set when the program did not finish on its own: it timed out, was cancelled or could not start. */
  reason?: string;
  ended?: "timeout" | "no_start";
}

/**
 * Run one program with an argument list: never a shell, so a file named
 * `$(touch x).yml` is only ever a file name. The whole process tree is stopped
 * on timeout or cancel.
 */
export function runArgv(file: string, args: readonly string[], options: ArgvRunOptions): Promise<ArgvRunResult> {
  const started = performance.now();
  const limit = options.outputBytes ?? OUTPUT_BYTES;
  const stdout = new Capture(limit);
  const stderr = new Capture(limit);
  const done = (exitCode: number | null, signal: string | null, reason?: string, ended?: ArgvRunResult["ended"]): ArgvRunResult => ({
    exitCode, signal, stdout: stdout.text(), stderr: stderr.text(), truncated: stdout.truncated || stderr.truncated,
    durationMs: Math.round(performance.now() - started), ...(reason ? { reason } : {}), ...(ended ? { ended } : {}),
  });
  if (options.signal?.aborted) return Promise.resolve(done(null, null, "Cancelled"));
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], {
        cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
        detached: osSupportsProcessGroups, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve(done(null, null, `Could not start ${file}: ${error instanceof Error ? error.message : String(error)}`, "no_start"));
      return;
    }
    const alive = () => child.exitCode === null && child.signalCode === null;
    const owner = ownSpawnedTree(child.pid, alive);
    let reason: string | undefined;
    let ended: ArgvRunResult["ended"];
    let settled = false;
    const stop = (why: string, kind?: ArgvRunResult["ended"]) => {
      if (reason) return;
      reason = why;
      ended = kind;
      void terminateTree(owner, child.pid, "SIGTERM", alive);
      setTimeout(() => { if (alive()) void terminateTree(owner, child.pid, "SIGKILL", alive); }, 200).unref();
    };
    const timer = setTimeout(() => stop(`Timed out after ${options.timeoutMs}ms`, "timeout"), options.timeoutMs);
    const onAbort = () => stop("Cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (result: ArgvRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.stdout?.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.once("error", (error) => finish(done(null, null, `Could not start ${file}: ${error.message}`, "no_start")));
    child.once("close", (code, signal) => finish(done(code, signal, reason, ended)));
  });
}
