#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The source CLI runs from inside untrusted repositories: like the compiled build, it never
// loads the opened directory's bunfig.toml (preload code) or .env (engine store, profile).

// Only built-in modules before the check: Bun loads every static import before any code runs, so a
// package a pull added but `bun install` has not fetched yet would stop the start with a module error.
import path from "node:path";
import { sourceDependencyProblem } from "./runtime/source-deps";

if (import.meta.main) {
  // ssh started Casper to ask for a password (see src/ssh/askpass.ts): answer it and stop, nothing else loads. A normal
  // start never loads the helper (the names are the ones in src/ssh/askpass-helper.ts).
  if (process.env.CASPER_ASKPASS_ENDPOINT && process.env.CASPER_ASKPASS_TOKEN) {
    const { processIO, runAskpassHelper } = await import("./ssh/askpass-helper");
    process.exit(await runAskpassHelper(process.argv.slice(2), process.env, processIO));
  }
  const problem = sourceDependencyProblem(path.dirname(import.meta.dir));
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const { reportFatal, runCli } = await import("./cli-main");
  runCli().catch(reportFatal);
}
