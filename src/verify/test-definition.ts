import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { isTestPath } from "./proof";

/**
 * What the test command means, as far as the project's files define it: the package.json scripts it runs, the
 * test runner's settings (bunfig.toml [test], jest/vitest config, pytest settings, every conftest.py outside the tests),
 * the Makefile when it runs make, and the files it or those scripts name outside the tests (a script file, a --config
 * file). A change that rewrites these makes the command
 * test something else, so its pass is not the user's own test passing (the proof and the acceptance check skip).
 * Label → digest of that part's text; a part that is absent is left out.
 */
export async function testDefinition(root: string, command: string): Promise<Map<string, string>> {
  const parts = new Map<string, string>();
  const put = (label: string, text: string | undefined) => { if (text !== undefined) parts.set(label, digest(text)); };
  // The command and the text of every package.json script it runs: the files they name are part of the definition.
  const texts = [command];
  const packageJson = await readJson(root, "package.json");
  if (packageJson) {
    const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
    for (const name of scriptsRun(command, scripts)) {
      put(`package.json scripts.${name}`, JSON.stringify(scripts[name] ?? null));
      if (typeof scripts[name] === "string") texts.push(scripts[name] as string);
    }
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
  // pytest loads every conftest.py on the way to the tests (src/conftest.py in a src layout); one in a test folder is the tests.
  for (const file of await conftestFiles(root)) put(file, await readText(root, file));
  const commands = texts.flatMap((text) => text.split(/&&|\|\||[;|&\n]/)).map((part) => part.trim().split(/\s+/).filter(Boolean));
  if (commands.some((words) => ["make", "gmake"].includes(program(words)))) {
    // Names as listed, so a case-insensitive disk does not read one Makefile under three names.
    const names = new Set(await readdir(root).catch(() => [] as string[]));
    for (const file of ["Makefile", "makefile", "GNUmakefile"]) if (names.has(file)) put(file, await readText(root, file));
  }
  // Vitest reads vite.config when it has no config of its own.
  if (texts.some((text) => /\bvitest\b/.test(text)) && !RUNNER_FILES.some((file) => file.startsWith("vitest.config.") && parts.has(file))) {
    for (const file of VITE_CONFIGS) put(file, await readText(root, file));
  }
  // A file a command runs or reads its settings from (./run-tests.sh, bash scripts/test.sh, --config config/jest.ci.js):
  // a test file itself is the tests, not the command; a folder is where the tests are; other arguments (grep fixed
  // sum.js) are what the tests look at.
  for (const words of commands) {
    for (const word of namedFiles(words)) {
      const relative = unquote(word).replace(/^\.\//, "");
      if (!relative || relative.startsWith("-") || relative.includes("://") || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..") || isTestPath(relative)) continue;
      const stats = await lstat(path.join(root, relative)).catch(() => undefined);
      if (!stats || stats.isDirectory()) continue;
      put(relative, await readText(root, relative));
    }
  }
  return parts;
}

/** The program a command line runs, past leading NAME=value settings and runners (env, npx, uv run ...). */
function program(words: readonly string[]): string {
  return words[programAt(words)] ?? "";
}

function programAt(words: readonly string[]): number {
  let at = 0;
  for (;;) {
    const word = words[at];
    if (word === undefined) return at;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || ["env", "exec", "time", "nice", "npx", "bunx", "pnpx"].includes(word)) at += 1;
    else if (["uv", "poetry", "pipenv", "hatch", "pdm", "rye"].includes(word) && words[at + 1] === "run") at += 2;
    else if (["npm", "pnpm", "yarn"].includes(word) && words[at + 1] === "exec") at += 2;
    else return at;
  }
}

/** The words of one command that name a file it runs or reads settings from: the program itself when it is a path,
 * the script an interpreter runs, and the value of a settings option. */
function namedFiles(words: readonly string[]): string[] {
  const at = programAt(words);
  const name = words[at];
  if (name === undefined) return [];
  const found: string[] = [];
  if (/[\\/.]/.test(name)) found.push(name);
  const base = path.basename(name).replace(/\.exe$/i, "");
  const interpreter = INTERPRETERS.has(base);
  if (interpreter) {
    let index = at + 1;
    if ((base === "bun" || base === "deno") && words[index] === "run") index += 1;
    while (words[index]?.startsWith("-") && !["-c", "-e", "-m"].includes(words[index]!)) index += 1;
    const script = words[index];
    if (script && !script.startsWith("-")) found.push(script);
  }
  for (const [index, word] of words.entries()) {
    if (index <= at) continue;
    const option = /^(--?[\w-]+)=(.+)$/.exec(word);
    if (option && CONFIG_OPTIONS.has(option[1]!)) found.push(option[2]!);
    // sh -c / python -c take a command, not a settings file.
    else if (CONFIG_OPTIONS.has(word) && !(interpreter && word === "-c") && words[index + 1]) found.push(words[index + 1]!);
  }
  return found;
}

const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "node", "bun", "deno", "tsx", "ts-node", "python", "python3", "ruby", "perl", "php", "pwsh", "powershell"]);

function unquote(word: string): string { return word.replace(/^["']|["']$/g, ""); }

const CONFIG_OPTIONS = new Set(["--config", "-c", "--rootDir", "--config-file", "--configFile", "-p", "--project"]);

const VITE_CONFIGS = ["vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.cjs", "vite.config.mts", "vite.config.cts"];

/** conftest.py files outside the test folders, a few levels down; dependency, cache and hidden folders are skipped. */
async function conftestFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  let budget = 2000;
  const walk = async (relative: string, depth: number) => {
    if (budget-- <= 0) return;
    const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isFile() && entry.name === "conftest.py" && relative && !isTestPath(child)) found.push(child);
      else if (entry.isDirectory() && depth < 4 && !entry.name.startsWith(".") && !SKIPPED_WALK.has(entry.name) && !isTestPath(`${child}/`)) await walk(child, depth + 1);
    }
  };
  await walk("", 1);
  return found.sort();
}

const SKIPPED_WALK = new Set(["node_modules", "__pycache__", "venv", "env", "site-packages", "dist", "build", "target", "vendor"]);

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
  if (stats.isSymbolicLink()) return linkIdentity(root, file);
  if (!stats.isFile() || stats.size > 1024 * 1024) return `size:${stats.size}`;
  return readFile(file, "utf8").catch(() => undefined);
}

/** A link is what it points at: the destination text, plus that file's content hash when it is a regular file inside the
 * project within the size bound. Anything else (broken, outside the project, too big) is marked unread, never followed. */
async function linkIdentity(root: string, file: string): Promise<string> {
  const destination = await readlink(file).catch(() => undefined);
  if (destination === undefined) return "link:unreadable";
  const [base, real] = await Promise.all([realpath(root).catch(() => undefined), realpath(file).catch(() => undefined)]);
  const inside = base !== undefined && real !== undefined && real.startsWith(base + path.sep);
  const stats = inside ? await lstat(real).catch(() => undefined) : undefined;
  if (!real || !stats?.isFile() || stats.size > 1024 * 1024) return `link:${destination}:unread`;
  const text = await readFile(real, "utf8").catch(() => undefined);
  return text === undefined ? `link:${destination}:unread` : `link:${destination}:${digest(text)}`;
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
