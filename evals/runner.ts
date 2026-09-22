import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { openNoFollow } from "../src/platform/files";
import os from "node:os";
import path from "node:path";
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
  /** Top-level production paths copied into a host-owned solved fixture for grading. */
  readonly candidatePaths: readonly string[];
}

/** Behavioral expectations checked against the resulting tree and the final answer. */
export interface EvalAcceptance {
  /** At least one touched path must live under each prefix. */
  readonly changed?: readonly string[];
  /** No touched path may live under any prefix. */
  readonly unchanged?: readonly string[];
  /** Only these exact paths or directory prefixes (ending in /) may change. */
  readonly allowedChanges?: readonly string[];
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
  readonly verify: EvalVerification;
  /** Independent-verification status expected on the untouched starting state. */
  readonly initialVerification: "pass" | "fail";
  readonly acceptance: EvalAcceptance;
  /** Host-observed workflow checks, in addition to behavioral verification. */
  readonly requiredEvidence?: readonly string[];
}

interface EvalMetrics {
  modelCalls: number;
  answer: string;
  errors: string[];
  usage?: RuntimeUsage;
  readonly sessions: RuntimeSession[];
}

export interface EvalIntervention {
  readonly kind: "required" | "rescue";
  readonly atMs: number;
  readonly reason: string;
}

export interface EvalObservation {
  startedAt: string;
  wallClockMs: number;
  execution: TaskResult["execution"] | "error";
  modelCalls: number;
  answer: string;
  interventions: readonly EvalIntervention[];
  usage?: RuntimeUsage;
  workflowChecks?: readonly { id: string; passed: boolean; evidence: string }[];
  error?: string;
  runtimeErrors?: string[];
  outputTail?: string;
  repairAttempts?: number;
  selfVerification?: VerificationReport["status"];
}

export interface EvalRunResult {
  attemptId: string;
  evidenceSource: "runtime" | "host-observation";
  outcome: "accepted-without-rescue" | "accepted-with-rescue" | "not-accepted";
  interventions: readonly EvalIntervention[];
  workflowChecks: NonNullable<EvalObservation["workflowChecks"]>;
  /** Adapter/host-reported estimates, not billing; missing values remain unknown. */
  reportedUsage: RuntimeUsage | null;
  taskId: string;
  fixture: string;
  startedAt: string;
  wallClockMs: number;
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
  verification: { name: string; status: "pass" | "fail" | "unavailable"; exitCode: number | null; durationMs: number; output: string };
  acceptance: { passed: boolean; failures: string[] };
  success: boolean;
}

