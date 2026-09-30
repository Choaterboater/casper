import { copyFile, cp, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";
import { nearestEffort } from "../src/runtime/auto-effort";
import { diffSnapshots, snapshotTree } from "../src/task/changes";
import { independentAcceptance, type AcceptanceCompletion, type AcceptanceResult } from "../src/verify/acceptance";
import { changesCode, isTestPath } from "../src/verify/proof";
import { traceRequirements, withoutAgentMarkers, withoutTree } from "../src/verify/trace";
import { mutationCheck } from "../src/verify/mutation";
import { futility, isInfrastructureRun, RECEIPT_COUNTS_HEADER, receiptCell, receiptCounts, table, type BenchmarkRun, type BenchmarkStop, type ReceiptCell } from "./benchmark";
import { harnessProtocol, routedModels, type HarnessName } from "./harness";
import { prepareWorkdir, type EvalPack } from "./runner";
import { findEvalTask } from "./tasks";

/** The acceptance replay: Casper's independent acceptance check run after the fact on the trees saved benchmark
 * runs left (`--keep-workspaces`), so a change to the check is measured without new coding runs. The grader's
 * verdict and every other part of the receipt are the saved run's; only the acceptance check is new. */

/** A saved results document: its runs and what they ran on. */
export interface ReplaySource {
  file: string;
  model: string;
  /** Pinned OpenRouter hosts; null when unpinned or not OpenRouter. */
  route: readonly string[] | null;
  effort?: string;
  runs: readonly BenchmarkRun[];
}

/** One model and its hosts. */
export interface ReplayModel { model: string; route: readonly string[] | null }

export interface ReplayRun {
  source: string;
  taskId: string;
  pack: EvalPack;
  harness: HarnessName;
  repeat: number;
  /** The grader's verdict on the saved run. */
  success: boolean;
  infra: boolean;
  termination: BenchmarkRun["run"]["termination"];
  receiptOutcome: string | null;
  /** The receipt without the saved run's own acceptance check (`baseOutcome`): what the replayed check judges. */
  baseOutcome: string | null;
  /** The replayed check, or null when it did not run (`skipped` says why). */
  acceptance: (Omit<AcceptanceResult, "usage"> & { model: string; usage: AcceptanceResult["usage"]; durationMs: number }) | null;
  skipped?: string;
  replayOutcome: string | null;
  /** The saved wall time minus its own acceptance phase, plus the replayed check's. */
  estimatedWallClockMs: number;
}

export interface ReplayFailure { source: string; taskId: string; harness: HarnessName; repeat: number; error: string }

export interface ReplayCell {
  pack: EvalPack;
  harness: HarnessName;
  /** Receipt honesty over the replayed outcomes; its cost ratios and rule are null (see `estimatedWallRatio`). */
  receipt: ReceiptCell;
  checked: { pass: number; fail: number; error: number };
  /** Medians over the runs the check ran on; null without one (tokens: without a reported usage). */
  acceptanceMs: number | null;
  acceptanceTokens: number | null;
  /** Median estimated wall time over Pi's median wall in the same documents, pack and tasks; null without Pi. */
  estimatedWallRatio: number | null;
}

/** The receipt as it was before the saved run's own acceptance check: a verdict-mode fail is the only way the check
 * changes an outcome (verified → not_verified). Another cause alongside such a fail cannot be told apart in the
 * receipt and is undone with it. */
export function baseOutcome(run: BenchmarkRun): string | null {
  const downgraded = run.run.receiptOutcome === "not_verified" && run.run.receiptAcceptance?.status === "fail";
  // Since v0.2.17 "verified" needs a proven change: a not_verified receipt without one stays not_verified. Older runs
  // (no recorded proof) keep the old reading.
  if (downgraded && run.run.receiptProof !== undefined) return run.run.receiptProof === "proven" ? "verified" : "not_verified";
  return downgraded ? "verified" : run.run.receiptOutcome;
}

/** A failing check turns a verified receipt into not_verified; it never changes any other outcome. */
export function replayedOutcome(base: string | null, acceptance: Pick<AcceptanceResult, "status"> | null): string | null {
  return base === "verified" && acceptance?.status === "fail" ? "not_verified" : base;
}

/** Why a run gets no replayed check, or undefined when it needs one. Only a verified receipt can change, and only a
 * scored run (not infrastructure, not timed out) counts. */
function notReplayed(run: BenchmarkRun, base: string | null): string | undefined {
  if (isInfrastructureRun(run)) return "infrastructure run";
  if (run.run.termination === "timeout") return "timed out";
  if (base !== "verified") return `receipt ${base ?? "missing"}`;
  return undefined;
}

const acceptancePhaseMs = (run: BenchmarkRun) => run.run.phases?.filter((phase) => phase.phase === "acceptance").reduce((ms, phase) => ms + phase.durationMs, 0) ?? 0;

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The saved run as the receipt table sees it with the replayed outcome. */
const replayedView = (original: BenchmarkRun, replay: ReplayRun): BenchmarkRun => ({ ...original, run: { ...original.run, receiptOutcome: replay.replayOutcome } });

interface Entry { source: ReplaySource; original: BenchmarkRun; replay?: ReplayRun }

/** Entries by pack × harness, in first-seen order. */
function groups<T extends { original: BenchmarkRun }>(entries: readonly T[]): T[][] {
  const byKey = new Map<string, T[]>();
  for (const entry of entries) {
    const key = `${entry.original.pack}\u0000${entry.original.harness}`;
    byKey.set(key, [...byKey.get(key) ?? [], entry]);
  }
  return [...byKey.values()];
}

/** Why every replayed pack × harness is decided with its runs still unreplayed (no `replay`), or empty while one is
 * open. The stopper judges caught and flagged only: a replay has no cost ratio of its own. */
export function replayStopReasons(entries: readonly { original: BenchmarkRun; replay?: ReplayRun }[]): string[] {
  const reasons: string[] = [];
  for (const group of groups(entries)) {
    const done = group.filter((entry) => entry.replay);
    const { pack, harness } = group[0]!.original;
    const cell = receiptCell(harness, done.map((entry) => replayedView(entry.original, entry.replay!)), []);
    const own = futility(cell, group.length - done.length);
    if (!own.length) return [];
    reasons.push(`${pack} ${harness}: ${own.join(", ")}`);
  }
  return reasons;
}

function replayRecord({ original, source }: Entry, base: string | null, acceptance: ReplayRun["acceptance"], skipped?: string): ReplayRun {
  return {
    source: source.file, taskId: original.taskId, pack: original.pack, harness: original.harness, repeat: original.repeat, success: original.graded.success,
    infra: isInfrastructureRun(original), termination: original.run.termination, receiptOutcome: original.run.receiptOutcome, baseOutcome: base,
    acceptance, ...(skipped ? { skipped } : {}), replayOutcome: replayedOutcome(base, acceptance),
    estimatedWallClockMs: original.run.wallClockMs - acceptancePhaseMs(original) + (acceptance?.durationMs ?? 0),
  };
}

export interface ReplayOptions {
  repoRoot: string;
  sources: readonly ReplaySource[];
  /** The model every check uses instead of each run's own. */
  model?: ReplayModel;
  concurrency: number;
  /** Per acceptance test run. */
  timeoutMs: number;
  stopWhenDecided: boolean;
  /** Which check is replayed: the independent acceptance tests (default), requirement-to-test tracing, or mutation. */
  check?: "acceptance" | "trace" | "mutation";
  /** The completion for a model and the saved run's effort. */
  complete(model: string, effort: string | undefined): AcceptanceCompletion;
  onRun?(run: ReplayRun): void;
  onFailure?(failure: ReplayFailure): void;
}

export interface ReplayResult {
  runs: ReplayRun[];
  failures: ReplayFailure[];
  /** Casper-protocol runs without a kept workspace: not replayable, left out entirely. */
  withoutWorkspace: number;
  cells: ReplayCell[];
  stopped?: BenchmarkStop;
}

/** Replay the acceptance check on every kept Casper-protocol workspace. Runs the check cannot change are recorded at
 * once; the rest run `concurrency` at a time. After a stop, checks still running are aborted and dropped. */
export async function replayAcceptance(options: ReplayOptions): Promise<ReplayResult> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new Error("Concurrency must be a positive integer");
  const casper = options.sources.flatMap((source) => source.runs.filter((run) => harnessProtocol(run.harness) === "casper").map((original) => ({ source, original })));
  const entries: Entry[] = casper.filter(({ original }) => original.workspace);
  const jobs: Entry[] = [];
  for (const entry of entries) {
    const base = baseOutcome(entry.original);
    const skipped = notReplayed(entry.original, base);
    if (skipped === undefined) { jobs.push(entry); continue; }
    entry.replay = replayRecord(entry, base, null, skipped);
    options.onRun?.(entry.replay);
  }

  const failures: ReplayFailure[] = [];
  const controller = new AbortController();
  let stopped: BenchmarkStop | undefined;
  const decide = () => {
    if (!options.stopWhenDecided || stopped) return;
    const reasons = replayStopReasons(entries);
    if (!reasons.length) return;
    stopped = { reason: reasons.join("; "), afterRuns: entries.filter((entry) => entry.replay).length };
    controller.abort(new Error("The replay was decided"));
  };
  decide();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, async () => {
    while (next < jobs.length && !stopped) {
      const entry = jobs[next++]!;
      try {
        const replay = await replayRun(options, entry, controller.signal);
        if (stopped) continue;
        entry.replay = replay;
        options.onRun?.(replay);
      } catch (error) {
        if (stopped) continue;
        const { taskId, harness, repeat } = entry.original;
        const failure = { source: entry.source.file, taskId, harness, repeat, error: error instanceof Error ? error.message : String(error) };
        failures.push(failure);
        options.onFailure?.(failure);
        // A run that cannot be replayed is out of the tally, not pending: it must not hold the stopper open.
        entries.splice(entries.indexOf(entry), 1);
      }
      decide();
    }
  }));
  const done = entries.filter((entry) => entry.replay);
  return {
    runs: done.map((entry) => entry.replay!), failures, withoutWorkspace: casper.length - casper.filter(({ original }) => original.workspace).length,
    cells: replayCells(done, options.sources), ...(stopped ? { stopped } : {}),
  };
}

