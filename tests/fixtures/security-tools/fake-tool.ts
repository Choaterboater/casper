// A stand-in for one security tool. It records its argv and environment, then prints a canned report
// captured from the real pinned version (tests/fixtures/security-outputs) and exits like the tool does.
// Usage (from a generated wrapper): bun fake-tool.ts <tool-id> <record-dir> <behaviour> [tool args...]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [id, recordDir, behaviour, ...args] = process.argv.slice(2);
if (!id || !recordDir || !behaviour) process.exit(99);
writeFileSync(path.join(recordDir, `${id}.json`), JSON.stringify({ args, env: process.env, cwd: process.cwd() }));

const outputs = path.join(import.meta.dir, "..", "security-outputs");
const canned: Record<string, { file: string; exit: number }> = {
  gitleaks: { file: "gitleaks.json", exit: 1 },
  ruff: { file: "ruff.json", exit: 0 },
  semgrep: { file: "semgrep.json", exit: 0 },
  zizmor: { file: "zizmor.json", exit: 0 },
  "osv-scanner": { file: "osv-scanner.json", exit: 1 },
  "ansible-lint": { file: "ansible-lint.json", exit: 2 },
  "mcp-scanner": { file: "mcp-scanner.json", exit: 0 },
};

if (behaviour === "crash") {
  process.stderr.write("panic: something broke inside the tool\n");
  process.exit(3);
}
if (behaviour === "hang") {
  setInterval(() => {}, 1000);
} else if (behaviour === "garbage") {
  process.stdout.write("this is not json");
  process.exit(0);
} else if (behaviour === "clean") {
  process.stdout.write(id === "semgrep" ? '{"results":[],"errors":[]}' : id === "osv-scanner" ? '{"results":[]}' : id === "mcp-scanner" ? '{"scan_results":[]}' : "[]");
  process.exit(0);
} else {
  const entry = canned[id];
  if (!entry) process.exit(98);
  // The canned reports were captured in /work/repo: point them at the folder this run is in.
  const text = readFileSync(path.join(outputs, entry.file), "utf8").split("/work/repo").join(process.cwd());
  process.stdout.write(text);
  process.exit(entry.exit);
}
