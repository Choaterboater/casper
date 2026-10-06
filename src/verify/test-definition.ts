import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { isTestPath } from "./proof";

/**
 * What the test command means, as far as the project's files define it: the package.json scripts it runs, the
 * test runner's settings (bunfig.toml [test], jest/vitest config, pytest settings, a root conftest.py), the Makefile
 * when it runs make, and a script file it names outside the tests. A change that rewrites these makes the command
 * test something else, so its pass is not the user's own test passing (the proof and the acceptance check skip).
 * Label → digest of that part's text; a part that is absent is left out.
 */
export async function testDefinition(root: string, command: string): Promise<Map<string, string>> {
  const parts = new Map<string, string>();
  const put = (label: string, text: string | undefined) => { if (text !== undefined) parts.set(label, digest(text)); };
  const words = command.trim().split(/\s+/);

  const packageJson = await readJson(root, "package.json");
  if (packageJson) {
    const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
    for (const name of scriptsRun(command, scripts)) put(`package.json scripts.${name}`, JSON.stringify(scripts[name] ?? null));
    if (packageJson.jest !== undefined) put("package.json jest", JSON.stringify(packageJson.jest));
  }
  const bunfig = await readText(root, "bunfig.toml");
  if (bunfig !== undefined) put("bunfig.toml [test]", tomlPart(bunfig, (doc) => doc.test));
  const pyproject = await readText(root, "pyproject.toml");
  if (pyproject !== undefined) put("pyproject.toml [tool.pytest]", tomlPart(pyproject, (doc) => isRecord(doc.tool) ? doc.tool.pytest : undefined));
  const setupCfg = await readText(root, "setup.cfg");
  if (setupCfg !== undefined) put("setup.cfg [tool:pytest]", iniSection(setupCfg, "tool:pytest"));
  const tox = await readText(root, "tox.ini");
  if (tox !== undefined) put("tox.ini [pytest]", iniSection(tox, "pytest"));
  for (const file of RUNNER_FILES) put(file, await readText(root, file));
  if (words[0] === "make" || words[0] === "gmake") for (const file of ["Makefile", "makefile", "GNUmakefile"]) put(file, await readText(root, file));
  // A script the command names (./run-tests.sh, bash scripts/test.sh): a test file itself is the tests, not the command.
  for (const word of words.slice(0, 3)) {
    const relative = word.replace(/^\.\//, "");
    if (!relative || relative.startsWith("-") || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..") || isTestPath(relative)) continue;
    if (!/[\\/.]/.test(word)) continue;
    put(relative, await readText(root, relative));
  }
  return parts;
}

/** The parts whose text differs (added, changed or removed), in plain labels for the receipt. */
export function definitionChanges(before: Map<string, string>, after: Map<string, string>): string[] {
  const labels = new Set([...before.keys(), ...after.keys()]);
  return [...labels].filter((label) => before.get(label) !== after.get(label)).sort();
}

/** The receipt's reason when the test command's own definition changed in the task. */
export function definitionChangedReason(changed: readonly string[]): string {
  return `the test command's definition changed in this task (${changed.join(", ")}), so its pass is not your tests passing`;
}

const RUNNER_FILES = [
  "jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs", "jest.config.json",
  "vitest.config.js", "vitest.config.ts", "vitest.config.mjs", "vitest.config.cjs", "vitest.config.mts", "vitest.config.cts",
  "vitest.workspace.js", "vitest.workspace.ts", "pytest.ini", "conftest.py", ".mocharc.js", ".mocharc.json", ".mocharc.yml", ".mocharc.yaml",
];

/** The package.json scripts a command runs: `npm test`, `npm run x`, `pnpm x`, `yarn x`, `bun run x` (not `bun test`,
 * Bun's own runner), with their pre/post scripts and the scripts those run in turn. */
function scriptsRun(command: string, scripts: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const visit = (text: string, depth: number) => {
    for (const match of text.matchAll(/(?:^|[\s;&|(])(npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?(?:--?[\w-]+\s+)*([\w:.@/-]+)/g)) {
      const [, manager, name] = match;
      if (!name || (manager === "bun" && !/\bbun\s+run/.test(match[0]))) continue;
      const script = name === "t" && manager === "npm" ? "test" : name;
      for (const each of [`pre${script}`, script, `post${script}`]) {
        if (found.has(each)) continue;
        if (each === script || Object.hasOwn(scripts, each)) found.add(each);
        if (depth < 3 && typeof scripts[each] === "string") visit(scripts[each] as string, depth + 1);
      }
    }
  };
  visit(command, 0);
  return [...found];
}

function tomlPart(text: string, pick: (document: Record<string, unknown>) => unknown): string {
  try {
    const document = Bun.TOML.parse(text) as Record<string, unknown>;
    return JSON.stringify(pick(document) ?? null);
  } catch { return `unreadable:${text}`; }
}

/** One [section] of an INI file, as written (comments included). */
function iniSection(text: string, name: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) { inside = header[1]!.trim() === name; continue; }
    if (inside) out.push(line);
  }
  return out.join("\n");
}

async function readText(root: string, relative: string): Promise<string | undefined> {
  const file = path.join(root, relative);
  const stats = await lstat(file).catch(() => undefined);
  if (!stats) return undefined;
  if (stats.isSymbolicLink()) return `link:${relative}`;
  if (!stats.isFile() || stats.size > 1024 * 1024) return `size:${stats.size}`;
  return readFile(file, "utf8").catch(() => undefined);
}

async function readJson(root: string, relative: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(root, relative);
  if (text === undefined) return undefined;
  try { const value = JSON.parse(text); return isRecord(value) ? value : {}; } catch { return { unreadable: text }; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
