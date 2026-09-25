import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import { osSupportsProcessGroups, ownSpawnedTree, terminateTree } from "../src/platform/processes";

/** Harness observations are not independent acceptance evidence. */
export type HarnessName = "casper" | "pi";
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
  errors: string[];
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
  /** Read-only sources; only the model's provider entry is copied to the temporary home. */
  seed?: { authPath: string; modelsStorePath?: string };
}

export interface ProcessObservation {
  exitCode: number | null;
  timedOut: boolean;
  wallClockMs: number;
}

/** Run a CLI with a fresh home, bounded output and process-tree cleanup. No user settings are loaded. */
export async function runHarness(name: HarnessName, input: HarnessInput): Promise<HarnessObservation> {
  if (!input.command.length || !input.command[0] || !input.model.includes("/")
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) throw new Error("Invalid harness input");
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-harness-home-"));
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
    const args = name === "casper"
      ? ["--json", "--model", input.model, "--effort", input.effort, "--verify"]
      : ["--print", "--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
        "--model", input.model, "--thinking", input.effort];
    const child = Bun.spawn([...input.command, ...args, "--", input.prompt], {
      cwd: input.cwd, env: isolatedEnvironment(home, name === "casper"
        ? { CASPER_AGENT_DIR: agent, CASPER_OFFLINE: "1" }
        : { PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" }),
      stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: osSupportsProcessGroups,
    });
    const owner = ownSpawnedTree(child.pid, () => child.exitCode === null && child.signalCode === null);
    const stop = () => terminateTree(owner, child.pid, "SIGKILL");
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void stop(); }, input.timeoutMs);
    const events: unknown[] = [];
    const errors: string[] = [];
    let stderr = "";
    let bytes = 0;
    const consume = async (stream: ReadableStream<Uint8Array>, json: boolean) => {
      const decoder = new TextDecoder();
      let pending = "";
      const parse = (line: string) => {
        if (!line.trim()) return;
        try { events.push(JSON.parse(line)); }
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
      const result = observeHarness(name, events, { exitCode, timedOut, wallClockMs: Math.round(performance.now() - started) });
      result.errors.push(...errors);
      // Casper's stderr is its normal human output in --json mode: diagnostic only when the run failed.
      if (result.termination !== "completed" && exitCode !== 0 && stderr) result.errors.push(stderr);
      if (result.errors.length && result.termination !== "timeout") result.termination = "failed";
      return result;
    } finally { clearTimeout(timer); await stop(); }
  } finally { await rm(home, { recursive: true, force: true }); }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Normalize authoritative message events, never count streaming deltas as answers. */
export function observeHarness(name: HarnessName, events: readonly unknown[], process: ProcessObservation): HarnessObservation {
  let answer = "";
  let completed = false;
  let ended = false;
  let responded = false;
  // The exit code a normally finished run must have. Casper's is its verdict (1 when its own checks
  // failed, 2 incomplete), stated in the receipt: the run still finished and its tree is graded.
  let expectedExit = 0;
  const errors: string[] = [];
  let turns = 0;
  let tokens: number | null = 0;
  let estimatedCost: number | null = 0;
  // Casper totals its own responses in the receipt; the same per-response definition as Pi's below.
  let casperUsage: Pick<HarnessObservation, "turns" | "tokens" | "estimatedCost"> = { turns: null, tokens: null, estimatedCost: null };
  for (const value of events) {
    const event = record(value);
    if (!event) { errors.push("Invalid event object"); continue; }
    if (name === "casper" && event.v !== 1) {
      errors.push("Unsupported Casper event version");
      continue;
    }
    if (event.type === "error") errors.push(typeof event.message === "string" ? event.message : "Harness error");
    if (name === "casper" && event.v === 1) {
      if (event.type === "assistant_message" && typeof event.text === "string") { answer = event.text; responded = true; }
      if (event.type === "receipt") {
        completed = event.execution === "completed";
        ended = true;
        expectedExit = Number.isSafeInteger(event.exitCode) ? event.exitCode as number : 0;
        const usage = record(event.usage);
        const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
        const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
        casperUsage = { turns: count(usage?.turns), tokens: count(usage?.tokens), estimatedCost: amount(usage?.estimatedCost) };
      }
    }
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
  return {
    answer, termination: process.timedOut ? "timeout" : completed && ended && responded && errors.length === 0 && process.exitCode === expectedExit ? "completed" : "failed",
    exitCode: process.exitCode, wallClockMs: process.wallClockMs,
    ...(name === "casper" ? casperUsage : { turns, tokens: turns ? tokens : null, estimatedCost: turns ? estimatedCost : null }),
    errors,
  };
}
