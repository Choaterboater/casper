import { availableParallelism } from "node:os";
import { suiteFiles } from "./test-shard";

export function suiteArgs(files: readonly string[], extra: readonly string[] = [], workers = availableParallelism()): string[] {
  if (!files.length) throw new Error("parallel lane has no test files");
  if (!Number.isInteger(workers) || workers < 1) throw new Error("parallel workers must be a positive integer");
  // Preserve three-core macOS runners' original width; never exceed the project's four-worker cap.
  return ["test", `--parallel=${Math.min(4, workers)}`, "--timings=tests/timings.json", ...extra, ...files.map(file => `./${file}`)];
}

/** Explicit file list keeps every real-terminal test out of parallel workers on every OS. */
if (import.meta.main) {
  const files = await suiteFiles("tests", "parallel");
  const child = Bun.spawn([process.execPath, ...suiteArgs(files, process.argv.slice(2))], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
}
