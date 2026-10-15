import { readFileSync } from "node:fs";
import path from "node:path";

const read = (file: string): string => { try { return readFileSync(file, "utf8"); } catch { return ""; } };

/** Follow support imports, not mentions in assertions about the lane itself. */
export function terminalReason(file: string, source = read(file), helper: (file: string) => string | undefined = read): string | undefined {
  if (/(?:-terminal|-tmux|windows-screen)\.test\.ts$/.test(file)) return "terminal test filename";
  const seen = new Set<string>();
  function visit(name: string, text: string): string | undefined {
    if (seen.has(name)) return;
    seen.add(name);
    if (/\b(?:ConptySession|runPtyFixture|privateTmux)\s*\(/.test(text) || /\bnew\s+Bun\.Terminal\s*\(/.test(text)) return `starts a terminal in ${name}`;
    for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](\.[^"']+)["']/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]!)).replace(/\.ts$/, "") + ".ts";
      if (!target.startsWith("tests/support/")) continue;
      // Conservatively isolate terminal-support modules; row-only helpers such as ansi-cells stay parallel.
      if (/\/(?:private-tmux|pty|conpty)\.ts$/.test(target)) return `uses ${target}`;
      const reason = visit(target, helper(target) ?? "");
      if (reason) return reason;
    }
  }
  return visit(file, source);
}

/** No --parallel: files and tests run serially; retries and deadlines apply per test, not per file. */
export function terminalArgs(files: readonly string[], timings = "tests/timings-terminal.json", update = false): string[] {
  if (!files.length) throw new Error("terminal lane has no test files");
  return ["test", "--max-concurrency=1", "--retry=1", "--timeout=120000", `--timings=${timings}`,
    ...(update ? ["--update-timings"] : []), ...files.map(file => `./${file}`)];
}

if (import.meta.main) {
  const { suiteFiles } = await import("./test-shard");
  const files = await suiteFiles("tests", "terminal");
  if (process.argv.includes("--list")) console.log(files.join("\n"));
  else {
    const child = Bun.spawn([process.execPath, ...terminalArgs(files, undefined, process.argv.includes("--update-timings"))], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exitCode = await child.exited;
  }
}
