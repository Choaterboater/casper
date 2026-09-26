#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The source CLI runs from inside untrusted repositories: like the compiled build, it never
// loads the opened directory's bunfig.toml (preload code) or .env (engine store, profile).

// First: engine setup that every later import may depend on at runtime.
import "./runtime/engine-setup";
import path from "node:path";
import { stat } from "node:fs/promises";
import { CasperApp } from "./app";
import { agentStoreWarnings, importLegacyEngineState, useCasperAgentStore } from "./runtime/agent-store";
import { CandidateLibrary, formatLearningResult } from "./learn/candidates";
import { taskExitCode } from "./task/result";
import { parseCliArgs, parseLearnArgs, UsageError } from "./cli-args";
import type { VerificationMode } from "./verify/mode";

import { redactPreview, terminalText } from "./tui/format";
import { formatJsonEvent, receiptEvent, type CasperEvent } from "./app/json-events";
import { HELP_TEXT } from "./tui/help";
import { CASPER_VERSION } from "./version";
import licenseNotices from "../THIRD_PARTY_NOTICES.txt" with { type: "text" };

export function installShutdownHandlers(app: { close(): Promise<void>; interrupt?(): boolean }): () => void {
  const shutdown = (exitCode: number) => {
    // Runtime startup/abort has no deadline in the adapter contract. Give
    // verifier cleanup time to finish, but do not let it trap SIGINT/SIGTERM.
    const deadline = setTimeout(() => process.exit(exitCode), 1000);
    const exit = () => { clearTimeout(deadline); process.exit(exitCode); };
    void app.close().then(exit, exit);
  };
  const interrupt = () => { if (!app.interrupt?.()) shutdown(130); };
  const terminate = () => shutdown(143);
  process.on("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  return () => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  };
}

/** Only a *leading* argument is a flag: `casper explain the -v flag` is a prompt, not
 * a version request. Exported as the argv policy's test seam. */
export function leadingFlag(args: readonly string[]): "help" | "version" | "licenses" | undefined {
  try { return parseCliArgs(args).info; } catch { return undefined; }
}

/** `--verify` runs Casper's checks after this run's edits; `--no-verify` turns managed
 * checks off. Without either, configuration and the surface default decide. */
export function verificationFlag(options: { verify: boolean; noVerify: boolean; requireVerification?: boolean }): VerificationMode | undefined {
  if (options.verify && options.noVerify) throw new UsageError("--verify and --no-verify cannot be combined");
  return options.verify || options.requireVerification ? "auto" : options.noVerify ? "off" : undefined;
}

/** The last-resort error sink. Messages can quote untrusted repository text (a YAML excerpt,
 * a config key), so controls are escaped like every other terminal path. A usage mistake
 * exits 64, so scripts can tell it apart from a failed (1) or incomplete (2) task. */
export function reportFatal(error: unknown): void {
  console.error(terminalText(error instanceof Error ? error.message : String(error)));
  process.exitCode = error instanceof UsageError ? 64 : 1;
}

/** The prompt for `casper … -`: all of stdin, bounded, so it never sits in the process list. */
async function stdinPrompt(): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError("casper - reads the prompt from stdin; pipe it in: casper --json - < prompt.txt");
  const text = await new Response(Bun.stdin.stream()).text();
  if (Buffer.byteLength(text) > 1024 * 1024) throw new UsageError("The prompt on stdin is over 1 MiB");
  if (!text.trim()) throw new UsageError("No prompt on stdin: casper --json - < prompt.txt");
  return text.trim();
}

