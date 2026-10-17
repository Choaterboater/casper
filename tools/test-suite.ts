import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { shardFiles, suiteFiles } from "./test-shard";

export function suiteArgs(files: readonly string[], extra: readonly string[] = [], workers = availableParallelism()): string[] {
  if (!files.length) throw new Error("parallel lane has no test files");
  if (!Number.isInteger(workers) || workers < 1) throw new Error("parallel workers must be a positive integer");
  // Preserve three-core macOS runners' original width; never exceed the project's four-worker cap.
  return ["test", `--parallel=${Math.min(4, workers)}`, "--timings=tests/timings.json", ...extra, ...files.map(file => `./${file}`)];
}

/** `--shard=<index>/<count>` runs one part of the suite (tools/test-shard.ts balances them by time) so a slow host
 * can run the parts on several machines at once. Files left out with --path-ignore-patterns are taken out before
 * the split, so each part gets its share of the files that really run. */
export function suitePart(files: readonly string[], extra: readonly string[], timings: Readonly<Record<string, number>>): { files: string[]; extra: string[] } {
  const shard = extra.find(arg => arg.startsWith("--shard="));
  if (!shard) return { files: [...files], extra: [...extra] };
  const match = /^--shard=(\d+)\/(\d+)$/.exec(shard);
  if (!match) throw new Error(`${shard}: use --shard=<index>/<count>, for example --shard=1/3`);
  const ignored = extra.filter(arg => arg.startsWith("--path-ignore-patterns=")).map(arg => new Bun.Glob(arg.slice("--path-ignore-patterns=".length).replace(/^'|'$/g, "")));
  const kept = files.filter(file => !ignored.some(glob => glob.match(file)));
  return { files: shardFiles(kept, timings, Number(match[2]), Number(match[1])), extra: extra.filter(arg => arg !== shard) };
}

/** Explicit file list keeps every real-terminal test out of parallel workers on every OS. */
if (import.meta.main) {
  let timings: Record<string, number> = {};
  try { timings = (JSON.parse(await readFile("tests/timings.json", "utf8")) as { files?: Record<string, number> }).files ?? {}; } catch {}
  const part = suitePart(await suiteFiles("tests", "parallel"), process.argv.slice(2), timings);
  const child = Bun.spawn([process.execPath, ...suiteArgs(part.files, part.extra)], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
}