export interface EvalRunOptions {
  /** Repository root: resolves `{{tsc}}` and the fixture directory. */
  repoRoot: string;
  /** Defaults to Casper's own Pi runtime. Tests inject a deterministic runtime. */
  runtimeFactory?: () => AgentRuntime | Promise<AgentRuntime>;
  /** Casper state root for the run. Defaults to a fresh temporary directory, never the real home. */
  homeDir?: string;
  /** Exercise Casper's own verification and repair loop. */
  autoVerify?: boolean;
  verifyTimeoutMs?: number;
  /** Keep the prepared work directory for inspection. */
  keepWorkdir?: boolean;
  /** Host-recorded interactions; no rescue is inferred from Casper's automatic repair loop. */
  interventions?: readonly EvalIntervention[];
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
export async function prepareWorkdir(task: EvalTask, repoRoot: string, destination?: string): Promise<string> {
  const workdir = destination ?? await mkdtemp(path.join(os.tmpdir(), "casper-eval-"));
  if (destination) await mkdir(workdir, { recursive: true });
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

/** Counts model responses and captures the final answer without changing runtime behavior. */
function instrumentRuntime(runtime: AgentRuntime, metrics: EvalMetrics): AgentRuntime {
  return new Proxy(runtime, {
    get(target, property) {
      if (property === "start") {
        return async (options: RuntimeStartOptions) => instrumentSession(await target.start(options), metrics);
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The measured runtime: Casper's own Pi runtime unless a caller injects one. Instrumentation is
 * unconditional, so a real-provider run reports the same numbers as a scripted test. */
async function createInstrumentedRuntime(options: EvalRunOptions, metrics: EvalMetrics): Promise<AgentRuntime> {
  return instrumentRuntime(options.runtimeFactory ? await options.runtimeFactory() : new PiRuntime(), metrics);
}

export async function runVerification(
  verification: EvalVerification,
  options: { workdir: string; repoRoot: string; homeDir: string; timeoutMs: number },
) {
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
      name: verification.name, status: exitCode === 0 ? "pass" as const : "fail" as const,
      exitCode, durationMs: Math.round(performance.now() - started),
      output: `${stdout}${stderr}`.slice(-4096),
    };
  } finally { clearTimeout(timer); }
}

/** Only production paths enter the evaluator; its tests and configuration stay frozen. */
async function runIndependentVerification(
  verification: EvalVerification,
  options: { workdir: string; evaluator: string; repoRoot: string; homeDir: string; timeoutMs: number },
) {
  const started = performance.now();
  try {
    for (const relative of verification.candidatePaths) {
      if (!/^[\w.-]+$/.test(relative) || relative === "." || relative === "..") {
        throw new Error(`Candidate path must be a top-level name: ${relative}`);
      }
      const source = path.join(options.workdir, relative);
      const destination = path.join(options.evaluator, relative);
      await rm(destination, { recursive: true, force: true });
      const info = await lstat(source).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      // A deleted source must stay deleted, never fall back to the solved fixture.
      if (!info) continue;
      if (info.isSymbolicLink()) throw new Error(`Candidate source is a symlink: ${relative}`);
      if (info.isDirectory()) {
        await mkdir(destination, { recursive: true });
        await copyTree(source, destination);
      } else if (info.isFile()) {
        await copyFile(source, destination);
      } else {
        throw new Error(`Candidate source is not a plain file or directory: ${relative}`);
      }
    }
    return await runVerification(verification, { ...options, workdir: options.evaluator });
  } catch (error) {
    return {
      name: verification.name, status: "unavailable" as const, exitCode: null,
      durationMs: Math.round(performance.now() - started),
      output: `Independent verification unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
  if (acceptance.allowedChanges) {
    for (const entry of touched) {
      if (!acceptance.allowedChanges.some(allowed => entry === allowed || (allowed.endsWith("/") && entry.startsWith(allowed)))) {
        failures.push(`changed outside allowed scope: ${entry}`);
      }
    }
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
  // Freeze grading inputs before the candidate runs, outside its editable workspace.
  const evaluator = await prepareWorkdir({ ...task, setup: undefined }, options.repoRoot);
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
      loadProjectContext: async (project) => {
        // Git discovery can escape a fixture when TMPDIR is inside another repo.
        // Reject before loading that repo's configuration or constructing a runtime.
        if (await realpath(project.root) !== await realpath(workdir)) {
          throw new Error("Evaluation project resolved outside the prepared candidate workspace; use a temporary directory outside any enclosing Git repository");
        }
        return loadProjectContext(project, { homeDir });
      },
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
  for (const session of metrics.sessions) {
    try { const usage = session.getUsage?.(); if (usage) metrics.usage = usage; } catch { /* disposed runtime */ }
  }
  await app?.close();

  let result: EvalRunResult;
  try {
    result = await gradeCandidate(task, { workdir, evaluator, repoRoot: options.repoRoot, homeDir, timeoutMs: options.verifyTimeoutMs ?? 120_000 }, before, {
      startedAt, wallClockMs: Math.round(performance.now() - started), execution, modelCalls: metrics.modelCalls,
      answer: metrics.answer, interventions: options.interventions ?? [], usage: metrics.usage,
      error, runtimeErrors: metrics.errors, outputTail: output,
      repairAttempts: taskResult?.verification?.repairAttempts, selfVerification: taskResult?.verification?.status,
    }, "runtime");
  } finally {
    if (!options.keepWorkdir) await rm(workdir, { recursive: true, force: true });
    if (!options.homeDir) await rm(homeDir, { recursive: true, force: true });
    await rm(evaluator, { recursive: true, force: true });
  }
  result.wallClockMs = Math.round(performance.now() - started);
  return result;
}

async function gradeCandidate(
  task: EvalTask,
  options: { workdir: string; evaluator: string; repoRoot: string; homeDir: string; timeoutMs: number },
  before: Map<string, string>,
  observation: EvalObservation,
  evidenceSource: EvalRunResult["evidenceSource"],
): Promise<EvalRunResult> {
  const after = await digestTree(options.workdir);
  const diff = diffTrees(before, after);
  const touched = [...diff.added, ...diff.modified, ...diff.removed];
  const acceptance = await evaluateAcceptance(task.acceptance, { workdir: options.workdir, touched, answer: observation.answer });
  for (const id of task.requiredEvidence ?? []) {
    const checks = observation.workflowChecks?.filter(check => check.id === id) ?? [];
    if (checks.length !== 1 || !checks[0]!.passed || !checks[0]!.evidence.trim()) {
      acceptance.failures.push(`workflow evidence missing or failed: ${id}`);
    }
  }
  acceptance.passed = acceptance.failures.length === 0;
  const verification = await runIndependentVerification(task.verify, options);
  const success = observation.execution === "completed" && observation.modelCalls > 0 && verification.status === "pass" && acceptance.passed;
  const interventions = structuredClone(observation.interventions);
  const usage = observation.usage;
  return {
    attemptId: randomUUID(), evidenceSource,
    outcome: !success ? "not-accepted" : interventions.some(entry => entry.kind === "rescue") ? "accepted-with-rescue" : "accepted-without-rescue",
    interventions, workflowChecks: structuredClone(observation.workflowChecks ?? []), reportedUsage: usage ? structuredClone(usage) : null,
    taskId: task.id, fixture: task.fixture, startedAt: observation.startedAt, wallClockMs: observation.wallClockMs,
    execution: observation.execution, error: observation.error, runtimeErrors: observation.runtimeErrors ?? [], outputTail: observation.outputTail ?? "",
    modelCalls: observation.modelCalls, messages: usage?.messages ?? null, tokens: usage ? { ...usage.tokens } : null,
    contextTokens: usage?.context?.tokens ?? null,
    filesAdded: diff.added, filesModified: diff.modified, filesRemoved: diff.removed,
    repairAttempts: observation.repairAttempts ?? null, selfVerification: observation.selfVerification ?? null,
    verification, acceptance, success,
  };
}

interface PreparedEvalManifest {
  version: 1;
  task: EvalTask;
  repoRoot: string;
  before: [string, string][];
  evaluatorDigests: [string, string][];
}

/** Credential-free preparation; all owned files live beneath the returned root. */
export async function prepareEvalTask(task: EvalTask, repoRoot: string): Promise<{ root: string; workdir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-eval-prepared-"));
  const workdir = path.join(root, "candidate");
  try {
    await prepareWorkdir(task, repoRoot, workdir);
    const evaluator = await prepareWorkdir({ ...task, setup: undefined }, repoRoot, path.join(root, "evaluator"));
    const manifest: PreparedEvalManifest = {
      version: 1, task, repoRoot: path.resolve(repoRoot),
      before: [...await digestTree(workdir)], evaluatorDigests: [...await digestTree(evaluator)],
    };
    await writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await writeFile(path.join(root, "prompt.txt"), `${task.prompt}\n`, { flag: "wx" });
    await mkdir(path.join(root, "home"));
    await mkdir(path.join(root, "results"));
    return { root, workdir };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function requireObservation(value: unknown): asserts value is EvalObservation {
  if (!value || typeof value !== "object") throw new Error("Observation must be an object");
  const entry = value as EvalObservation;
  if (!["completed", "failed", "cancelled", "error"].includes(entry.execution)
    || typeof entry.startedAt !== "string" || !Number.isFinite(Date.parse(entry.startedAt))
    || !Number.isFinite(entry.wallClockMs) || entry.wallClockMs < 0
    || !Number.isSafeInteger(entry.modelCalls) || entry.modelCalls < 0
    || typeof entry.answer !== "string" || !Array.isArray(entry.interventions)) {
    throw new Error("Observation needs execution, startedAt, wallClockMs, modelCalls, answer and interventions");
  }
  let previous = 0;
  for (const intervention of entry.interventions) {
    if (!intervention || !["required", "rescue"].includes(intervention.kind)
      || !Number.isFinite(intervention.atMs) || intervention.atMs < previous || intervention.atMs > entry.wallClockMs
      || typeof intervention.reason !== "string" || !intervention.reason.trim()) {
      throw new Error("Interventions need a required/rescue kind, ordered elapsed time within the attempt and a reason");
    }
    previous = intervention.atMs;
  }
  if (entry.workflowChecks !== undefined && (!Array.isArray(entry.workflowChecks) || entry.workflowChecks.some(check =>
    !check || typeof check.id !== "string" || typeof check.passed !== "boolean" || typeof check.evidence !== "string"))) {
    throw new Error("Workflow checks need id, passed and host evidence");
  }
  if (entry.usage !== undefined) {
    const usage = entry.usage;
    if (!usage || !Number.isSafeInteger(usage.messages) || usage.messages < 0) throw new Error("Invalid reported usage");
    for (const tokens of [usage.tokens, ...(usage.effortClassification ? [usage.effortClassification.tokens] : [])]) {
      if (!tokens || [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.total].some(count => !Number.isSafeInteger(count) || count < 0)) {
        throw new Error("Reported token counts must be nonnegative integers");
      }
    }
    for (const cost of [usage.estimatedCost, usage.effortClassification?.estimatedCost]) {
      if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) throw new Error("Invalid reported cost estimate");
    }
    if (usage.context && ((usage.context.tokens !== null && (!Number.isFinite(usage.context.tokens) || usage.context.tokens < 0))
      || !Number.isFinite(usage.context.contextWindow) || usage.context.contextWindow <= 0
      || (usage.context.percent !== null && (!Number.isFinite(usage.context.percent) || usage.context.percent < 0)))) {
      throw new Error("Invalid reported context usage");
    }
    if (usage.effortClassification && (!Number.isSafeInteger(usage.effortClassification.requests) || usage.effortClassification.requests < 0)) {
      throw new Error("Invalid reported classifier usage");
    }
  }
  if (entry.repairAttempts !== undefined && (!Number.isSafeInteger(entry.repairAttempts) || entry.repairAttempts < 0)) throw new Error("Invalid repair count");
  if (entry.selfVerification !== undefined && !["pass", "fail", "incomplete", "blocked"].includes(entry.selfVerification)) throw new Error("Invalid self-verification status");
  if (entry.runtimeErrors !== undefined && (!Array.isArray(entry.runtimeErrors) || entry.runtimeErrors.some(error => typeof error !== "string"))) throw new Error("Invalid runtime errors");
  if ((entry.error !== undefined && typeof entry.error !== "string") || (entry.outputTail !== undefined && typeof entry.outputTail !== "string")) throw new Error("Invalid diagnostic text");
}

/** Grade a human-driven run without starting a runtime. Every call saves a new attempt. */
export async function gradePreparedEval(root: string, observation: unknown, timeoutMs = 120_000): Promise<EvalRunResult> {
  requireObservation(observation);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Invalid verification timeout");
  const manifest: PreparedEvalManifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  if (manifest.version !== 1) throw new Error("Unsupported prepared evaluation version");
  const frozen = path.join(root, "evaluator");
  const changes = diffTrees(new Map(manifest.evaluatorDigests), await digestTree(frozen));
  if (changes.added.length || changes.modified.length || changes.removed.length) throw new Error("Frozen evaluator changed; prepare a new baseline");
  const scratch = await mkdtemp(path.join(os.tmpdir(), "casper-eval-grade-"));
  try {
    const evaluator = path.join(scratch, "evaluator");
    const homeDir = path.join(scratch, "home");
    await mkdir(evaluator);
    await mkdir(homeDir);
    await copyTree(frozen, evaluator);
    const result = await gradeCandidate(manifest.task, {
      workdir: path.join(root, "candidate"), evaluator, repoRoot: manifest.repoRoot, homeDir, timeoutMs,
    }, new Map(manifest.before), observation, "host-observation");
    await writeFile(path.join(root, "results", `${result.attemptId}.json`), `${JSON.stringify({ ...result, observation }, null, 2)}\n`, { flag: "wx" });
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
