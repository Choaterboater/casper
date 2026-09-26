import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import { osSupportsProcessGroups, ownSpawnedTree, terminateTree } from "../src/platform/processes";

/** Harness observations are not independent acceptance evidence. */
/** `casper-no-review` is Casper with its requirements review round off (`verification.review: false`
 * in the run's user configuration): the same CLI and protocol, for measuring what the round adds. */
export type HarnessName = "casper" | "casper-no-review" | "pi";
export const HARNESS_NAMES: readonly HarnessName[] = ["casper", "casper-no-review", "pi"];
/** The wire protocol and CLI a harness speaks. */
export const harnessProtocol = (name: HarnessName): "casper" | "pi" => name === "pi" ? "pi" : "casper";
export interface HarnessObservation {
  answer: string;
  /** `completed`: the CLI finished its run normally, whatever it concluded about the work (Casper's
   * own failed checks exit 1 but still complete). Only the frozen evaluator judges the tree. */
  termination: "completed" | "failed" | "timeout";
  exitCode: number | null;
  wallClockMs: number;
  /** Unknown when the CLI does not expose every model response. */
  turns: number | null;
  tokens: number | null;
  estimatedCost: number | null;
  /** Casper's own verdict from its receipt (`verified`, `failed`, ...); null for Pi. A self-report,
   * never acceptance evidence: kept to compare Casper's receipts with the grader. */
  receiptOutcome: string | null;
  /** The conversation the CLI reported running in (Casper's session_start, Pi's session header);
   * null when it reported none. A follow-up resumed only if this matches the first attempt's. */
  sessionId: string | null;
  errors: string[];
  /** The CLI's stderr tail, when a failed run's is kept as its last `errors` entry: diagnostic
   * human output (Casper's echoes the prompt), never a provider error. Absent in documents saved
   * before it was recorded. */
  stderr?: string;
  /** Casper's phases (its task turn, checks, review, proof), timed on the harness clock as their
   * events arrived; one still running when the run ended is `unfinished`, timed to the end. Absent
   * for Pi, which reports none. */
  phases?: readonly HarnessPhase[];
  /** Time in tools per tool name: Casper's own tool timings, Pi's timed on the harness clock. Calls
   * still running when the run ended (a hung test run, say) count to the end and are `unfinished`. */
  tools?: readonly HarnessToolTime[];
}
export interface HarnessInput {
  /** Executable plus fixed arguments; never interpreted by a shell. */
  command: readonly string[];
  cwd: string;
  prompt: string;
  model: string;
  effort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** The only run limit, identical for both harnesses. There is deliberately no turn limit: Pi's CLI
   * has none, so a Casper-only limit would stop only Casper. */
  timeoutMs: number;
  /** OpenRouter host names, in preference order, both harnesses' model is pinned to (no fallbacks).
   * OpenRouter keeps a conversation on one host and hosts differ tenfold in speed, so an unpinned
   * comparison measures which host each harness drew as much as the harness itself. */
  route?: readonly string[];
  /** Read-only sources; only the model's provider entry is copied to the temporary home. */
  seed?: { authPath: string; modelsStorePath?: string };
  /** A saved conversation in a caller-owned home, kept across runs so a follow-up can continue it.
   * Without one, the home is temporary and the conversation is not saved (Pi: `--no-session`). */
  session?: {
    home: string;
    /** Pi's conversation id (`--session-id`, created on the first run and resumed after). Casper
     * cannot be given an id: it resumes its latest conversation in the home (`--continue`). */
    id: string;
    resume: boolean;
  };
}

export type PhaseName = "task" | "checks" | "review" | "proof" | "repair";
export interface HarnessPhase { phase: PhaseName; durationMs: number; unfinished?: true }
export interface HarnessToolTime { tool: string; calls: number; ms: number; unfinished?: number }

export interface ProcessObservation {
  exitCode: number | null;
  timedOut: boolean;
  wallClockMs: number;
  /** When each event arrived, in ms since the run started, by event index. */
  eventTimes?: readonly number[];
}

