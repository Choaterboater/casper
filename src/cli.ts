#!/usr/bin/env bun

import { CasperApp } from "./app";

function printHelp(): void {
  console.log(`Casper — your coding companion

Usage:
  casper               Start interactive mode
  casper <prompt>      Run one prompt and exit
  casper --verify ...  Authorize post-task checks and bounded repair
  casper --mcp <name>  Authorize and connect a configured MCP (repeatable)
  casper --lsp <name>  Authorize and start a configured language server (repeatable)
  casper --help        Show help

Local commands:
  /project                         Show project context
  /memory                          List human-entered project facts
  /memory remember <fact>          Save an explicit project fact (no model)
  /memory forget <id>              Remove a fact
  /memory outcomes                 Show the latest 20 task outcomes
  /memory accept <id> <yes|no>      Record human acceptance, not test evidence
  /tree                            Show named session/workspace branches
  /branch <name>                   Clone this Pi session (isolated by policy)
  /switch <branch>                 Switch session and workspace (confirmation required)
  /switch main apply               Verify/review/apply candidate, then clean up
  /switch main discard             Review/discard candidate, then clean up
  /delegate <explorer|reviewer> <goal>  Run a bounded read-only subagent (uses a model)
  /skills                          List skill metadata and trust
  /skills inspect <id>             Inspect a skill and its content digest
  /skills trust <id> <sha256>       Approve the exact reviewed skill content
  /skills block <id>               Prevent future skill injection
  /mcp                             Show redacted MCP status (no connection)
  /mcp connect <name>               Authorize this server for this process
  /mcp disconnect <name>            Disconnect and revoke process-local consent
  /lsp                             Show language-server status (no startup)
  /lsp connect <name>               Authorize this language server for this process
  /lsp disconnect <name>            Stop this language server
  /verify [checks ...]              Run project checks without a model
  /verify repair [checks ...]       Run checks and authorize bounded repair
  /exit                            Exit interactive mode

Checks: typecheck lint test build (all by default).
Verification executes repository shell commands; use only in trusted projects.
One-shot verification exits 0 on pass, 1 on failure/blocked, 2 on incomplete (skips).
MCP connection executes a configured program or contacts its URL. Review its source first.
Non-read MCP calls require exact interactive confirmation; denied in one-shot mode.
LSP connection executes a configured program. Review .casper/lsp.json first.
LSP rename requires exact interactive approval; one-shot rename is denied.
Session branching/switching and worktree creation/removal require exact interactive approval.
Subagents get read/grep/find/ls only; no edit/write/bash/MCP/LSP or recursive delegation.
Limits: 2 concurrent, 4 delegations per parent prompt; 180 seconds/12 turns/48 tool calls per child.
Children use global Pi model defaults. Reports are advisory; read-only tools are not an OS sandbox.
Applying a candidate leaves its reviewed diff uncommitted; Casper never commits or pushes it.
Worktree cleanup unregisters Git state and retains candidate files in a printed recovery directory.
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
  const prompt = args.join(" ").trim();
  const app = new CasperApp({ autoVerify });
  const removeShutdownHandlers = installShutdownHandlers(app);

  try {
    for (const server of [...new Set(servers)]) await app.runOnce(`/mcp connect ${server}`);
    for (const server of [...new Set(languageServers)]) await app.runOnce(`/lsp connect ${server}`);
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
