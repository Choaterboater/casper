import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import driver from "./terminal-driver.txt" with { type: "text" };
import { runCommandCheck, type CommandCheckOptions } from "./command";
import type { VerificationResult } from "./evidence";
import { parseTerminalCheck, terminalCommand, TERMINAL_KEYS, type TerminalCheckSpec } from "./terminal-spec";

/** A terminal preset uses the ordinary managed-check execution path: same sandbox, stripped provider keys,
 * cancellation, progress, freshness and receipt. The Python helper is embedded in compiled Casper too. */
export async function runTerminalCheck(options: Pick<CommandCheckOptions, "name" | "cwd" | "timeoutMs" | "signal" | "wrap" | "onCleanupFailure" | "env"> & {
  spec: TerminalCheckSpec;
  platform?: NodeJS.Platform;
  python?: string | null;
}): Promise<VerificationResult> {
  const spec = parseTerminalCheck(options.spec, `verify.checks.${options.name}`);
  const command = terminalCommand(spec);
  const nothing = { name: options.name, cwd: options.cwd, command, exitCode: null, signal: null,
    stdout: "", stderr: "", truncated: false, durationMs: 0 };
  if ((options.platform ?? process.platform) === "win32") return { ...nothing, status: "skip", reason: "Terminal checks need a POSIX PTY; Windows support is not built yet", repair: "never" };
  const python = options.python === undefined ? Bun.which("python3") : options.python;
  if (!python) return { ...nothing, status: "skip", reason: "Terminal checks need python3 (standard library only); nothing was installed", repair: "never" };
  if (options.signal?.aborted) return { ...nothing, status: "fail", reason: "Verification cancelled" };
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-terminal-check-"));
  try {
    const script = path.join(root, "driver.py"), scenario = path.join(root, "scenario.json");
    await writeFile(script, driver, { mode: 0o600 });
    await writeFile(scenario, JSON.stringify({ ...spec, deadlineSeconds: Math.max(0.1, options.timeoutMs / 1000 - 0.5),
      steps: spec.steps.map(step => "key" in step ? { send: TERMINAL_KEYS[step.key] } : step) }), { mode: 0o600 });
    const result = await runCommandCheck({ name: options.name, cwd: options.cwd, timeoutMs: options.timeoutMs,
      argv: [python, "-u", script, scenario], signal: options.signal, wrap: options.wrap, env: options.env,
      onCleanupFailure: options.onCleanupFailure });
    const shown = { ...result, command, label: `terminal · ${spec.columns ?? 80}×${spec.rows ?? 24}` };
    if (result.status === "pass" && !result.stdout.startsWith(`Terminal check passed: ${spec.steps.length} steps; exit ${spec.exitCode ?? 0}\n`)) return {
      ...shown, status: "skip", reason: "Terminal runner returned no scenario evidence; the screen was not verified", repair: "never",
    };
    if (result.exitCode === 2 && result.stdout.includes("Terminal check could not read the screen:")) return {
      ...shown, status: "skip", reason: "Unsupported terminal output; the screen was not verified", repair: "never",
    };
    if (result.exitCode === 127 && result.stderr.includes("Terminal program could not start")) return {
      ...shown, reason: "Terminal program could not start", ended: "no_start", repair: "never",
    };
    if (result.stdout.includes("terminal scenario timed out")) return { ...shown, ended: "timeout", reason: "Terminal scenario timed out; failing step and screen are in the output" };
    return shown;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
