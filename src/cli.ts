#!/usr/bin/env bun

import { CasperApp } from "./app";
import { importLegacyEngineState, useCasperAgentStore } from "./runtime/agent-store";
import { CandidateLibrary, formatLearningResult } from "./learn/candidates";
import { taskExitCode } from "./task/result";

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
  const first = args[0];
  if (first === "--help" || first === "-h") return "help";
  if (first === "--version" || first === "-v") return "version";
  if (first === "--licenses") return "licenses";
  return undefined;
}

/** Interactive sessions offer `casper_check` unless `--no-verify`; one-shot prompts opt in
 * with `--verify`. The tool is offered, never run: the model selects checks and nothing
 * executes without a selection. */
export function resolveAutoVerify(options: { verify: boolean; noVerify: boolean; interactive: boolean }): boolean {
  if (options.verify && options.noVerify) throw new Error("--verify and --no-verify cannot be combined");
  if (options.verify) return true;
  if (options.noVerify) return false;
  return options.interactive;
}

export async function runCli(): Promise<void> {
  // Casper owns its engine state under ~/.casper/agent; an existing Pi installation's
  // credentials are imported once (only when the store defaulted — an explicit
  // PI_CODING_AGENT_DIR is managed by its owner). Never surfaces engine internals on failure.
  const casperStore = useCasperAgentStore();
  if (casperStore && await importLegacyEngineState()) {
    process.stdout.write("[auth] Imported existing credentials into ~/.casper/agent.\n");
  }
  const args = process.argv.slice(2);

  const flag = leadingFlag(args);
  if (flag === "licenses") {
    process.stdout.write(licenseNotices);
    return;
  }
  if (flag === "help") {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (flag === "version") {
    // A compiled binary runs from Bun's embedded filesystem (`/$bunfs/…`, `B:\~BUN\…`); its
    // real location is the executable. From source, import.meta.path already resolved any
    // PATH symlink, so the printed path is the checkout that actually runs.
    const embedded = /(^|[\\/])(\$bunfs|~BUN)[\\/]/.test(import.meta.path);
    process.stdout.write(`casper ${CASPER_VERSION} (${embedded ? process.execPath : import.meta.path})\n`);
    return;
  }
  let verify = false;
  let noVerify = false;
  const servers: string[] = [];
  const languageServers: string[] = [];
  while (args[0] === "--verify" || args[0] === "--no-verify" || args[0] === "--mcp" || args[0] === "--lsp") {
    const flag = args.shift();
    if (flag === "--verify") verify = true;
    else if (flag === "--no-verify") noVerify = true;
    else {
      const name = args.shift();
      // A following flag is not a name: `--mcp --verify` must fail, not connect to "--verify".
      if (!name || !/^[a-zA-Z0-9_.][a-zA-Z0-9_.-]{0,63}$/.test(name)) throw new Error(`${flag} requires a configured server name`);
      (flag === "--lsp" ? languageServers : servers).push(name);
    }
  }
  if (args[0] === "learn") {
    if (verify || noVerify || servers.length || languageServers.length) throw new Error("learn cannot be combined with --verify, --no-verify, --mcp or --lsp");
    const learning = new CandidateLibrary({ runtimeFactory: async () => {
      const { PiRuntime } = await import("./runtime/pi");
      return new PiRuntime();
    } });
    const removeShutdownHandlers = installShutdownHandlers(learning);
    try {
      let result;
      if (args[1] === "list" && args.length === 3) result = await learning.list(args[2]!);
      else if (args[1] === "inspect" && args.length === 4) result = await learning.inspect(args[2]!, args[3]!);
      else if (args[1] === "promote" && (args.length === 7 || args.length === 8)) {
        const index = Number(args[5]);
        result = await learning.promote(args[2]!, args[3]!, args[4]!, index, args[6]! as "reference" | "project-skill" | "global-skill" | "ignore", args[7]);
      }
      else if (args.length === 2 && !["list", "inspect", "promote"].includes(args[1]!) && !args[1]!.startsWith("-")) result = await learning.generate(args[1]!);
      else throw new Error("Usage: casper learn <local-repo> | learn list <local-repo> | learn inspect <local-repo> <draft-id> | learn promote <local-repo> <draft-id> <draft-sha256> <candidate-number> <reference|project-skill|global-skill|ignore> [skill-name]");
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
  const prompt = args.join(" ").trim();
  const app = new CasperApp({ autoVerify: resolveAutoVerify({ verify, noVerify, interactive: !prompt }) });
  const removeShutdownHandlers = installShutdownHandlers(app);

  try {
    for (const server of [...new Set(servers)]) await app.runOnce(`/mcp connect ${server}`);
    for (const server of [...new Set(languageServers)]) await app.runOnce(`/lsp connect ${server}`);
    if (prompt) {
      const report = await app.runOnce(prompt);
      process.exitCode = taskExitCode(report, app.getLastTaskResult());
      return;
    }

    await app.runInteractive();
  } finally {
    try { await app.close(); }
    finally { removeShutdownHandlers(); }
  }
}

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
