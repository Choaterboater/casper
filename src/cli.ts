#!/usr/bin/env bun

import { CasperApp } from "./app";

function printHelp(): void {
  console.log(`Casper — your coding companion

Usage:
  casper               Start interactive mode
  casper <prompt>      Run one prompt and exit
  casper --help        Show help

Local commands:
  /project                         Show project context
  /skills                          List skill metadata and trust
  /skills inspect <id>             Inspect a skill and its content digest
  /skills trust <id> <sha256>       Approve the exact reviewed skill content
  /skills block <id>               Prevent future skill injection
  /exit                            Exit interactive mode
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const prompt = args.join(" ").trim();
  const app = new CasperApp();

  try {
    if (prompt) {
      await app.runOnce(prompt);
      return;
    }

    await app.runInteractive();
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
