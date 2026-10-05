// The CLI itself. src/cli.ts (from source) and src/standalone.ts (compiled) start it.

// First: engine setup that every later import may depend on at runtime.
import "./runtime/engine-setup";
import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { agentStoreWarnings, importLegacyEngineState, useCasperAgentStore } from "./runtime/agent-store";
import { CandidateLibrary, formatLearningResult } from "./learn/candidates";
import { taskExitCode } from "./task/result";
import { looksLikePath, parseCliArgs, parseLearnArgs, parseMcpCheckArgs, parseNewArgs, parseSecurityArgs, parseUpdateArgs, UsageError, type McpCheckCommand,
  type NewCommand, type SecurityCommand, type SubcommandName, type CliOptions, type UpdateCommand, UPDATE_HELP, UPDATE_USAGE } from "./cli-args";
import { runningFromBinary } from "./update/mode";
import type { Install } from "./update/command";
import type { VerificationMode } from "./verify/mode";

import { redactPreview, terminalText } from "./tui/format";
import { formatJsonEvent, receiptEvent, type CasperEvent } from "./app/json-events";
import { CLI_HELP_TEXT, wrapHelp } from "./tui/help";
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

/** `casper mcp check`: the report goes to stdout (only JSON with --json). Progress and failing command
 * output go to stdout too, or to stderr with --json. */
async function runMcpCheckCommand(cmd: McpCheckCommand): Promise<void> {
  const [{ McpCheck }, { checkReportJson, formatCheckReport }] = await Promise.all([import("./mcp/check/index"), import("./mcp/check/format")]);
  const progress = (text: string) => { (cmd.json ? process.stderr : process.stdout).write(text); };
  const check = new McpCheck(cmd, { write: progress });
  const removeShutdownHandlers = installShutdownHandlers(check);
  try {
    const report = await check.run();
    process.stdout.write(cmd.json ? `${JSON.stringify(checkReportJson(report))}\n` : formatCheckReport(report, { header: false }));
    process.exitCode = report.exitCode;
  } finally {
    try { await check.close(); }
    finally { removeShutdownHandlers(); }
  }
}

/** `casper new`: builds the project locally with no model and no saved state. Exit 0 ready, 1 not ready, 64 usage. */
async function runNewSubcommand(cmd: NewCommand): Promise<void> {
  const { runNewCommand } = await import("./new/command");
  const controller = new AbortController();
  const removeShutdownHandlers = installShutdownHandlers({ close: async () => { controller.abort(); } });
  try {
    const { exitCode } = await runNewCommand({ command: cmd, write: (line) => { process.stdout.write(`${terminalText(line)}\n`); }, signal: controller.signal });
    process.exitCode = exitCode;
  } finally { removeShutdownHandlers(); }
}

/** `casper security`: the pinned security tools only, never a model call. Exit 0 no problems, 1 problems, 64 usage.
 * It installs nothing unless --install is given. */
async function runSecuritySubcommand(cmd: SecurityCommand): Promise<void> {
  const [{ runSecurityCheck }, { formatSecurityReport, securityReportJson }, { installTools }] = await Promise.all([
    import("./security/run"), import("./security/format"), import("./security/install")]);
  const folder = path.resolve(cmd.repo);
  if (!(await stat(folder).then((entry) => entry.isDirectory(), () => false))) throw new UsageError(`security: not a folder: ${cmd.repo}`);
  const progress = (text: string) => { (cmd.json ? process.stderr : process.stdout).write(text); };
  const controller = new AbortController();
  const removeShutdownHandlers = installShutdownHandlers({ close: async () => { controller.abort(); } });
  try {
    // --mcp-tools turns on mcp-scanner with a saved tools/list reply; it is off otherwise (a large install).
    const mcpTools = cmd.mcpTools ? path.resolve(cmd.mcpTools) : undefined;
    if (mcpTools && !(await stat(mcpTools).then((entry) => entry.isFile(), () => false))) throw new UsageError(`security: not a file: ${cmd.mcpTools}`);
    const options = { root: folder, homeDir: os.homedir(), strict: cmd.strict, signal: controller.signal, write: progress,
      ...(mcpTools ? { mcpScanner: true, mcpToolsJson: mcpTools } : {}) };
    let report = await runSecurityCheck(options);
    if (cmd.install && report.missing.length && !controller.signal.aborted) {
      const installed = await installTools(report.missing, { homeDir: os.homedir(), write: progress });
      for (const result of installed) progress(`${terminalText(result.message)}\n`);
      report = await runSecurityCheck(options);
    } else if (report.missing.length && !cmd.json) {
      progress(`Not installed: ${report.missing.join(", ")}. casper security --install installs them.\n`);
    }
    process.stdout.write(cmd.json ? `${JSON.stringify(securityReportJson(report))}\n` : formatSecurityReport(report));
    process.exitCode = report.exitCode;
  } finally { removeShutdownHandlers(); }
}

