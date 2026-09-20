import { readdir } from "node:fs/promises";
import path from "node:path";

// Start the historically longest files first; workers take the next file when free.
const slowFiles = ["phase9-learn.test.ts", "phase8-pi.integration.test.ts", "phase7-sessions.test.ts", "phase5-lsp-real.test.ts"];

export async function runTests(files: string[], concurrency = 4, write: (text: string) => void = (text) => { process.stdout.write(text); }): Promise<number> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Concurrency must be a positive integer");
  if (!files.length) throw new Error("No test files found");
  const queue = [...files];
  let failed = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      try {
        const child = Bun.spawn([process.execPath, "test", path.resolve(file)], { stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        // Keep each file's diagnostics together rather than interleaving workers.
        write(`\n=== ${file} ===\n${stdout}${stderr}`);
        if (code !== 0) failed++;
      } catch (error) {
        failed++;
        write(`Failed to run ${file}: ${String(error)}\n`);
      }
    }
  }));
  write(`\nTest files: ${files.length - failed} passed, ${failed} failed, ${files.length} total\n`);
  return failed ? 1 : 0;
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
  process.exitCode = await runTests(files);
}
