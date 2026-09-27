import { cp, lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AcceptanceCompletion, AcceptanceResult } from "./acceptance";
import { runCommandCheck } from "./command";
import { isTestPath } from "./proof";

/** Requirement-to-test tracing: every requirement the request states must be checked by a test that passes
 * with the change and fails without it. The model only maps requirements to tests; which tests pass with and
 * without the change is Casper's own run. A requirement no such test checks is reported by name. */

/** Per-test results by runner: bun `(pass|fail) name [1.2ms]`, jest/vitest `✓|✕|× name (3 ms)`, pytest -v
 * `path::name PASSED|FAILED`. The last result of a name wins. */
export function testResults(output: string): Map<string, "pass" | "fail"> {
  const results = new Map<string, "pass" | "fail">();
  for (const raw of output.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    const bun = /^\s*\((pass|fail)\)\s+(.+?)(?:\s+\[[\d.]+\s*m?s\])?\s*$/.exec(raw);
    if (bun) { results.set(bun[2]!, bun[1] as "pass" | "fail"); continue; }
    const jest = /^\s*([✓✔✕×])\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\)|\s+\d+(?:\.\d+)?\s*m?s)?\s*$/.exec(raw);
    if (jest) { results.set(jest[2]!, jest[1] === "✓" || jest[1] === "✔" ? "pass" : "fail"); continue; }
    const pytest = /^\s*\S+?::(\S+)\s+(PASSED|FAILED)\b/.exec(raw);
    if (pytest) results.set(pytest[1]!, pytest[2] === "PASSED" ? "pass" : "fail");
  }
  return results;
}

export const TRACE_SYSTEM_PROMPT = "Casper requirement tracing. List every behavior requirement the request states: something the code must observably do (a return value, output, error, order, boundary or state), each as a short quote of the request. Leave out instructions about how to work (which files to read or edit, dependencies, keeping tests unchanged, what graders will check) and the bare instruction to implement a function. For each, name the tests from the list given that check it: a test checks a requirement only when one of its assertions tests exactly what that requirement states (the stated value, boundary, order or error), not merely the same function. Use the test names exactly as listed. A requirement no listed test checks gets an empty list. Answer with only JSON: {\"requirements\":[{\"text\":\"...\",\"tests\":[\"...\"]}]}";

const TEST_FILE_LIMIT = 16 * 1024;
const TEST_BUDGET = 64 * 1024;
const OUTPUT_TAIL = 4000;
const TEXT_LIMIT = 200;
const EFFORT = "low";
const MAX_TOKENS = 16_000;

export interface TracedRequirement { text: string; tests: string[] }

/** Bun prints no per-test `(pass)` lines when it detects an AI agent (AGENT=1, CLAUDECODE=1, …), and tracing
 * reads them; Casper often runs inside such an agent. */
export function withoutAgentMarkers(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(AGENT|AI_AGENT|CLAUDECODE|OMPCODE|CURSOR_AGENT|GEMINI_CLI|CODEX_\w+)$/.test(name)));
}

/** Parse the model's mapping, keeping only listed test names. Undefined when the answer is not the JSON asked for. */
export function parseTrace(text: string, listed: ReadonlySet<string>): TracedRequirement[] | undefined {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return undefined; }
  const list = parsed && typeof parsed === "object" && "requirements" in parsed ? parsed.requirements : undefined;
  if (!Array.isArray(list) || !list.length) return undefined;
  const requirements: TracedRequirement[] = [];
  for (const entry of list) {
    const text = entry && typeof entry === "object" && "text" in entry ? entry.text : undefined;
    const named = entry && typeof entry === "object" && "tests" in entry ? entry.tests : undefined;
    if (typeof text !== "string" || !text.trim()) return undefined;
    const tests = Array.isArray(named) ? named.filter((name): name is string => typeof name === "string" && listed.has(name)) : [];
    requirements.push({ text: text.trim().slice(0, TEXT_LIMIT), tests: [...new Set(tests)] });
  }
  return requirements;
}

