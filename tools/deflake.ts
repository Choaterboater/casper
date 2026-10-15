import { appendFile, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isOutside } from "../src/platform/inside";

export function repetitions(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 100) throw new Error("runs must be an integer from 1 to 100");
  return Number(value);
}

export async function testFile(root: string, file: string): Promise<string> {
  if (!/^tests\/.+\.test\.ts$/.test(file) || file.includes("\\")) throw new Error("choose one tests/*.test.ts file");
  const tests = await realpath(path.join(root, "tests"));
  const resolved = await realpath(path.resolve(root, file));
  if (isOutside(path.relative(tests, resolved))) throw new Error("test file must stay inside tests/");
  if (!(await stat(resolved)).isFile()) throw new Error("choose one test file, not a directory");
  return resolved;
}

/** Sequential, independent runs: retain every failure, never turn a later green run into a pass. */
export async function countRuns(runs: number, run: (attempt: number) => Promise<number>): Promise<{ passed: number; failed: number }> {
  repetitions(String(runs));
  let passed = 0, failed = 0;
  for (let attempt = 1; attempt <= runs; attempt++) {
    if (await run(attempt) === 0) passed++;
    else failed++;
  }
  return { passed, failed };
}

export function report(file: string, runs: number, result: { passed: number; failed: number }): string {
  return `## Deflake\n\nFile: ${file}\nOS: ${process.platform}\nRuns: ${runs}\nPass: ${result.passed}\nFail: ${result.failed}\n\nCounts are process exits; inspect logs for skipped tests. A skipped test is not flake evidence.\n`;
}

if (import.meta.main) {
  const runs = repetitions(process.env.DEFLAKE_RUNS ?? "10");
  const file = process.env.DEFLAKE_FILE ?? "";
  const resolved = await testFile(process.cwd(), file);
  const output = path.resolve(process.env.RUNNER_TEMP ?? ".", "deflake-results");
  await mkdir(output, { recursive: true });
  const counts = await countRuns(runs, async (attempt) => {
    const log = path.join(output, `run-${attempt}.log`);
    try {
      const child = Bun.spawn([process.execPath, "test", "--parallel=4", resolved], {
        stdout: Bun.file(log), stderr: Bun.file(`${log}.stderr`), stdin: "ignore",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
      try { return await child.exited; } finally { clearTimeout(timer); }
    } catch (error) { await writeFile(log, String(error)); return 1; }
  });
  const summary = report(file, runs, counts);
  await writeFile(path.join(output, "summary.json"), JSON.stringify({ file, runs, os: process.platform, ...counts }, null, 2));
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  process.exitCode = counts.failed ? 1 : 0;
}
