import { spawn } from "node:child_process";
import type { CheckName, VerificationResult } from "./evidence";
import { withoutProviderKeys } from "../platform/environment";
import { osSupportsProcessGroups, ownSpawnedTree, type OwnedProcesses, terminateTree } from "../platform/processes";
import { currentSandbox, type SandboxWrapOptions, type ShellSandbox } from "../sandbox/manager";

const OUTPUT_BYTES = 8192;

// Drain all output, retaining a bounded head and tail of each stream.
class OutputCapture {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private size = 0;

  add(chunk: Buffer): void {
    this.size += chunk.length;
    const headBytes = Math.min(chunk.length, OUTPUT_BYTES / 2 - this.head.length);
    if (headBytes > 0) this.head = Buffer.concat([this.head, chunk.subarray(0, headBytes)]);
    const remainder = chunk.subarray(headBytes);
    this.tail = Buffer.concat([this.tail, remainder]).subarray(-OUTPUT_BYTES / 2);
  }

  get truncated(): boolean { return this.size > OUTPUT_BYTES; }
  text(): string {
    // Decode intact output as one buffer: the head/tail boundary can bisect
    // a multibyte character even when no bytes were discarded.
    if (!this.truncated) return Buffer.concat([this.head, this.tail]).toString("utf8");
    return this.head.toString("utf8") + "\n[...output truncated...]\n" + this.tail.toString("utf8");
  }
}

/** How a check starts: a shell command line (`shell: true`, `file` is the whole line) or a program and its
 * argument list, never through a shell. */
export interface SpawnPlan { file: string; args: string[]; shell: boolean }

/** Rewrites how a check starts, e.g. to run it inside the shell sandbox. It sees the plan and the folder and
 * returns the plan to spawn. The check's shown command stays the one the project gave. */
export type CommandWrap = (plan: SpawnPlan, context: { cwd: string; name: CheckName }) => SpawnPlan | Promise<SpawnPlan>;

