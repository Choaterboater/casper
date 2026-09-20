#!/usr/bin/env bun

import { CasperApp } from "./app";
import { CandidateLibrary, formatLearningResult } from "./learn/candidates";
import { taskExitCode } from "./task/result";

import { HELP_TEXT } from "./tui/help";

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  let autoVerify = false;
  const servers: string[] = [];
  const languageServers: string[] = [];
  while (args[0] === "--verify" || args[0] === "--mcp" || args[0] === "--lsp") {
    const flag = args.shift();
    if (flag === "--verify") autoVerify = true;
    else {
      const name = args.shift();
      if (!name || !/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) throw new Error(`${flag} requires a configured server name`);
      (flag === "--lsp" ? languageServers : servers).push(name);
    }
  }
  if (args[0] === "learn") {
    if (autoVerify || servers.length || languageServers.length) throw new Error("learn cannot be combined with --verify, --mcp or --lsp");
    const learning = new CandidateLibrary({ runtimeFactory: async () => {
      const { PiRuntime } = await import("./runtime/pi");
      return new PiRuntime();
    } });
    const removeShutdownHandlers = installShutdownHandlers(learning);
    try {
      let result;
      if (args[1] === "list" && args.length === 3) result = await learning.list(args[2]!);
      else if (args[1] === "inspect" && args.length === 4) result = await learning.inspect(args[2]!, args[3]!);
      else if (args.length === 2 && !["list", "inspect"].includes(args[1]!)) result = await learning.generate(args[1]!);
      else throw new Error("Usage: casper learn <local-repo> | learn list <local-repo> | learn inspect <local-repo> <draft-id>");
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
  const app = new CasperApp({ autoVerify });
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
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
