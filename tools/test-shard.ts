/**
 * Splits the suite `bun run test` runs into N groups of about equal time, so a slow CI host (Windows) can run
 * them on N machines at once. Times come from tests/timings.json (`bun run test:timings`); a file with no time
 * yet counts as an average one. Same files as `bun run test`: no tests/eval-*, and the real debugger test runs
 * on its own after the suite.
 *
 *   bun tools/test-shard.ts <count> <index>   prints shard <index> (1-based), one file per line
 */
import { readdir, readFile } from "node:fs/promises";

const LEFT_OUT = [/^tests\/eval-/, /^tests\/phase10-debugger-real\.test\.ts$/];

export async function suiteFiles(root = "tests"): Promise<string[]> {
  const names = await readdir(root);
  return names.filter((name) => name.endsWith(".test.ts")).map((name) => `${root}/${name}`)
    .filter((file) => !LEFT_OUT.some((pattern) => pattern.test(file))).sort();
}

/** Slowest first, each file to the shard with the least time so far: every file lands in exactly one shard. */
export function shardFiles(files: readonly string[], timings: Readonly<Record<string, number>>, count: number, index: number): string[] {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 1 || index > count) {
    throw new Error(`shard ${index} of ${count}: the index must be 1..${count}`);
  }
  const known = files.map((file) => timings[file]).filter((time): time is number => typeof time === "number");
  const average = known.length ? known.reduce((sum, time) => sum + time, 0) / known.length : 1;
  const ordered = [...files].sort((a, b) => (timings[b] ?? average) - (timings[a] ?? average) || a.localeCompare(b));
  const totals = Array.from({ length: count }, () => 0);
  const shards: string[][] = Array.from({ length: count }, () => []);
  for (const file of ordered) {
    let least = 0;
    for (let shard = 1; shard < count; shard++) if (totals[shard]! < totals[least]!) least = shard;
    shards[least]!.push(file);
    totals[least]! += timings[file] ?? average;
  }
  return shards[index - 1]!.sort();
}

if (import.meta.main) {
  const [count, index] = process.argv.slice(2).map(Number);
  let timings: Record<string, number> = {};
  try { timings = (JSON.parse(await readFile("tests/timings.json", "utf8")) as { files?: Record<string, number> }).files ?? {}; } catch {}
  for (const file of shardFiles(await suiteFiles(), timings, count ?? 0, index ?? 0)) console.log(file);
}
