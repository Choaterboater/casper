import { spawn } from "node:child_process";
import { osSupportsProcessGroups, ownSpawnedTree, terminateTree, type OwnedProcesses } from "../platform/processes";

/**
 * Runs one program with an argument list Casper built itself. Never through a shell: a repo path or
 * file name is one argument, never shell text. The whole process tree is stopped on timeout or cancel.
 */
export interface ToolRunOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Stdout past this many bytes is dropped and the run is marked `tooLarge`. */
  maxStdoutBytes?: number;
}

export interface ToolRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  /** The last few KB of stderr, for a "could not run" reason. Never shown raw: callers redact it. */
  stderr: string;
  /** "timeout", "cancelled", "no_start" (missing program), "too_large" or undefined when it ran to the end. */
  ended?: "timeout" | "cancelled" | "no_start" | "too_large";
  error?: string;
}

export type ToolRunner = (options: ToolRunOptions) => Promise<ToolRunResult>;

const STDERR_BYTES = 16 * 1024;
const DEFAULT_STDOUT_BYTES = 64 * 1024 * 1024;

export const runTool: ToolRunner = (options) => new Promise((resolve) => {
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_STDOUT_BYTES;
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderr = Buffer.alloc(0);
  let ended: ToolRunResult["ended"];
  let error: string | undefined;
  if (options.signal?.aborted) {
    resolve({ exitCode: null, signal: null, stdout: "", stderr: "", ended: "cancelled" });
    return;
  }
  let child: ReturnType<typeof spawn>;
  let owner: OwnedProcesses | undefined;
  try {
    child = spawn(options.file, [...options.args], {
      cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
      detached: osSupportsProcessGroups, stdio: ["ignore", "pipe", "pipe"],
    });
    owner = ownSpawnedTree(child.pid, () => child.exitCode === null && child.signalCode === null);
  } catch (caught) {
    resolve({ exitCode: null, signal: null, stdout: "", stderr: "", ended: "no_start", error: caught instanceof Error ? caught.message : String(caught) });
    return;
  }
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (why: NonNullable<ToolRunResult["ended"]>) => {
    if (ended) return;
    ended = why;
    void terminateTree(owner, child.pid, "SIGTERM", () => child.exitCode === null && child.signalCode === null);
    killTimer = setTimeout(() => { void terminateTree(owner, child.pid, "SIGKILL", () => child.exitCode === null && child.signalCode === null); }, 500);
  };
  const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
  const abort = () => stop("cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  child.stdout!.on("data", (chunk: Buffer) => {
    if (stdoutBytes + chunk.length > maxStdout) { stop("too_large"); return; }
    stdoutBytes += chunk.length;
    stdout.push(chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-STDERR_BYTES); });
  child.on("error", (caught: NodeJS.ErrnoException) => {
    error = caught.message;
    if (caught.code === "ENOENT" || caught.code === "EACCES") ended ??= "no_start";
    finish(null, null);
  });
  child.on("close", (exitCode, exitSignal) => finish(exitCode, exitSignal));
  function finish(exitCode: number | null, exitSignal: NodeJS.Signals | null) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    clearTimeout(killTimer);
    // A stopped run may leave children behind in its group: stop them too (as runCommandCheck does).
    if (ended && ended !== "no_start") void terminateTree(owner, child.pid, "SIGKILL", () => false);
    resolve({
      exitCode, signal: exitSignal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: stderr.toString("utf8"),
      ...(ended ? { ended } : {}), ...(error ? { error } : {}),
    });
  }
});
