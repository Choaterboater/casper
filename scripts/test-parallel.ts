import { readdir } from "node:fs/promises";
import path from "node:path";

// Start the historically longest files first; workers take the next file when free.
const slowFiles = ["phase9-learn.test.ts", "phase8-pi.integration.test.ts", "phase7-sessions.test.ts", "phase5-lsp-real.test.ts"];
// Real debugger tests share host debugger/Python resources with the machine; keep them out of
// suite-level parallelism so `test:fast` remains a reliable verification signal.
const serialFiles = new Set(["phase10-debugger-real.test.ts"]);

export interface RunTestsOptions {
  /** Print complete output for passing files too. Failures are always printed in full. */
  verbose?: boolean;
  now?: () => number;
}

export async function runTests(files: string[], concurrency = 4, write: (text: string) => void = (text) => { process.stdout.write(text); }, options: RunTestsOptions = {}): Promise<number> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Concurrency must be a positive integer");
  if (!files.length) throw new Error("No test files found");
  const parallel: string[] = [];
  const serial: string[] = [];
  for (const file of files) (serialFiles.has(path.basename(file)) ? serial : parallel).push(file);
  const queue = [...parallel];
  const now = options.now ?? (() => performance.now());
  const suiteStart = now();
  let failed = 0;
  const runFile = async (file: string) => {
    const started = now();
    try {
      const child = Bun.spawn([process.execPath, "test", path.resolve(file)], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      // Keep failing diagnostics together rather than interleaving workers. Passing files stay
      // one-line by default so the useful red output is not buried in thousands of green lines.
      if (code !== 0 || options.verbose) write(`\n=== ${file} ===\n${stdout}${stderr}`);
      else write(`✓ ${file} (${formatDuration(now() - started)})\n`);
      if (code !== 0) failed++;
    } catch (error) {
      failed++;
      write(`Failed to run ${file}: ${String(error)}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) await runFile(file);
  }));
  for (const file of serial) await runFile(file);
  write(`\nTest files: ${files.length - failed} passed, ${failed} failed, ${files.length} total (${formatDuration(now() - suiteStart)})\n`);
  return failed ? 1 : 0;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?ms";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..");
  const files = (await readdir(path.join(root, "tests")))
    .filter((file) => file.endsWith(".test.ts"))
    .sort((a, b) => {
      const rank = (file: string) => { const index = slowFiles.indexOf(file); return index < 0 ? slowFiles.length : index; };
      return rank(a) - rank(b) || a.localeCompare(b);
    })
    .map((file) => path.join(root, "tests", file));
  process.exitCode = await runTests(files, 4, (text) => { process.stdout.write(text); }, { verbose: process.env.CASPER_TEST_VERBOSE === "1" });
}