export async function runCli(): Promise<void> {
  // Options are parsed before anything touches state; they have no side effects.
  const options = parseCliArgs(process.argv.slice(2));
  if (options.info === "licenses") {
    process.stdout.write(licenseNotices);
    return;
  }
  if (options.info === "help") {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (options.info === "version") {
    // A compiled binary runs from Bun's embedded filesystem (`/$bunfs/…`, `B:\~BUN\…`); its
    // real location is the executable. From source, import.meta.path already resolved any
    // PATH symlink, so the printed path is the checkout that actually runs.
    const embedded = /(^|[\\/])(\$bunfs|~BUN)[\\/]/.test(import.meta.path);
    process.stdout.write(`casper ${CASPER_VERSION} (${embedded ? process.execPath : import.meta.path})\n`);
    return;
  }
  const learn = options.command === "learn" ? parseLearnArgs(options.rest) : undefined;
  if (options.cd) {
    const folder = path.resolve(options.cd);
    if (!(await stat(folder).then((entry) => entry.isDirectory(), () => false))) throw new UsageError(`--cd: not a folder: ${options.cd}`);
    process.chdir(folder);
  }
  // Only after the informational flags: they write nothing and must work on a read-only HOME,
  // and installers identify the binary by `--version`'s single stdout line.
  // Casper owns its state; explicit CASPER_AGENT_DIR stores are managed by their owner.
  // Forward Casper's environment settings before loading the engine or creating a terminal.
  // Only the default store gets a best-effort, one-time legacy API-key/catalog import.
  // Read before the store replaces the variable; printed with the app's startup warnings.
  const startupWarnings = agentStoreWarnings();
  if (useCasperAgentStore()) {
    const legacy = await importLegacyEngineState();
    if (legacy.imported) process.stderr.write("[auth] Imported existing credentials into ~/.casper/agent.\n");
    for (const provider of legacy.signIn) {
      process.stderr.write(`[auth] Existing ${provider} sign-in is not shared; run /login ${provider} to sign in Casper. The original sign-in is unchanged.\n`);
    }
  }
  if (learn) {
    // No app, so no app output: learning prints its own diagnostics on stderr.
    for (const warning of startupWarnings) process.stderr.write(`[config] ${warning}\n`);
    const learning = new CandidateLibrary({ runtimeFactory: async () => {
      const { PiRuntime } = await import("./runtime/pi");
      return new PiRuntime();
    } });
    const removeShutdownHandlers = installShutdownHandlers(learning);
    try {
      const result = learn.action === "generate" ? await learning.generate(learn.repo)
        : learn.action === "list" ? await learning.list(learn.repo)
        : learn.action === "inspect" ? await learning.inspect(learn.repo, learn.draftId)
        : await learning.promote(learn.repo, learn.draftId, learn.draftSha256, learn.candidate, learn.target, learn.skillName);
      console.log(formatLearningResult(result));
    } catch (error) {
      console.error(formatLearningResult({ status: "failed", error: error instanceof Error ? error.message : "Learning failed" }));
      process.exitCode = 1;
    } finally {
      try { await learning.close(); }
      finally { removeShutdownHandlers(); }
    }
    return;
  }
  const prompt = options.promptFromStdin ? await stdinPrompt() : options.rest.join(" ").trim();
  // --json: stdout carries only JSON Lines; the banner, transcript and receipt a person reads go to stderr.
  const emit = options.json ? (event: CasperEvent) => { process.stdout.write(formatJsonEvent(event)); } : undefined;
  const app = new CasperApp({ verificationMode: verificationFlag(options), verbose: options.verbose,
    model: options.model, effort: options.effort, maxTurns: options.maxTurns, startupWarnings,
    conversation: options.resume ? { resume: options.resume } : options.continueConversation ? { continue: true } : undefined,
    ...(emit ? { onEvent: emit, output: { write: (text: string) => { process.stderr.write(text); } } } : {}) });
  const removeShutdownHandlers = installShutdownHandlers(app);

  try {
    for (const server of options.servers) await app.runOnce(`/mcp connect ${server}`);
    for (const server of options.languageServers) await app.runOnce(`/lsp connect ${server}`);
    if (prompt) {
      const report = await app.runOnce(prompt);
      const task = app.getLastTaskResult();
      const exitCode = taskExitCode(report, task, { requireVerification: options.requireVerification });
      process.exitCode = exitCode;
      emit?.(receiptEvent(report, task, exitCode));
      return;
    }

    await app.runInteractive();
  } catch (error) {
    // A run ends with a receipt or, when Casper itself stopped, an error event.
    emit?.({ type: "error", message: redactPreview(error instanceof Error ? error.message : String(error)) });
    throw error;
  } finally {
    try { await app.close(); }
    finally { removeShutdownHandlers(); }
  }
}

if (import.meta.main) {
  runCli().catch(reportFatal);
}