/** The Casper that is running: a release binary, or the source checkout it runs from. From source, import.meta.dir
 * is <checkout>/src with any PATH symlink already resolved. */
function currentInstall(): Install {
  return runningFromBinary(import.meta.path) ? { kind: "binary", executable: process.execPath } : { kind: "checkout", root: path.dirname(import.meta.dir) };
}

/** `casper update`: a release binary installs the newest release with that release's installer; a source checkout
 * pulls with git. No model, no saved state, and outside the shell sandbox: it reaches GitHub and writes the user's
 * own install folder or checkout, which the sandbox would refuse. Exit 0 done or nothing to do, 1 not finished.
 * Ctrl-C stops the update and waits (up to the shutdown deadline) for it to unwind, so a Windows swap is put back
 * and the downloaded installer is removed before the process exits. */
async function runUpdateSubcommand(cmd: UpdateCommand): Promise<void> {
  if (cmd.help) { process.stdout.write(`${UPDATE_USAGE}\n${UPDATE_HELP}\n`); return; }
  const { runUpdate } = await import("./update/command");
  const controller = new AbortController();
  let pending: Promise<unknown> = Promise.resolve();
  const removeShutdownHandlers = installShutdownHandlers({ close: async () => { controller.abort(); await pending.catch(() => undefined); } });
  try {
    const update = runUpdate({ check: cmd.check, install: currentInstall(), currentVersion: CASPER_VERSION, signal: controller.signal,
      write: (line) => { process.stdout.write(`${terminalText(line)}\n`); } });
    pending = update;
    const { exitCode } = await update;
    process.exitCode = exitCode;
  } finally { removeShutdownHandlers(); }
}

/** The shell sandbox for a subcommand with no app: `casper security` and `casper mcp check` hold their tool runs to
 * the repo they check, `casper new` to the new folder (its uv or bun run adds it). Nobody answers host questions here:
 * a host that is not listed is blocked, and said so. */
async function withStandaloneSandbox(options: CliOptions, work: () => Promise<void>): Promise<void> {
  const [{ ShellSandbox, useSandbox }, { SandboxStore }, { loadConfiguration }, { projectStateDirectory }] = await Promise.all([
    import("./sandbox/manager"), import("./sandbox/store"), import("./config/load"), import("./project/model")]);
  const target = path.resolve(options.command === "security" ? parseSecurityArgs(options.rest).repo
    : options.command === "mcp-check" ? parseMcpCheckArgs(options.rest).repo : os.tmpdir());
  const settings = await loadConfiguration({ projectRoot: target }).then((loaded) => loaded.sandbox, () => undefined);
  const sandbox = new ShellSandbox({ root: () => target, ...(settings ? { settings } : {}), ...(options.noSandbox ? { noSandboxFlag: true } : {}),
    store: new SandboxStore(projectStateDirectory(target, os.homedir())), note: (line) => { process.stderr.write(`${line}\n`); },
    seccompPath: async () => (await import("./sandbox/seccomp")).seccompHelper() });
  useSandbox(sandbox);
  try { await work(); }
  finally { useSandbox(undefined); await sandbox.close(); }
}

/** `casper new` that opens the app: a person at a terminal (stdin is a TTY, rich or plain) who did not ask
 * for --list. Undefined for every other command, and for scripts, which get the standalone command. */
export function terminalNewProject(options: CliOptions, stdinTTY: boolean): NewCommand | undefined {
  if (options.command !== "new" || !stdinTTY) return undefined;
  const command = parseNewArgs(options.rest.slice(1));
  return command && !command.list && !command.help ? command : undefined;
}

/** Subcommands that run with no app, no model and no saved state, in one place. `learn` needs Casper's agent store
 * and runs after it is set up. */
const STANDALONE: Partial<Record<SubcommandName, (rest: string[]) => Promise<void>>> = {
  "mcp-check": (rest) => runMcpCheckCommand(parseMcpCheckArgs(rest)),
  new: (rest) => runNewSubcommand(parseNewArgs(rest.slice(1))!),
  security: (rest) => runSecuritySubcommand(parseSecurityArgs(rest)),
};

