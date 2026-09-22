import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm } from "node:fs/promises";
import { openNoFollow } from "../src/platform/files";
import os from "node:os";
import path from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CasperApp } from "../src/app";
import { isolatedEnvironment } from "../src/platform/environment";
import { loadProjectContext } from "../src/project/context";
import { PiRuntime } from "../src/runtime/pi";
import type { AgentRuntime, RuntimeEventListener, RuntimeSession, RuntimeStartOptions, RuntimeUsage } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import type { TaskResult } from "../src/task/result";
import type { VerificationReport } from "../src/verify/evidence";

/** Independent acceptance command. `argv` is never run through a shell. */
export interface EvalVerification {
  readonly name: string;
  readonly argv: readonly string[];
}

/** Behavioral expectations checked against the resulting tree and the final answer. */
export interface EvalAcceptance {
  /** At least one touched path must live under each prefix. */
  readonly changed?: readonly string[];
  /** No touched path may live under any prefix. */
  readonly unchanged?: readonly string[];
  readonly contains?: readonly { readonly path: string; readonly text: string }[];
  /** Literal text that must appear nowhere under `under`. */
  readonly noMatch?: readonly { readonly text: string; readonly under: string }[];
  /** No path may change at all. */
  readonly noEdits?: boolean;
  /** Case-insensitive keywords the final answer must contain. Weak keyword grading, stated in docs. */
  readonly answerContains?: readonly string[];
}

export interface EvalTask {
  readonly id: string;
  readonly fixture: string;
  /** Overlay that turns the solved fixture into this task's starting state. */
  readonly setup?: string;
  readonly prompt: string;
  /** Every command must pass for the verification to pass; all of them run, in order. */
  readonly verify: readonly EvalVerification[];
  /** Independent-verification status expected on the untouched starting state. */
  readonly initialVerification: "pass" | "fail";
  /** Status the verification must have after the task for it to count as success. Default `pass`;
   * `fail` is for tasks whose correct outcome is to leave a red check red and say so. */
  readonly expectedVerification?: "pass" | "fail";
  readonly acceptance: EvalAcceptance;
}

/** Casper model reference, `provider/id`. */
export interface EvalModel {
  readonly provider: string;
  readonly id: string;
}

interface EvalMetrics {
  modelCalls: number;
  answer: string;
  errors: string[];
  usage?: RuntimeUsage;
  readonly sessions: RuntimeSession[];
}

export interface EvalCheckResult {
  name: string;
  status: "pass" | "fail";
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export interface EvalRunResult {
  taskId: string;
  fixture: string;
  startedAt: string;
  wallClockMs: number;
  /** `provider/id` the runtime reported for the session; null when the runtime reports no status. */
  model: string | null;
  execution: TaskResult["execution"] | "error";
  error?: string;
  /** Runtime-reported errors (provider, startup, abort), bounded and never treated as acceptance. */
  runtimeErrors: string[];
  /** Bounded tail of Casper's own output for diagnosing a failed run; never acceptance evidence. */
  outputTail: string;
  modelCalls: number;
  messages: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | null;
  contextTokens: number | null;
  filesAdded: string[];
  filesModified: string[];
  filesRemoved: string[];
  repairAttempts: number | null;
  selfVerification: VerificationReport["status"] | null;
  /** `status` is pass only when every check passed; `expected` is what the task needs. */
  verification: { status: "pass" | "fail"; expected: "pass" | "fail"; checks: EvalCheckResult[] };
  acceptance: { passed: boolean; failures: string[] };
  success: boolean;
}

/** Repeated runs of one task plus the numbers a single run cannot give. */
export interface EvalTaskSummary {
  taskId: string;
  fixture: string;
  runs: EvalRunResult[];
  passed: number;
  total: number;
  wallClockMs: { median: number; min: number; max: number };
  /** Median total tokens over the runs that reported usage; null when none did. */
  tokensMedian: number | null;
  /** Every run succeeded. One failing run out of n is a finding, not noise to average away. */
  success: boolean;
}

export interface EvalRunOptions {
  /** Repository root: resolves `{{tsc}}` and the fixture directory. */
  repoRoot: string;
  /** Defaults to Casper's own Pi runtime. Tests inject a deterministic runtime. */
  runtimeFactory?: () => AgentRuntime | Promise<AgentRuntime>;
  /** Casper state root for the run. Defaults to a fresh temporary directory, never the real home. */
  homeDir?: string;
  /** Select this model for the run's conversation only; the user's saved default is never written. */
  model?: EvalModel;
  /** Exercise Casper's own verification and repair loop. */
  autoVerify?: boolean;
  verifyTimeoutMs?: number;
  /** Keep the prepared work directory for inspection. */
  keepWorkdir?: boolean;
}

const TEXT_EXTENSIONS: Record<string, true> = {
  ".ts": true, ".js": true, ".json": true, ".yaml": true, ".yml": true, ".md": true, ".txt": true,
};
const MAX_SCAN_BYTES = 1024 * 1024;

async function walk(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(root, next));
    // Symlinks count as touched paths but are never followed, so a cycle cannot recurse.
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(next);
  }
  return files;
}