/** A saved document's paths under the home or temp directory read `<home>/…` and `<tmp>/…` (writeEvalReport). */
export function restoredPath(recorded: string): string {
  if (recorded === "<home>" || recorded.startsWith("<home>/")) return path.join(os.homedir(), recorded.slice("<home>".length));
  if (recorded === "<tmp>" || recorded.startsWith("<tmp>/")) return path.join(os.tmpdir(), recorded.slice("<tmp>".length));
  return recorded;
}

async function replayRun(options: ReplayOptions, entry: Entry, signal: AbortSignal): Promise<ReplayRun> {
  const { original, source } = entry;
  const base = baseOutcome(original);
  const task = findEvalTask(original.taskId);
  if (!task) throw new Error(`Unknown task ${original.taskId}`);
  const workspace = restoredPath(original.workspace!);
  if (!await lstat(workspace).then((stats) => stats.isDirectory(), () => false)) throw new Error(`Workspace ${workspace} is gone`);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "casper-replay-"));
  try {
    const start = await prepareWorkdir(task, options.repoRoot, path.join(scratch, "start"));
    const root = path.join(scratch, "workspace");
    await cp(workspace, root, { recursive: true, verbatimSymlinks: true });
    // The kept copy has no node_modules: the start's own (the linked tools) are what the run had.
    if (await lstat(path.join(start, "node_modules")).then(() => true, () => false)) {
      await cp(path.join(start, "node_modules"), path.join(root, "node_modules"), { recursive: true, verbatimSymlinks: true });
    }
    const files = await snapshotTree(root, signal);
    const changes = diffSnapshots(await snapshotTree(start, signal), files);
    const config: unknown = parse(await readFile(path.join(root, ".casper/project.yaml"), "utf8").catch(() => "{}"));
    const verify = config && typeof config === "object" ? (config as { verify?: unknown }).verify : undefined;
    const test = verify && typeof verify === "object" ? (verify as { test?: unknown }).test : undefined;
    const testCommand = typeof test === "string" ? test.trim() : "";
    if (!testCommand) return replayRecord(entry, base, null, "no test command");
    if (!changesCode(changes)) return replayRecord(entry, base, null, "no code change");
    const model = options.model?.model ?? source.model;
    const started = performance.now();
    const complete = options.complete(model, source.effort);
    let result: AcceptanceResult;
    if (options.check === "trace") {
      const tests = [...changes.added, ...changes.modified].filter(isTestPath);
      const without = await withoutTree(start, root, tests);
      try {
        result = await traceRequirements({ complete, request: task.prompt, root, without: without.tree, testCommand, timeoutMs: options.timeoutMs, signal });
      } finally { await without.dispose(); }
    } else if (options.check === "mutation") {
      // `root` is this replay's own copy, so the check may mutate it in place.
      result = await mutationCheck({ root, changes, testCommand, timeoutMs: options.timeoutMs, signal, env: withoutAgentMarkers(process.env) });
    } else {
      result = await independentAcceptance({ complete, request: task.prompt, root, changes, files, testCommand, timeoutMs: options.timeoutMs, signal });
    }
    signal.throwIfAborted();
    return replayRecord(entry, base, { ...result, model, durationMs: Math.round(performance.now() - started) });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function replayCells(done: readonly Entry[], sources: readonly ReplaySource[]): ReplayCell[] {
  const pi = sources.flatMap((source) => source.runs).filter((run) => run.harness === "pi" && !isInfrastructureRun(run));
  return groups(done).map((group) => {
    const { pack, harness } = group[0]!.original;
    const replays = group.map((entry) => entry.replay!);
    const checks = replays.flatMap((replay) => replay.acceptance ? [replay.acceptance] : []);
    const count = (status: AcceptanceResult["status"]) => checks.filter((check) => check.status === status).length;
    const piRuns = pi.filter((run) => run.pack === pack && replays.some((replay) => replay.taskId === run.taskId));
    const ownWall = median(replays.filter((replay) => !replay.infra && piRuns.some((run) => run.taskId === replay.taskId)).map((replay) => replay.estimatedWallClockMs));
    const piWall = median(piRuns.map((run) => run.run.wallClockMs));
    return {
      pack, harness, receipt: receiptCell(harness, group.map((entry) => replayedView(entry.original, entry.replay!)), []),
      checked: { pass: count("pass"), fail: count("fail"), error: count("error") },
      acceptanceMs: median(checks.map((check) => check.durationMs)),
      acceptanceTokens: median(checks.flatMap((check) => check.usage ? [check.usage.tokens] : [])),
      estimatedWallRatio: ownWall !== null && piWall ? ownWall / piWall : null,
    };
  });
}

const REPLAY_HEADER = [...RECEIPT_COUNTS_HEADER, "checked (pass/fail/error)", "check s", "check tokens", "est. wall×Pi"];

export function formatReplayReport(result: Pick<ReplayResult, "cells" | "withoutWorkspace">): string {
  const packs = [...new Set(result.cells.map((cell) => cell.pack))];
  return [
    "Acceptance replay: the saved runs' receipts with Casper's independent acceptance check run again on the trees they left; the grader's"
      + " verdict is the saved one. caught, flagged and false-verified as in the benchmark's receipt honesty. checked = runs the check ran on"
      + " (only a verified receipt can change); check s and tokens are its medians. est. wall×Pi = median(saved wall − its own acceptance phase"
      + " + the replayed check's time) over Pi's median wall in the same documents: an estimate, not a measured run.",
    ...(result.withoutWorkspace ? [`${result.withoutWorkspace} Casper run(s) without a kept workspace were left out.`] : []),
    ...packs.map((pack) => {
      const rows = result.cells.filter((cell) => cell.pack === pack).map((cell) => [...receiptCounts(cell.receipt),
        `${cell.checked.pass + cell.checked.fail + cell.checked.error} (${cell.checked.pass}/${cell.checked.fail}/${cell.checked.error})`,
        cell.acceptanceMs === null ? "–" : (cell.acceptanceMs / 1000).toFixed(0),
        cell.acceptanceTokens === null ? "–" : cell.acceptanceTokens >= 1000 ? `${Math.round(cell.acceptanceTokens / 1000)}k` : String(Math.round(cell.acceptanceTokens)),
        cell.estimatedWallRatio === null ? "–" : `est. ${cell.estimatedWallRatio.toFixed(2)}`]);
      return `${pack} pack, receipt honesty with the replayed acceptance check\n${table([REPLAY_HEADER, ...rows])}`;
    }),
  ].join("\n\n");
}

/** Acceptance completions on Casper's own credentials (`<agentDir>/auth.json`), model configuration (`models.json`)
 * and catalog cache (both copied, so the user's are never rewritten), each OpenRouter model pinned to its hosts with no
 * fallbacks. Fails before any run on an unknown model or a provider without credentials. */
export async function acceptanceCompletions(models: readonly ReplayModel[], agentDir: string): Promise<{
  complete(model: string, effort: string | undefined): AcceptanceCompletion;
  close(): Promise<void>;
}> {
  const routes = new Map<string, readonly string[]>();
  for (const { model, route } of models) {
    if (!route?.length) continue;
    const known = routes.get(model);
    if (known && known.join(",") !== route.join(",")) throw new Error(`${model} ran on different hosts (${known.join(",")} and ${route.join(",")}); pass --model and --route`);
    routes.set(model, route);
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), "casper-replay-models-"));
  try {
    type Overrides = { providers?: Record<string, { modelOverrides?: Record<string, { compat?: Record<string, unknown> }> }> };
    const own = JSON.parse(await readFile(path.join(agentDir, "models.json"), "utf8").catch(() => "{}")) as Overrides;
    const routed = routedModels([...routes].map(([model, hosts]) => ({ model, hosts }))) as Required<Overrides>;
    const openRouter = (own.providers ??= {}).openrouter ??= {};
    const overrides = openRouter.modelOverrides ??= {};
    for (const [id, { compat }] of Object.entries(routed.providers.openrouter!.modelOverrides!)) overrides[id] = { ...overrides[id], compat: { ...overrides[id]?.compat, ...compat } };
    const modelsPath = path.join(scratch, "models.json");
    await writeFile(modelsPath, JSON.stringify(own), { mode: 0o600 });
    const store = path.join(agentDir, "models-store.json");
    const modelsStorePath = path.join(scratch, "models-store.json");
    if (await lstat(store).then(() => true, () => false)) await copyFile(store, modelsStorePath);
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath, modelsStorePath });
    const resolved = new Map(models.map(({ model }) => {
      const provider = model.slice(0, model.indexOf("/"));
      const found = runtime.getModel(provider, model.slice(model.indexOf("/") + 1));
      if (!found) throw new Error(`Unknown model ${model}`);
      if (!runtime.hasConfiguredAuth(provider)) throw new Error(`No ${provider} sign-in in ${path.join(agentDir, "auth.json")} (casper /login ${provider})`);
      return [model, found] as const;
    }));
    return {
      complete: (reference, runEffort) => async (input) => {
        const model = resolved.get(reference)!;
        // The check's own effort and output cap when it asks for them; else the saved run's effort.
        const { effort = runEffort, maxTokens } = input;
        const level = effort && effort !== "off" ? nearestEffort(effort, getSupportedThinkingLevels(model)) : undefined;
        const response = await runtime.completeSimple(model, {
          systemPrompt: input.systemPrompt, messages: [{ role: "user", content: input.user, timestamp: Date.now() }],
        }, { signal: input.signal, toolChoice: "none", ...(level && level !== "off" ? { reasoning: level } : {}), ...(maxTokens ? { maxTokens } : {}) });
        const usage = response.usage;
        const cost = usage?.cost?.total;
        const reported = usage && Number.isFinite(usage.totalTokens) ? { tokens: usage.totalTokens, estimatedCost: Number.isFinite(cost) && cost! >= 0 ? cost! : 0 } : null;
        if (response.stopReason === "error" || response.stopReason === "aborted") return { text: "", error: response.errorMessage ?? response.stopReason, usage: reported };
        return { text: response.content.filter((part) => part.type === "text").map((part) => part.text).join(""), usage: reported };
      },
      close: () => rm(scratch, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}