/** Trace the request's requirements to tests of `root` that pass there and fail (or do not exist) in `without`,
 * the tree before the change with the change's tests copied in. `status` is `fail` when a requirement has no such
 * test (`unconfirmed` names them), `error` when the tests could not run or the answer was unusable. */
export async function traceRequirements(input: {
  complete: AcceptanceCompletion;
  request: string;
  root: string;
  without: string;
  testCommand: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<AcceptanceResult & { requirements?: TracedRequirement[] }> {
  const none = { tokens: 0, estimatedCost: 0 };
  const run = (cwd: string) => runCommandCheck({ name: "test", command: input.testCommand, cwd, timeoutMs: input.timeoutMs, signal: input.signal, env: withoutAgentMarkers(process.env) });
  const [withChange, withoutChange] = [await run(input.root), await run(input.without)];
  if (withChange.exitCode === null) return { status: "error", reason: `the tests did not finish (${(withChange.reason ?? "no exit status").replace(/\.$/, "")})`, usage: none };
  const now = testResults(`${withChange.stdout}\n${withChange.stderr}`);
  const before = testResults(`${withoutChange.stdout}\n${withoutChange.stderr}`);
  const proving = [...now].filter(([name, result]) => result === "pass" && before.get(name) !== "pass").map(([name]) => name);
  if (!now.size) return { status: "error", reason: "the test output names no tests", usage: none };

  const sections = [`Request:\n${input.request}`, `Tests that pass with the change and fail without it:\n${proving.map((name) => `- ${name}`).join("\n") || "(none)"}`];
  let budget = TEST_BUDGET;
  for (const file of await testFiles(input.root)) {
    const text = await readFile(path.join(input.root, file), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const shown = text.length > TEST_FILE_LIMIT ? `${text.slice(0, TEST_FILE_LIMIT)}\n… (truncated)` : text;
    if (shown.length > budget) break;
    budget -= shown.length;
    sections.push(`Test file ${file}:\n\`\`\`\n${shown}\n\`\`\``);
  }
  const answer = await input.complete({ systemPrompt: TRACE_SYSTEM_PROMPT, user: sections.join("\n\n"), signal: input.signal, effort: EFFORT, maxTokens: MAX_TOKENS });
  if (answer.error !== undefined) return { status: "error", reason: `the tracing model call failed: ${answer.error}`, usage: answer.usage };
  const requirements = parseTrace(answer.text, new Set(proving));
  if (!requirements) return { status: "error", reason: "the tracing answer was not the requirement list asked for", usage: answer.usage };
  const unconfirmed = requirements.filter((requirement) => !requirement.tests.length).map((requirement) => requirement.text);
  return unconfirmed.length
    ? { status: "fail", unconfirmed, requirements, output: `${withChange.stdout}\n${withChange.stderr}`.slice(-OUTPUT_TAIL), usage: answer.usage }
    : { status: "pass", requirements, usage: answer.usage };
}

/** Test files under `root`, sorted, outside dependency and VCS directories. */
async function testFiles(root: string, relative = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => [])) {
    if (["node_modules", ".git", ".casper"].includes(entry.name)) continue;
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await testFiles(root, next));
    else if (entry.isFile() && isTestPath(next)) found.push(next);
  }
  return found.sort();
}

/** The tree before the change with the change's current tests copied in: what "without the change" means for tracing. */
export async function withoutTree(start: string, root: string, tests: readonly string[]): Promise<{ tree: string; dispose(): Promise<void> }> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "casper-trace-"));
  const tree = path.join(scratch, "without");
  await cp(start, tree, { recursive: true, verbatimSymlinks: true });
  for (const relative of tests) {
    const from = path.join(root, relative);
    if (!await lstat(from).then((stats) => stats.isFile(), () => false)) continue;
    await cp(from, path.join(tree, relative), { recursive: true });
  }
  return { tree, dispose: () => rm(scratch, { recursive: true, force: true }) };
}
