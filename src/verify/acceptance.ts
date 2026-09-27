import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TreeChanges } from "../task/changes";
import { runCommandCheck } from "./command";
import { isCodePath, isTestPath } from "./proof";

/** One model call outside the task conversation. `effort` and `maxTokens`, when given, override the
 * session's effort and cap the answer. `usage` is null when the provider reported none. */
export type AcceptanceCompletion = (input: { systemPrompt: string; user: string; signal?: AbortSignal; effort?: string; maxTokens?: number }) => Promise<{
  text: string;
  /** Set when the call failed or was aborted; `text` is then ignored. */
  error?: string;
  usage: { tokens: number; estimatedCost: number } | null;
}>;

/** Tests written from the request alone, run against the change. Signal only: never repaired, never kept. */
export interface AcceptanceResult {
  status: "pass" | "fail" | "error";
  reason?: string;
  /** Tail of the test run's output when it failed. */
  output?: string;
  /** The failing tests' names (each quotes a requirement), parsed from the run's output. Set only on a
   * fail that named at least one test. */
  unconfirmed?: string[];
  /** Zero when no model call ran; null when the provider reported none. */
  usage: { tokens: number; estimatedCost: number } | null;
}

export const ACCEPTANCE_SYSTEM_PROMPT = "Casper independent acceptance. You write one test file that checks a change against the request alone. Write one test per requirement the request states, and name each test with a short quote of that requirement. Assert only what the request states; never copy behavior from the code shown, which may be wrong. Import the code under test with paths relative to your file. Answer with exactly one fenced code block containing the whole file and nothing else.";

const DOC_LIMIT = 8 * 1024;
const FILE_LIMIT = 16 * 1024;
const CODE_BUDGET = 48 * 1024;
const EXAMPLE_LIMIT = 8 * 1024;
const OUTPUT_TAIL = 4000;
const NAME_LIMIT = 200;
const NAME_COUNT = 20;
/** The acceptance answer is one test file: a low-effort call with a capped answer is enough. */
const EFFORT = "low";
const MAX_TOKENS = 24_000;
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"];

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;
const readText = (file: string) => readFile(file, "utf8").catch(() => undefined);

/** Where the generated test goes: beside the project's first test file (sorted), else `tests/`. */
export function acceptanceTarget(files: Iterable<string>, hex: string): { relative: string; testDir: string } {
  const first = [...files].filter((file) => isTestPath(file) && !file.split("/").includes("node_modules")).sort()[0];
  const testDir = first ? path.posix.dirname(first) : "tests";
  const found = first ? path.posix.extname(first) : "";
  const ext = EXTENSIONS.includes(found) ? found : ".ts";
  const name = ext === ".py" ? `test_casper_acceptance_${hex}.py` : `casper-acceptance-${hex}.test${ext}`;
  return { relative: path.posix.join(testDir, name), testDir };
}

/** Failing-test lines by runner: bun `(fail) name [1.2ms]`, jest/vitest `✕ name (3 ms)` / `× name 3ms`,
 * pytest `FAILED path::name - reason`. Each captures the name without its timing or reason. */
const FAILED_TEST_LINES = [
  /^\s*\(fail\)\s+(.+?)(?:\s+\[[\d.]+\s*m?s\])?\s*$/,
  /^\s*[✕×]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\)|\s+\d+(?:\.\d+)?\s*m?s)?\s*$/,
  /^\s*FAILED\s+\S+?::(.+?)(?:\s+-\s.*)?\s*$/,
];

/** The failing test names in a run's output, in order: deduplicated, each ≤ 200 characters, at most 20. */
export function failedTestNames(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const name = FAILED_TEST_LINES.map((pattern) => pattern.exec(line)?.[1]).find(Boolean)?.trim().slice(0, NAME_LIMIT);
    if (name) names.add(name);
    if (names.size === NAME_COUNT) break;
  }
  return [...names];
}

export async function independentAcceptance(input: {
  complete: AcceptanceCompletion;
  request: string;
  root: string;
  changes: TreeChanges;
  /** The workspace snapshot now; only its paths are used. */
  files: Map<string, string>;
  testCommand: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<AcceptanceResult> {
  const { relative, testDir } = acceptanceTarget(input.files.keys(), randomBytes(4).toString("hex"));
  const sections = [`Request:\n${input.request}`];
  for (const doc of ["CONTEXT.md", "AGENTS.md"]) {
    const text = await readText(path.join(input.root, doc));
    if (text !== undefined) sections.push(`${doc}:\n${clip(text, DOC_LIMIT)}`);
  }
  let budget = CODE_BUDGET;
  const omitted: string[] = [];
  for (const file of [...input.changes.added, ...input.changes.modified].filter(isCodePath).sort()) {
    const text = await readText(path.join(input.root, file));
    if (text === undefined) continue;
    const shown = clip(text, FILE_LIMIT);
    if (shown.length > budget) { omitted.push(file); continue; }
    budget -= shown.length;
    sections.push(`Changed file ${file}:\n\`\`\`\n${shown}\n\`\`\``);
  }
  if (omitted.length) sections.push(`Also changed (not shown): ${omitted.join(", ")}`);
  const examples = [...input.files.keys()].filter((file) => path.posix.dirname(file) === testDir && isTestPath(file)).sort().slice(0, 2);
  for (const file of examples) {
    const text = await readText(path.join(input.root, file));
    if (text !== undefined) sections.push(`Existing test ${file} (style example):\n\`\`\`\n${clip(text, EXAMPLE_LIMIT)}\n\`\`\``);
  }
  sections.push(`Your file will be saved as ${relative} and run with: ${input.testCommand} ./${relative}`);

  const answer = await input.complete({ systemPrompt: ACCEPTANCE_SYSTEM_PROMPT, user: sections.join("\n\n"), signal: input.signal, effort: EFFORT, maxTokens: MAX_TOKENS });
  const usage = answer.usage;
  if (answer.error !== undefined) return { status: "error", reason: `the acceptance model call failed: ${answer.error}`, usage };
  const body = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(answer.text)?.[1];
  if (body === undefined) return { status: "error", reason: "the acceptance answer had no test file", usage };

  const target = path.join(input.root, relative);
  const directory = path.dirname(target);
  const createdDirectory = !await stat(directory).then(() => true, () => false);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(target, body);
    const result = await runCommandCheck({ name: "test", command: `${input.testCommand} ./${relative}`, cwd: input.root, timeoutMs: input.timeoutMs, signal: input.signal });
    if (result.exitCode === null) return { status: "error", reason: `the acceptance tests did not finish (${(result.reason ?? "no exit status").replace(/\.$/, "")})`, usage };
    if (result.exitCode === 0) return { status: "pass", usage };
    const output = `${result.stdout}\n${result.stderr}`;
    const unconfirmed = failedTestNames(output);
    return { status: "fail", output: output.slice(-OUTPUT_TAIL), ...(unconfirmed.length ? { unconfirmed } : {}), usage };
  } finally {
    await rm(createdDirectory ? directory : target, { recursive: true, force: true });
  }
}
