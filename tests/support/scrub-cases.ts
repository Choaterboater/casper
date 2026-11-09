import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanEnv } from "./env";
import { removeTempDir } from "./temp-dir";

// fixtures/scrub-cases.json, the table tests/secrets-live-drift.test.ts runs (decision 98): the inputs the secrets tests
// send through the final output scrub, with the environment values, logins and typed secrets they used. Collect it
// again with `bun tests/support/scrub-cases.ts` after a listed test changes; this file finds those tests and checks
// that none changed since.

const TESTS = path.resolve(import.meta.dir, "..");
export const CASES_FILE = path.join(TESTS, "fixtures/scrub-cases.json");
export interface ScrubCases { from: string[]; sums: Record<string, string>; env: Record<string, string>; values: string[]; typed: string[]; texts: string[] }

const SOURCE = /\.[cm]?[jt]sx?$/;
// Written in two parts, so this file is not a helper that calls the scrub.
const CALL = "scrubToolOutput" + "(";
const read = (name: string) => readFile(path.join(TESTS, name), "utf8");
// The drift test, its parts and the helper they share.
const DRIFT_FILES = /^secrets-live-drift(?:-states-\d+)?\.test\.ts$/;
const DRIFT_HELPER = "support/live-drift";

/** Every string literal in a source: quoted, or a template's text. */
export const literals = (text: string) => [...text.matchAll(/(["'])((?:\\.|(?!\1)[^\\\n])*)\1|`((?:\\.|[^\\`])*)`/g)].map((match) => match[2] ?? match[3] ?? "");

/**
 * The test files that call the final output scrub, or name a helper under fixtures or support that does (an import, a
 * path joined from parts or one a test spawns: its file name without its extension in any string literal), and those
 * helpers. `skipDrift`: leave out the drift test itself, its parts and their helper, which run the table's own inputs.
 */
export async function scrubCallers(skipDrift = false): Promise<{ callers: string[]; helpers: string[] }> {
  const sources = new Map<string, string>();
  for (const folder of ["fixtures", "support"]) {
    for (const name of await readdir(path.join(TESTS, folder), { recursive: true })) {
      if (SOURCE.test(name) && !(skipDrift && `${folder}/${name}`.replace(SOURCE, "") === DRIFT_HELPER)) sources.set(`${folder}/${name.split(path.sep).join("/").replace(SOURCE, "")}`, await read(path.join(folder, name)));
    }
  }
  const names = (text: string, helper: string) => {
    const base = new RegExp(`(?<![\\w-])${path.posix.basename(helper).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
    return literals(text).some((literal) => base.test(literal));
  };
  const helpers = new Set<string>();
  for (let size = -1; size !== helpers.size;) {
    size = helpers.size;
    for (const [helper, text] of sources) if (text.includes(CALL) || [...helpers].some((other) => names(text, other))) helpers.add(helper);
  }
  const callers: string[] = [];
  for (const name of (await readdir(TESTS)).sort()) {
    if (!name.endsWith(".test.ts") || (skipDrift && DRIFT_FILES.test(name))) continue;
    const text = await read(name);
    if (text.includes(CALL) || [...helpers].some((helper) => names(text, helper))) callers.push(`tests/${name}`);
  }
  return { callers, helpers: [...helpers].sort() };
}

/**
 * A sum of each caller's and helper's string literals, test names left out: a new or changed input in a listed file
 * changes its sum, so the drift test fails until the table is collected again. Code and test names may change freely.
 */
export async function literalSums(callers: string[], helpers: string[]): Promise<Record<string, string>> {
  const sums: Record<string, string> = {};
  const files = [...callers.map((name) => name.replace(/^tests\//, "")), ...await Promise.all(helpers.map(async (helper) => {
    const folder = path.join(TESTS, path.dirname(helper));
    const file = (await readdir(folder)).find((name) => name.replace(SOURCE, "") === path.basename(helper) && SOURCE.test(name))!;
    return path.posix.join(path.dirname(helper), file);
  }))];
  for (const file of files.sort()) {
    const text = (await read(file)).replace(/\b(?:test|it|describe)(?:\.\w+)*\(\s*(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "");
    sums[`tests/${file}`] = createHash("sha256").update(literals(text).join("\0")).digest("hex").slice(0, 16);
  }
  return sums;
}

/**
 * Collect the table again: run the callers with a preload that records every final output scrub's input (and
 * fixtures/pi-scrub.ts's, in its own process), add what is new to the table, never drop an input, and write the callers
 * and their sums.
 */
async function collect(): Promise<void> {
  const { callers, helpers } = await scrubCallers(true);
  const out = await mkdtemp(path.join(os.tmpdir(), "casper-scrub-cases-"));
  try {
    const recorder = path.join(import.meta.dir, "scrub-cases-recorder.ts");
    // The preload goes after "test": flags before it (or in BUN_OPTIONS) make Bun run package.json's "test" script.
    const child = Bun.spawn([process.execPath, "test", "--preload", recorder, "--parallel=4", ...callers.map((name) => `./${name}`)], {
      cwd: path.dirname(TESTS), stdout: "inherit", stderr: "inherit", env: cleanEnv({ SCRUB_CASES_RECORD: out }),
    });
    if (await child.exited !== 0) throw new Error("the listed tests failed, so the table is left as it was");
    const old = JSON.parse(await readFile(CASES_FILE, "utf8")) as Partial<ScrubCases>;
    const table: ScrubCases = { from: callers, sums: await literalSums(callers, helpers), env: { ...old.env },
      values: [...old.values ?? []], typed: [...old.typed ?? []], texts: [...old.texts ?? []] };
    const seen = new Set(table.texts);
    for (const name of (await readdir(out)).sort()) {
      for (const line of (await readFile(path.join(out, name), "utf8")).split("\n")) {
        if (!line) continue;
        const entry = JSON.parse(line) as { texts: string[]; env: Record<string, string>; values: string[]; typed: string[] };
        for (const text of entry.texts) if (text.trim() && !seen.has(text)) { seen.add(text); table.texts.push(text); }
        for (const [key, value] of Object.entries(entry.env)) table.env[key] ??= value;
        for (const value of entry.values) if (!table.values.includes(value)) table.values.push(value);
        for (const value of entry.typed) if (!table.typed.includes(value)) table.typed.push(value);
      }
    }
    table.env = Object.fromEntries(Object.entries(table.env).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(CASES_FILE, `${JSON.stringify(table, null, 1)}\n`);
    console.log(`${CASES_FILE}: ${table.texts.length} inputs (${table.texts.length - (old.texts?.length ?? 0)} new) from ${callers.length} test files`);
  } finally {
    await removeTempDir(out);
  }
}

if (import.meta.main) await collect();