async function copyTree(source: string, destination: string): Promise<void> {
  for (const relative of await walk(source)) {
    const from = path.join(source, relative);
    if ((await lstat(from)).isSymbolicLink()) {
      throw new Error(`Fixture content must be plain files; ${relative} is a symlink`);
    }
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(from, target);
  }
}

/** Absolute tool paths so a fixture never depends on the child's PATH or shell. */
function toolPaths(repoRoot: string) {
  const tsc = path.join(repoRoot, "node_modules/typescript/bin/tsc");
  return { bun: process.execPath, tsc };
}

function resolveTools(text: string, repoRoot: string): string {
  if (!text.includes("{{")) return text;
  const { bun, tsc } = toolPaths(repoRoot);
  return text.replaceAll("{{bun}}", bun).replaceAll("{{tsc}}", tsc);
}

/** Copy the fixture and apply the task's setup overlay. */
export async function prepareWorkdir(task: EvalTask, repoRoot: string): Promise<string> {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "casper-eval-"));
  await copyTree(path.join(repoRoot, "evals/fixtures", task.fixture), workdir);
  if (task.setup) {
    const setup = path.join(repoRoot, "evals/setups", task.setup);
    await copyTree(path.join(setup, "files"), workdir);
    const removals = await readFile(path.join(setup, "remove.json"), "utf8").catch(() => "[]");
    for (const relative of JSON.parse(removals) as string[]) await rm(path.join(workdir, relative), { force: true });
  }
  return workdir;
}

async function digestTree(root: string): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  for (const relative of await walk(root)) {
    const target = path.join(root, relative);
    const stats = await lstat(target);
    // A symlink's identity is its target string; following it would escape the work directory.
    if (stats.isSymbolicLink()) { digests.set(relative, `link:${await readlink(target)}`); continue; }
    // Streamed: a model can leave an arbitrarily large file behind, and the harness must not
    // read it into memory to hash it.
    const hash = createHash("sha256");
    for await (const chunk of Bun.file(target).stream()) hash.update(chunk);
    digests.set(relative, hash.digest("hex"));
  }
  return digests;
}

/** Added/modified/removed paths, sorted. Removals cannot be content-compared. */
function diffTrees(before: Map<string, string>, after: Map<string, string>) {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [relative, digest] of after) {
    if (!before.has(relative)) added.push(relative);
    else if (before.get(relative) !== digest) modified.push(relative);
  }
  for (const relative of before.keys()) if (!after.has(relative)) removed.push(relative);
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() };
}

function recordEvent(event: Parameters<RuntimeEventListener>[0], metrics: EvalMetrics): void {
  if (event.type === "assistant_response_start") metrics.modelCalls++;
  else if (event.type === "assistant_text_delta") metrics.answer = (metrics.answer + event.delta).slice(0, 32_768);
  else if (event.type === "error" && metrics.errors.length < 4) metrics.errors.push(event.message.slice(0, 512));
}

