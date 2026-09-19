import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LSPManager } from "../src/lsp/manager";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function root() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-real-lsp-")));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function manager(dir: string, name: string, args: string[], languages: Record<string, string>, timeoutMs = 15_000) {
  const value = new LSPManager(dir, { servers: [{ name, source: "test", command: process.execPath, args, languages }], diagnostics: [] }, timeoutMs);
  cleanup.push(() => value.close());
  return value;
}
async function check(command: string[], cwd: string) {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 20_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ stdout: exit === 0 ? "" : stdout, stderr, exit }).toEqual({ stdout: "", stderr: "", exit: 0 });
  } finally { clearTimeout(timer); }
}

test("real TypeScript LSP resolves symbols/references and renames across files without compiler regressions", async () => {
  const dir = await root();
  await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["*.ts"] }));
  await writeFile(path.join(dir, "a.ts"), "export function greet(name: string): string { return name; }\n");
  await writeFile(path.join(dir, "b.ts"), "import { greet } from './a';\nexport const result = greet('world');\n");
  await writeFile(path.join(dir, "unrelated.ts"), "export const unrelated = { greet: 'unchanged' };\n");
  const tsc = [process.execPath, path.join(import.meta.dir, "../node_modules/typescript/bin/tsc"), "--noEmit", "-p", dir];
  await check(tsc, dir);
  const lsp = manager(dir, "ts", [path.join(import.meta.dir, "../node_modules/typescript-language-server/lib/cli.mjs"), "--stdio"], { ".ts": "typescript" }, 5000);
  await lsp.connect("ts");
  expect(await lsp.query("ts", "symbols", { path: "a.ts" })).not.toEqual([]);
  expect(await lsp.query("ts", "definition", { path: "b.ts", position: { line: 1, character: 23 } })).not.toEqual([]);
  expect(await lsp.query("ts", "references", { path: "a.ts", position: { line: 0, character: 18 } })).toHaveLength(3);
  const baseline = await lsp.diagnostics("ts", "a.ts");
  expect(baseline.status).toBe("unversioned"); // TLS does not publish document versions.
  expect(baseline.diagnostics).toEqual([]);
  const result = await lsp.rename("ts", "a.ts", { line: 0, character: 18 }, "welcome", async (preview) => {
    expect(preview.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    return true;
  });
  expect(result.changed).toEqual(["a.ts", "b.ts"]);
  expect(await readFile(path.join(dir, "a.ts"), "utf8")).toContain("function welcome");
  expect(await readFile(path.join(dir, "b.ts"), "utf8")).toContain("welcome('world')");
  expect(await readFile(path.join(dir, "unrelated.ts"), "utf8")).toBe("export const unrelated = { greet: 'unchanged' };\n");
  await check(tsc, dir);
}, 90_000);

test("real Pyright acceptance: repository-wide rename finishes with fresh zero diagnostics", async () => {
  const dir = await root();
  await writeFile(path.join(dir, "pyrightconfig.json"), JSON.stringify({ include: ["*.py"], typeCheckingMode: "basic" }));
  await writeFile(path.join(dir, "a.py"), "def greet(name: str) -> str:\n    return name\n");
  await writeFile(path.join(dir, "b.py"), "from a import greet\nresult = greet('world')\n");
  await writeFile(path.join(dir, "unrelated.py"), "unrelated = {'greet': 'unchanged'}\n");
  const lsp = manager(dir, "py", [path.join(import.meta.dir, "../node_modules/pyright/langserver.index.js"), "--stdio"], { ".py": "python" });
  await lsp.connect("py");
  for (const file of ["a.py", "b.py", "unrelated.py"]) {
    const baseline = await lsp.diagnostics("py", file);
    expect(baseline.status).toBe("fresh");
    expect(baseline.diagnostics).toEqual([]);
  }
  const result = await lsp.rename("py", "a.py", { line: 0, character: 5 }, "welcome", async () => true);
  expect(result.changed).toEqual(["a.py", "b.py"]);
  expect(result.diagnostics).toHaveLength(3);
  for (const report of result.diagnostics) {
    expect(report.status).toBe("fresh");
    expect(report.diagnostics).toEqual([]);
  }
  expect(await readFile(path.join(dir, "b.py"), "utf8")).toBe("from a import welcome\nresult = welcome('world')\n");
  expect(await readFile(path.join(dir, "unrelated.py"), "utf8")).toBe("unrelated = {'greet': 'unchanged'}\n");
  await check([process.execPath, path.join(import.meta.dir, "../node_modules/pyright/index.js"), "--project", dir], dir);
}, 90_000);