export async function runCli(): Promise<void> {
  // Options are parsed before anything touches state; they have no side effects.
  const options = parseCliArgs(process.argv.slice(2));
  if (options.info === "licenses") {
    process.stdout.write(licenseNotices);
    return;
  }
  if (options.info === "help") {
    process.stdout.write(wrapHelp(CLI_HELP_TEXT, process.stdout.isTTY ? process.stdout.columns : undefined));
    return;
  }
  if (options.info === "version") {
    // A compiled binary runs from Bun's embedded filesystem (`/$bunfs/…`, `B:\~BUN\…`); its
    // real location is the executable. From source, import.meta.path already resolved any
    // PATH symlink, so the printed path is the checkout that actually runs.
    process.stdout.write(`casper ${CASPER_VERSION} (${runningFromBinary(import.meta.path) ? process.execPath : path.join(import.meta.dir, "cli.ts")})\n`);
    return;
  }
  if (options.command === "update") {
    // Before any state is set up, and outside the shell sandbox (see runUpdateSubcommand).
    await runUpdateSubcommand(parseUpdateArgs(options.rest));
    return;
  }
  const learn = options.command === "learn" ? parseLearnArgs(options.rest) : undefined;
  // `casper new` at a terminal asks what is missing and then opens Casper in the new project; scripts
  // (no terminal) and --list stay standalone, with no app and no model.
  const newProject = terminalNewProject(options, Boolean(process.stdin.isTTY));
  const standalone = options.command === "prompt" || options.command === "interactive" || newProject ? undefined : STANDALONE[options.command];
  if (standalone) {
    // No app, no model and no saved state: only the subcommand's own tools run, in the shell sandbox where it can run.
    await withStandaloneSandbox(options, () => standalone(options.rest));
    return;
  }
  // `casper ~/code/mist-mcp` opens that folder, like --cd with no prompt, instead of sending the path as a paid prompt.
  if (options.folderCandidate && options.command === "prompt") {
    const word = options.rest[0]!;
    const expanded = word === "~" || word.startsWith("~/") || word.startsWith("~\\") ? path.join(os.homedir(), word.slice(1)) : word;
    const isFolder = await stat(expanded).then((entry) => entry.isDirectory(), () => false);
    if (isFolder) {
      if (options.cd) throw new UsageError(`Give the folder once: casper ${word}, or casper --cd <folder> "<prompt>"`);
      if (options.json || options.requireVerification) throw new UsageError(`${options.json ? "--json" : "--require-verification"} needs a prompt: casper --cd ${word} ${options.json ? "--json" : "--require-verification"} "fix the failing test"`);
      options.cd = expanded;
      options.command = "interactive";
      options.rest = [];
    // A slash command (`casper /undo`) is not a path.
    } else if (looksLikePath(word) && !/^\/[A-Za-z][\w-]*$/.test(word)) throw new UsageError(`Not a folder: ${word}`);
  }
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
  const prompt = newProject ? "" : options.promptFromStdin ? await stdinPrompt() : options.rest.join(" ").trim();
  // --json: stdout carries only JSON Lines; the banner, transcript and receipt a person reads go to stderr.
  const emit = options.json ? (event: CasperEvent) => { process.stdout.write(formatJsonEvent(event)); } : undefined;
  // Loaded only now: --help, --version and usage errors never need the app.
  const { CasperApp } = await import("./app");
  const app = new CasperApp({ verificationMode: verificationFlag(options), verbose: options.verbose, ...(options.noSandbox ? { noSandbox: true } : {}),
    model: options.model, effort: options.effort, maxTurns: options.maxTurns, startupWarnings,
    // A session says when a newer Casper is out; --json output is for scripts and never does.
    ...(options.json ? {} : { updateCheck: { install: currentInstall(), currentVersion: CASPER_VERSION } }),
    conversation: options.resume ? { resume: options.resume } : options.continueConversation ? { continue: true } : undefined,
    ...(newProject ? { newProject: { ...(newProject.template ? { template: newProject.template } : {}), ...(newProject.name ? { name: newProject.name } : {}) } } : {}),
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
      emit?.(receiptEvent(report, task, exitCode, app.sandboxReceipt(), app.commandUsage()));
      return;
    }

    await app.runInteractive();
    if (app.newProjectExitCode !== undefined) process.exitCode = app.newProjectExitCode;
  } catch (error) {
    // A run ends with a receipt or, when Casper itself stopped, an error event.
    emit?.({ type: "error", message: redactPreview(error instanceof Error ? error.message : String(error)) });
    throw error;
  } finally {
    try { await app.close(); }
    finally { removeShutdownHandlers(); }
  }
}