/** Run a CLI with a fresh home, bounded output and process-tree cleanup. No user settings are loaded. */
export async function runHarness(harness: HarnessName, input: HarnessInput): Promise<HarnessObservation> {
  const name = harnessProtocol(harness);
  if (!input.command.length || !input.command[0] || !input.model.includes("/")
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) throw new Error("Invalid harness input");
  if (input.route?.length && !input.model.startsWith("openrouter/")) throw new Error("--route applies only to openrouter models");
  const ownsHome = !input.session;
  const home = input.session?.home ?? await mkdtemp(path.join(os.tmpdir(), "casper-harness-home-"));
  const agent = path.join(home, name === "casper" ? ".casper/agent" : ".pi/agent");
  const started = performance.now();
  try {
    await mkdir(agent, { recursive: true, mode: 0o700 });
    if (input.seed) {
      const provider = input.model.slice(0, input.model.indexOf("/"));
      const auth = record(JSON.parse(await readFile(input.seed.authPath, "utf8")));
      if (!auth || !Object.hasOwn(auth, provider)) throw new Error(`Missing credentials for ${provider}`);
      await writeFile(path.join(agent, "auth.json"), JSON.stringify({ [provider]: auth[provider] }), { mode: 0o600 });
      if (input.seed.modelsStorePath) await copyFile(input.seed.modelsStorePath, path.join(agent, "models-store.json"));
    }
    if (input.route?.length) await writeFile(path.join(agent, "models.json"), JSON.stringify(routedModels(input.model, input.route)), { mode: 0o600 });
    if (harness === "casper-no-review") await writeFile(path.join(home, ".casper/config.yaml"), "verification:\n  review: false\n", { mode: 0o600 });
    const args = name === "casper"
      ? ["--json", "--model", input.model, "--effort", input.effort, "--verify", ...(input.session?.resume ? ["--continue"] : [])]
      // Pi refuses --session-id with --continue; the id alone resumes the conversation once it exists.
      : ["--print", "--mode", "json", ...(input.session ? ["--session-id", input.session.id] : ["--no-session"]), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
        "--model", input.model, "--thinking", input.effort];
    // Pi runs with PI_TELEMETRY=0 and sends no OpenRouter attribution; CASPER_TELEMETRY=0 gives
    // Casper's requests the same headers, so the host sees no difference but the prompt.
    const child = Bun.spawn([...input.command, ...args, "--", input.prompt], {
      cwd: input.cwd, env: isolatedEnvironment(home, name === "casper"
        ? { CASPER_AGENT_DIR: agent, CASPER_OFFLINE: "1", CASPER_TELEMETRY: "0" }
        : { PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" }),
      stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: osSupportsProcessGroups,
    });
    const owner = ownSpawnedTree(child.pid, () => child.exitCode === null && child.signalCode === null);
    const stop = () => terminateTree(owner, child.pid, "SIGKILL");
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void stop(); }, input.timeoutMs);
    const events: unknown[] = [];
    const eventTimes: number[] = [];
    const errors: string[] = [];
    let stderr = "";
    let bytes = 0;
    const consume = async (stream: ReadableStream<Uint8Array>, json: boolean) => {
      const decoder = new TextDecoder();
      let pending = "";
      const parse = (line: string) => {
        if (!line.trim()) return;
        try { events.push(JSON.parse(line)); eventTimes.push(Math.round(performance.now() - started)); }
        catch { if (!errors.includes("Malformed JSON event")) errors.push("Malformed JSON event"); }
      };
      for await (const chunk of stream) {
        bytes += chunk.byteLength;
        if (bytes > 16 * 1024 * 1024) {
          if (!errors.includes("Harness output limit exceeded")) errors.push("Harness output limit exceeded");
          await stop();
          continue;
        }
        const text = decoder.decode(chunk, { stream: true });
        if (!json) { stderr = (stderr + text).slice(-4096); continue; }
        pending += text;
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          parse(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
      }
      if (json) parse(pending + decoder.decode());
    };
    try {
      const exited = child.exited.then(async code => { await stop(); return code; });
      const [exitCode] = await Promise.all([exited, consume(child.stdout, true), consume(child.stderr, false)]);
      const result = observeHarness(name, events, { exitCode, timedOut, wallClockMs: Math.round(performance.now() - started), eventTimes });
      result.errors.push(...errors);
      // Casper's stderr is its normal human output in --json mode: diagnostic only when the run failed.
      if (result.termination !== "completed" && exitCode !== 0 && stderr) { result.errors.push(stderr); result.stderr = stderr; }
      // Unparseable or oversized output is a broken protocol, whatever the last event said.
      if (errors.length && result.termination !== "timeout") result.termination = "failed";
      return result;
    } finally { clearTimeout(timer); await stop(); }
  } finally { if (ownsHome) await rm(home, { recursive: true, force: true }); }
}

/** The same models.json for both CLIs: the model's OpenRouter hosts, and nothing else. */
export function routedModels(model: string, hosts: readonly string[]): unknown {
  const id = model.slice(model.indexOf("/") + 1);
  return { providers: { openrouter: { modelOverrides: { [id]: {
    compat: { openRouterRouting: { only: [...hosts], order: [...hosts], allow_fallbacks: false } } } } } } };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Normalize authoritative message events, never count streaming deltas as answers. */
export function observeHarness(harness: HarnessName, events: readonly unknown[], process: ProcessObservation): HarnessObservation {
  const name = harnessProtocol(harness);
  let answer = "";
  let completed = false;
  let ended = false;
  let responded = false;
  // The exit code a normally finished run must have. Casper's is its verdict (1 when its own checks
  // failed, 2 incomplete), stated in the receipt: the run still finished and its tree is graded.
  let expectedExit = 0;
  let receiptOutcome: string | null = null;
  let sessionId: string | null = null;
  const errors: string[] = [];
  // Protocol faults fail the run. Provider errors are diagnostics: both CLIs retry them, and only
  // the final state (Casper's receipt, Pi's last response) says whether the run finished.
  let broken = false;
  let turns = 0;
  let tokens: number | null = 0;
  let estimatedCost: number | null = 0;
  // Casper totals its own responses in the receipt; the same per-response definition as Pi's below.
  let casperUsage: Pick<HarnessObservation, "turns" | "tokens" | "estimatedCost"> = { turns: null, tokens: null, estimatedCost: null };
  const phaseStarts = new Map<PhaseName, number>();
  const phases: HarnessPhase[] = [];
  const tools = new Map<string, HarnessToolTime>();
  const running = new Map<string, { tool: string; at: number }>();
  const addTool = (tool: string, ms: number, unfinished = false) => {
    const entry = tools.get(tool) ?? { tool, calls: 0, ms: 0 };
    entry.calls++;
    entry.ms += Math.max(0, Math.round(ms));
    if (unfinished) entry.unfinished = (entry.unfinished ?? 0) + 1;
    tools.set(tool, entry);
  };
  for (const [index, value] of events.entries()) {
    const at = process.eventTimes?.[index];
    const event = record(value);
    if (!event) { errors.push("Invalid event object"); broken = true; continue; }
    if (name === "casper" && event.v !== 1) {
      errors.push("Unsupported Casper event version");
      broken = true;
      continue;
    }
    if (event.type === "error") errors.push(typeof event.message === "string" ? event.message : "Harness error");
    if (name === "casper" && event.type === "phase" && (["task", "checks", "review", "proof", "repair"] as unknown[]).includes(event.phase)
      && (event.state === "start" || event.state === "end")) {
      const phase = event.phase as PhaseName;
      // The harness clock when there is one: it also times a phase the run never finished.
      const time = at ?? (typeof event.atMs === "number" ? event.atMs : undefined);
      if (time !== undefined && event.state === "start") phaseStarts.set(phase, time);
      const start = phaseStarts.get(phase);
      if (time !== undefined && event.state === "end" && start !== undefined) {
        phases.push({ phase, durationMs: Math.round(Math.max(0, time - start)) });
        phaseStarts.delete(phase);
      }
    }
    const toolName = typeof event.tool === "string" ? event.tool : typeof event.toolName === "string" ? event.toolName : undefined;
    const callId = typeof event.id === "string" ? event.id : typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (toolName && ((name === "casper" && event.type === "tool_start") || (name === "pi" && event.type === "tool_execution_start"))) {
      if (callId && at !== undefined) running.set(callId, { tool: toolName.slice(0, 64), at });
    }
    if (toolName && name === "casper" && event.type === "tool_end") {
      const started = callId ? running.get(callId) : undefined;
      if (callId) running.delete(callId);
      const ms = typeof event.ms === "number" && Number.isFinite(event.ms) ? event.ms : started && at !== undefined ? at - started.at : 0;
      addTool(toolName.slice(0, 64), ms);
    }
    if (toolName && name === "pi" && event.type === "tool_execution_end") {
      const started = callId ? running.get(callId) : undefined;
      if (callId) running.delete(callId);
      addTool(toolName.slice(0, 64), started && at !== undefined ? at - started.at : 0);
    }
    if (name === "casper" && event.v === 1) {
      if (event.type === "session_start" && typeof event.session === "string") sessionId = event.session.slice(0, 128);
      if (event.type === "assistant_message" && typeof event.text === "string") { answer = event.text; responded = true; }
      if (event.type === "receipt") {
        completed = event.execution === "completed";
        ended = true;
        expectedExit = Number.isSafeInteger(event.exitCode) ? event.exitCode as number : 0;
        receiptOutcome = typeof event.outcome === "string" ? event.outcome.slice(0, 64) : null;
        const usage = record(event.usage);
        const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
        const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
        casperUsage = { turns: count(usage?.turns), tokens: count(usage?.tokens), estimatedCost: amount(usage?.estimatedCost) };
      }
    }
    if (name === "pi" && event.type === "session" && typeof event.id === "string") sessionId = event.id.slice(0, 128);
    if (name === "pi" && event.type === "agent_end") ended = true;
    if (name === "pi" && event.type === "message_end") {
      const message = record(event.message);
      if (message?.role !== "assistant") continue;
      turns++;
      responded = true;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        errors.push(typeof message.errorMessage === "string" ? message.errorMessage : `Assistant ${message.stopReason}`);
      }
      answer = Array.isArray(message.content) ? message.content.flatMap(value => {
        const block = record(value);
        return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
      }).join("") : "";
      completed = message.stopReason === "stop";
      const usage = record(message.usage);
      const total = usage?.totalTokens;
      const cost = record(usage?.cost)?.total;
      tokens = tokens !== null && typeof total === "number" && Number.isFinite(total) && total >= 0 ? tokens + total : null;
      estimatedCost = estimatedCost !== null && typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? estimatedCost + cost : null;
    }
  }
  // Whatever was still running when the run ended ran until then.
  for (const [phase, start] of phaseStarts) phases.push({ phase, durationMs: Math.round(Math.max(0, process.wallClockMs - start)), unfinished: true });
  for (const { tool, at } of running.values()) addTool(tool, process.wallClockMs - at, true);
  return {
    answer, termination: process.timedOut ? "timeout" : completed && ended && responded && !broken && process.exitCode === expectedExit ? "completed" : "failed",
    exitCode: process.exitCode, wallClockMs: process.wallClockMs,
    ...(name === "casper" ? casperUsage : { turns, tokens: turns ? tokens : null, estimatedCost: turns ? estimatedCost : null }),
    receiptOutcome, sessionId, errors, ...(phases.length ? { phases } : {}), ...(tools.size ? { tools: [...tools.values()] } : {}),
  };
}