function instrumentSession(session: RuntimeSession, metrics: EvalMetrics): RuntimeSession {
  metrics.sessions.push(session);
  return new Proxy(session, {
    get(target, property) {
      if (property === "subscribe") {
        return (listener: RuntimeEventListener) => target.subscribe((event) => { recordEvent(event, metrics); listener(event); });
      }
      if (property === "getUsage") {
        return () => {
          const usage = target.getUsage?.();
          if (usage) metrics.usage = usage;
          return usage;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Counts model responses and captures the final answer without changing runtime behavior. With a
 * model, selects it for the conversation only (`persist: false`): the user's saved default stays. */
function instrumentRuntime(runtime: AgentRuntime, metrics: EvalMetrics, model?: EvalModel): AgentRuntime {
  return new Proxy(runtime, {
    get(target, property) {
      if (property === "start") {
        return async (options: RuntimeStartOptions) => {
          const session = await target.start(options);
          if (model) {
            if (!session.selectModel) throw new Error("This runtime does not support model selection; drop --model.");
            await session.selectModel({ query: `${model.provider}/${model.id}`, persist: false });
          }
          return instrumentSession(session, metrics);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The measured runtime: Casper's own Pi runtime unless a caller injects one. Instrumentation is
 * unconditional, so a real-provider run reports the same numbers as a scripted test. */
async function createInstrumentedRuntime(options: EvalRunOptions, metrics: EvalMetrics): Promise<AgentRuntime> {
  return instrumentRuntime(options.runtimeFactory ? await options.runtimeFactory() : new PiRuntime(), metrics, options.model);
}

/** Resolve `provider/id` against Casper's own model catalog before any task runs, so an unknown
 * model or missing credentials fail the whole run up front instead of burning a fixture per task. */
export async function resolveEvalModel(reference: string): Promise<EvalModel> {
  const separator = reference.indexOf("/");
  const provider = reference.slice(0, separator).trim();
  const id = reference.slice(separator + 1).trim();
  if (separator < 0 || !provider || !id) throw new Error(`--model needs provider/model-id, got ${JSON.stringify(reference)}`);
  const agentDir = getAgentDir();
  const catalog = await ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` });
  if (!catalog.getModel(provider, id)) {
    const known = catalog.getModels(provider).map((model) => `${model.provider}/${model.id}`);
    throw new Error(`Unknown model ${provider}/${id}. ${known.length
      ? `Known for ${provider}: ${known.slice(0, 12).join(", ")}${known.length > 12 ? ", …" : ""}`
      : `No provider ${JSON.stringify(provider)}; known providers: ${catalog.getProviders().map((entry) => entry.id).join(", ")}`}`);
  }
  if (!catalog.hasConfiguredAuth(provider)) throw new Error(`Credentials missing for ${provider}; configure them (casper /login) before evaluating ${provider}/${id}.`);
  return { provider, id };
}

async function runCheck(
  verification: EvalVerification,
  options: { workdir: string; repoRoot: string; homeDir: string; timeoutMs: number },
): Promise<EvalCheckResult> {
  const argv = verification.argv.map((argument) => resolveTools(argument, options.repoRoot));
  const started = performance.now();
  const child = Bun.spawn([...argv], {
    cwd: options.workdir, env: isolatedEnvironment(options.homeDir), stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return {
      name: verification.name, status: exitCode === 0 ? "pass" : "fail",
      exitCode, durationMs: Math.round(performance.now() - started),
      output: `${stdout}${stderr}`.slice(-4096),
    };
  } finally { clearTimeout(timer); }
}

/** Run every check in order; the verification passes only when all of them do. */
export async function runVerification(
  verification: readonly EvalVerification[],
  options: { workdir: string; repoRoot: string; homeDir: string; timeoutMs: number },
): Promise<{ status: "pass" | "fail"; checks: EvalCheckResult[] }> {
  const checks: EvalCheckResult[] = [];
  for (const check of verification) checks.push(await runCheck(check, options));
  return { status: checks.every((check) => check.status === "pass") ? "pass" : "fail", checks };
}

async function fileContains(root: string, relative: string, text: string): Promise<boolean> {
  return (await readFile(path.join(root, relative), "utf8").catch(() => "")).includes(text);
}

async function matchesAnywhere(root: string, under: string, text: string): Promise<{ hits: string[]; unavailable: string[] }> {
  const hits: string[] = [], unavailable: string[] = [];
  for (const relative of await walk(root)) {
    if (under !== "." && relative !== under && !relative.startsWith(`${under}/`)) continue;
    if (!TEXT_EXTENSIONS[path.extname(relative)]) continue;
    const target = path.join(root, relative);
    // Absence must be established, not inferred from skipped/unreadable files. Read
    // at most the limit plus one byte, including when a file grows after stat().
    try {
      const file = await openNoFollow(target);
      try {
        if (!(await file.stat()).isFile()) throw new Error("Not a regular file");
        const contents = Buffer.alloc(MAX_SCAN_BYTES + 1);
        let size = 0;
        while (size < contents.length) {
          const { bytesRead } = await file.read(contents, size, contents.length - size, size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > MAX_SCAN_BYTES) unavailable.push(relative);
        else if (contents.subarray(0, size).includes(text)) hits.push(relative);
      } finally { await file.close(); }
    } catch { unavailable.push(relative); }
  }
  return { hits, unavailable };
}

/** Evaluate the declared acceptance predicates against the final tree. */
export async function evaluateAcceptance(
  acceptance: EvalAcceptance, context: { workdir: string; touched: readonly string[]; answer: string },
): Promise<{ passed: boolean; failures: string[] }> {
  const failures: string[] = [];
  const touched = context.touched;
  const under = (prefix: string) => touched.some((entry) => entry === prefix || entry.startsWith(prefix));
  for (const prefix of acceptance.changed ?? []) if (!under(prefix)) failures.push(`no change under ${prefix}`);
  for (const prefix of acceptance.unchanged ?? []) if (under(prefix)) failures.push(`changed under ${prefix}: ${touched.filter((entry) => entry.startsWith(prefix)).join(", ")}`);
  for (const rule of acceptance.contains ?? []) if (!await fileContains(context.workdir, rule.path, rule.text)) failures.push(`${rule.path} does not contain ${JSON.stringify(rule.text)}`);
  for (const rule of acceptance.noMatch ?? []) {
    const { hits, unavailable } = await matchesAnywhere(context.workdir, rule.under, rule.text);
    if (hits.length) failures.push(`${JSON.stringify(rule.text)} still present in ${hits.join(", ")}`);
    if (unavailable.length) failures.push(`${JSON.stringify(rule.text)} absence scan unavailable for ${unavailable.join(", ")} (symlink, unreadable, non-regular or over 1 MiB)`);
  }
  if (acceptance.noEdits && touched.length) failures.push(`edited ${touched.join(", ")}`);
  for (const keyword of acceptance.answerContains ?? []) {
    if (!context.answer.toLowerCase().includes(keyword.toLowerCase())) failures.push(`answer does not mention ${JSON.stringify(keyword)}`);
  }
  return { passed: failures.length === 0, failures };
}

/** Run one evaluation task end to end: prepare, run Casper, measure, verify, grade. */
export async function runEvalTask(task: EvalTask, options: EvalRunOptions): Promise<EvalRunResult> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const homeDir = options.homeDir ?? await mkdtemp(path.join(os.tmpdir(), "casper-eval-home-"));
  const workdir = await prepareWorkdir(task, options.repoRoot);
  const before = await digestTree(workdir);
  const metrics: EvalMetrics = { modelCalls: 0, answer: "", errors: [], sessions: [] };

  let app: CasperApp | undefined;
  let execution: EvalRunResult["execution"] = "error";
  let error: string | undefined;
  let output = "";
  try {
    app = new CasperApp({
      runtimeFactory: () => createInstrumentedRuntime(options, metrics),
      autoVerify: options.autoVerify ?? true,
      sessionHomeDir: homeDir,
      loadProjectContext: (project) => loadProjectContext(project, { homeDir }),
      loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir, imports: context.skills.imports, maxActive: context.skills.maxActive }),
      loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
      output: { write: (text) => { output = (output + text).slice(-4096); } },
    });
    await app.runOnce(task.prompt, workdir);
    const taskResult = app.getLastTaskResult();
    execution = taskResult?.execution ?? "error";
    if (!taskResult) metrics.errors.push("Casper recorded no task result for this prompt");
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  const taskResult = app?.getLastTaskResult();
  let model: string | null = null;
  for (const session of metrics.sessions) {
    try {
      const usage = session.getUsage?.(); if (usage) metrics.usage = usage;
      const status = session.getStatus?.();
      if (status?.provider && status.model) model = `${status.provider}/${status.model}`;
    } catch { /* disposed runtime */ }
  }
  await app?.close();

  const after = await digestTree(workdir);
  const diff = diffTrees(before, after);
  const touched = [...diff.added, ...diff.modified, ...diff.removed];
  // Grade the model's end state before the grader's own command can touch the tree.
  const acceptance = await evaluateAcceptance(task.acceptance, { workdir, touched, answer: metrics.answer });
  const expected = task.expectedVerification ?? "pass";
  let verification: EvalRunResult["verification"];
  try {
    verification = { ...await runVerification(task.verify, {
      workdir, repoRoot: options.repoRoot, homeDir, timeoutMs: options.verifyTimeoutMs ?? 120_000,
    }), expected };
  } finally {
    // A misconfigured verification command must not leak the work directory or the temporary home.
    if (!options.keepWorkdir) await rm(workdir, { recursive: true, force: true });
    if (!options.homeDir) await rm(homeDir, { recursive: true, force: true });
  }

  const usage = metrics.usage;
  return {
    taskId: task.id, fixture: task.fixture, startedAt,
    wallClockMs: Math.round(performance.now() - started),
    model,
    execution, error, runtimeErrors: metrics.errors, outputTail: output,
    modelCalls: metrics.modelCalls,
    messages: usage?.messages ?? null,
    tokens: usage ? {
      input: usage.tokens.input, output: usage.tokens.output, cacheRead: usage.tokens.cacheRead,
      cacheWrite: usage.tokens.cacheWrite, total: usage.tokens.total,
    } : null,
    contextTokens: usage?.context?.tokens ?? null,
    filesAdded: diff.added, filesModified: diff.modified, filesRemoved: diff.removed,
    repairAttempts: taskResult?.verification?.repairAttempts ?? null,
    selfVerification: taskResult?.verification?.status ?? null,
    verification,
    acceptance,
    // A task that never received a model response did no work, whatever the tree looks like.
    success: execution === "completed" && metrics.modelCalls > 0 && verification.status === expected && acceptance.passed,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** Aggregate repeated runs of one task. Requires at least one run. */
export function summarizeEvalRuns(task: EvalTask, runs: readonly EvalRunResult[]): EvalTaskSummary {
  if (!runs.length) throw new Error(`No runs recorded for ${task.id}`);
  const wall = runs.map((run) => run.wallClockMs);
  const tokens = runs.flatMap((run) => run.tokens ? [run.tokens.total] : []);
  const passed = runs.filter((run) => run.success).length;
  return {
    taskId: task.id, fixture: task.fixture, runs: [...runs], passed, total: runs.length,
    wallClockMs: { median: median(wall), min: Math.min(...wall), max: Math.max(...wall) },
    tokensMedian: tokens.length ? median(tokens) : null,
    success: passed === runs.length,
  };
}
