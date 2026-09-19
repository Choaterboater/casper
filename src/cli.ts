#!/usr/bin/env bun

import { CasperApp } from "./app";

function printHelp(): void {
  console.log(`Casper — your coding companion

Usage:
  casper               Start interactive mode
  casper <prompt>      Run one prompt and exit
  casper --verify ...  Authorize post-task checks and bounded repair
  casper --help        Show help

Local commands:
  /project                         Show project context
  /skills                          List skill metadata and trust
  /skills inspect <id>             Inspect a skill and its content digest
  /skills trust <id> <sha256>       Approve the exact reviewed skill content
  /skills block <id>               Prevent future skill injection
  /verify [checks ...]              Run project checks without a model
  /verify repair [checks ...]       Run checks and authorize bounded repair
  /exit                            Exit interactive mode

Checks: typecheck lint test build (all by default).
Verification executes repository shell commands; use only in trusted projects.
One-shot verification exits 0 on pass, 1 on failure/blocked, 2 on incomplete (skips).
`);
}

export function installShutdownHandlers(app: CasperApp): () => void {
  const shutdown = (exitCode: number) => {
    // Runtime startup/abort has no deadline in the adapter contract. Give
    // verifier cleanup time to finish, but do not let it trap SIGINT/SIGTERM.
    const deadline = setTimeout(() => process.exit(exitCode), 1000);
    const exit = () => { clearTimeout(deadline); process.exit(exitCode); };
    void app.close().then(exit, exit);
  };
  const interrupt = () => shutdown(130);
  const terminate = () => shutdown(143);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  return () => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const autoVerify = args[0] === "--verify";
  const prompt = (autoVerify ? args.slice(1) : args).join(" ").trim();
  const app = new CasperApp({ autoVerify });
  const removeShutdownHandlers = installShutdownHandlers(app);

  try {
    if (prompt) {
      const report = await app.runOnce(prompt);
      if (report) process.exitCode = report.status === "pass" ? 0 : report.status === "incomplete" ? 2 : 1;
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
