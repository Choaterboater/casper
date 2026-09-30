#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The source CLI runs from inside untrusted repositories: like the compiled build, it never
// loads the opened directory's bunfig.toml (preload code) or .env (engine store, profile).

// Only built-in modules before the check: Bun loads every static import before any code runs, so a
// package a pull added but `bun install` has not fetched yet would stop the start with a module error.
import path from "node:path";
import { sourceDependencyProblem } from "./runtime/source-deps";

if (import.meta.main) {
  const problem = sourceDependencyProblem(path.dirname(import.meta.dir));
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const { reportFatal, runCli } = await import("./cli-main");
  runCli().catch(reportFatal);
}