/** An argument list as one readable line: plain words stay bare, anything else is single-quoted. */
export function argvText(argv: readonly string[]): string {
  return argv.map((arg) => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`).join(" ");
}

export interface CommandCheckOptions {
  name: CheckName;
  /** A shell command line, run the way verify.test always has been. Give this or `argv`. */
  command?: string;
  /** A program and its arguments, run without a shell: a file named `$(touch x)` is only ever a file name. */
  argv?: readonly string[];
  /** A start hook that replaces the session's shell sandbox (tests, or a caller with its own). */
  wrap?: CommandWrap;
  /** How the session's shell sandbox holds this run (network, extra write folders); `false` runs it unheld, for
   * a caller that holds it some other way. Unset: the session sandbox with its defaults. */
  sandbox?: Omit<SandboxWrapOptions, "cwd"> | false;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** The host must block further repair/work when an owned tree cannot be stopped. */
  onCleanupFailure?: () => void;
  /** The command's environment; unset inherits Casper's. AI provider keys are always taken out. */
  env?: NodeJS.ProcessEnv;
}

// cmd.exe's "not found" ends with this, and `cmd /c` exits 1 (9009 inside a batch file).
const CMD_NOT_FOUND = /'[^'\r\n]+' is not recognized as an internal or external command,\r?\noperable program or batch file\.\s*$/;

/** A timeout, a command that could not execute, or the shell's 126 (not executable) / 127 (not found). On
 * Windows the shell is cmd.exe: its "not recognized" as the last thing printed, or 9009, is "not found". */
export function checkEnded(exitCode: number | null, reason?: string, stderr = "", platform: NodeJS.Platform = process.platform): VerificationResult["ended"] {
  if (reason?.startsWith("Timed out")) return "timeout";
  if (reason?.startsWith("Could not execute") || exitCode === 126 || exitCode === 127) return "no_start";
  if (platform === "win32" && (exitCode === 9009 || (exitCode === 1 && CMD_NOT_FOUND.test(stderr)))) return "no_start";
  return undefined;
}

export async function runCommandCheck(options: CommandCheckOptions): Promise<VerificationResult> {
  const { name, cwd, timeoutMs, signal } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error("Verification timeout must be between 1 and 3600000ms");
  }
  if ((options.command === undefined) === (options.argv === undefined)) throw new Error("A check needs either a command or an argument list");
  if (options.argv && (!options.argv.length || !options.argv[0])) throw new Error("A check's argument list needs a program");
  const command = options.command ?? argvText(options.argv!);
  const direct: SpawnPlan = options.argv ? { file: options.argv[0]!, args: options.argv.slice(1), shell: false } : { file: command, args: [], shell: true };
  const started = performance.now();
  const stdout = new OutputCapture();
  const stderr = new OutputCapture();
  const base = () => ({
    name, command, cwd,
    stdout: stdout.text(), stderr: stderr.text(),
    truncated: stdout.truncated || stderr.truncated,
    durationMs: Math.round(performance.now() - started),
  });
  if (signal?.aborted) {
    return { ...base(), status: "fail", exitCode: null, signal: null, reason: "Verification cancelled" };
  }
  let plan: SpawnPlan;
  // Every check runs in the session's shell sandbox when one holds commands (see src/sandbox/manager.ts).
  const sandbox: ShellSandbox | undefined = options.wrap || options.sandbox === false ? undefined : currentSandbox();
  let held: string | undefined;
  try {
    if (options.wrap) plan = await options.wrap({ ...direct, args: [...direct.args] }, { cwd, name });
    else if (sandbox?.on) {
      const wrapped = await sandbox.wrap(command, { cwd, ...(options.sandbox || {}) });
      plan = wrapped.held ? { file: wrapped.command, args: [], shell: true } : direct;
      if (wrapped.held) held = wrapped.id;
    } else plan = direct;
  } catch (error) {
    // The sandbox failed to start just now (it said so): this check runs as the later ones will, not sandboxed,
    // and the receipt says so.
    if (sandbox?.failure) plan = direct;
    else return { ...base(), status: "fail", exitCode: null, signal: null, reason: `Could not execute: ${error instanceof Error ? error.message : String(error)}`, ended: "no_start" };
  }

  return new Promise((resolve) => {
    let reason: string | undefined;
    // A separate process group lets timeout/cancellation terminate shell children
    // as well as the shell; Windows has no groups and terminates verified descendants.
    let child;
    let owner: OwnedProcesses | undefined;
    try {
      child = spawn(plan.file, plan.args, { cwd, shell: plan.shell, windowsHide: true, detached: osSupportsProcessGroups, stdio: ["ignore", "pipe", "pipe"], env: withoutProviderKeys(options.env ?? process.env) });
      owner = ownSpawnedTree(child.pid, () => child!.exitCode === null && child!.signalCode === null);
    } catch (error) {
      resolve({ ...base(), status: "fail", exitCode: null, signal: null, reason: `Could not execute: ${error instanceof Error ? error.message : String(error)}`, ended: "no_start" });
      return;
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const kill = async (terminationSignal: NodeJS.Signals) => {
      const outcome = await terminateTree(owner, child.pid, terminationSignal);
      if (outcome === "unknown" && !settled) {
        reason = "Owned process cleanup is unconfirmed; further checks and repair must be blocked";
        options.onCleanupFailure?.();
        // An unverified root may still own open pipes. Do not wait forever for
        // close after cleanup has already reported that it cannot terminate it.
        finish(null, null);
      }
    };
    const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      child.stdout.destroy(); child.stderr.destroy();
      child.unref(); // Unknown cleanup must not turn a reported failure into an exit hang.
      const ended = checkEnded(exitCode, reason, plan.shell ? stderr.text() : "");
      const result: VerificationResult = { ...base(), status: !reason && exitCode === 0 ? "pass" : "fail", exitCode, signal: exitSignal, reason, ...(ended ? { ended } : {}) };
      if (!held || result.status === "pass" || reason) { sandbox?.finished(held); resolve(result); return; }
      // A failure the sandbox caused says so, in the receipt and to the AI: "blocked by the sandbox (wanted to write /etc/hosts)".
      void blockedBySandbox(sandbox!, held, `${result.stderr}\n${result.stdout}`).then((blocked) => {
        sandbox!.finished(held);
        resolve(blocked ? { ...result, reason: blocked, ended: "blocked" } : result);
      });
    };
    let stopped = false;
    const stop = (message: string) => {
      if (reason) return;
      reason = message;
      stopped = true;
      void kill("SIGTERM");
      killTimer = setTimeout(() => { void kill("SIGKILL"); }, 100);
    };
    const abort = () => stop("Verification cancelled");
    const timer = setTimeout(() => stop(`Timed out after ${timeoutMs}ms`), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.on("error", (error) => { reason = `Could not execute: ${error.message}`; });
    child.on("close", async (exitCode, exitSignal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      // On Windows also drain cleanup after a normal root exit: its observed
      // descendants may still be alive. Never discard an unknown outcome.
      if (reason || owner) await kill("SIGKILL");
      // Windows has no signals: a tree Casper stopped ends with exit code 1, which is not the command's own.
      finish(stopped && process.platform === "win32" ? null : exitCode, exitSignal);
    });
    if (signal?.aborted) abort();
  });
}

/** The sandbox's refusal for run `id`, waiting briefly for its monitor, which can report just after the command ends. */
export async function blockedBySandbox(sandbox: Pick<ShellSandbox, "blockedReason">, id: string, output: string, waitMs = 200): Promise<string | undefined> {
  const deadline = performance.now() + waitMs;
  for (;;) {
    const reason = sandbox.blockedReason(id, output);
    if (reason || performance.now() >= deadline) return reason;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
