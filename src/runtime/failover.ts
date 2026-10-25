/**
 * Failover: when the model a task runs on hits a limit, the task goes on with the next model, instead of stopping.
 *
 * - What switches: a rate limit (after the engine's own tries on the same model), a usage limit or a model that can't
 *   run now (at once). A rejected key, a refusal, a full window or a bad request never does: another model wouldn't fix
 *   them, and a key problem needs /login.
 * - To what: the models you listed with /model failover, in your order. Only after a free OpenRouter model does Casper
 *   add others by itself: the newest free OpenRouter models that call tools, have room to work and aren't being retired.
 *   It never picks a paid model you didn't list, and never moves a conversation from another model to a free one, which
 *   may keep what you send (docs/adr/0002/38-failover.md).
 * - How: the failed request goes again on the new model; when the conversation doesn't fit its window, it is compacted
 *   to fit first, by that model. The engine compacts once, keeping the newest part and summarizing the rest in one
 *   request to that model, so a model whose window can't take the rest is passed over. One line says what switched and
 *   why. The next task goes back to your model.
 *
 * The engine decides about retries in methods it keeps to itself (`_isRetryableError`, `_willRetryAfterAgentEnd`,
 * `_prepareRetry`); failover wraps them as Casper already wraps the first (src/runtime/model-errors.ts). When the engine
 * doesn't have them, failover stays off and nothing changes.
 */
import { estimateTokens, shouldCompact, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { explainModelError } from "./model-errors";
import { modelFacts, providerFacts, type ModelFacts } from "./model-facts";

export type FailoverCause = "rate" | "quota" | "unavailable";

/** The smallest window a model Casper picks by itself may have: a smaller one takes little of a conversation, even
 * compacted (about 25k tokens in a 32k window, src/runtime/small-window.ts). */
export const FAILOVER_MIN_WINDOW = 65_536;
/** Room in a summary request for its instructions and the conversation's labels, on top of what it summarizes. */
const SUMMARY_PROMPT_TOKENS = 2_000;
/** A model whose provider retires it within this long isn't picked by itself. */
const ENDING_SOON_MS = 7 * 24 * 60 * 60_000;
const REASON: Record<FailoverCause, string> = { rate: "hit its rate limit", quota: "hit its usage limit", unavailable: "can't run right now" };

/** Why this error lets the task switch models, or none. Read from the words every provider uses (model-errors.ts). */
export function failoverCause(errorMessage: string): FailoverCause | undefined {
  const cause = explainModelError(errorMessage)?.cause;
  if (cause === "credits") return "quota";
  // A daily or quota limit says 429 too, but waiting a minute doesn't lift it.
  if (cause === "rate") return /per[- ]?day|daily|quota/i.test(errorMessage) ? "quota" : "rate";
  if (cause === "model") return "unavailable";
  if (cause) return undefined;
  return /\b50[234]\b|bad gateway|service unavailable|gateway time-?out|upstream error/i.test(errorMessage) ? "unavailable" : undefined;
}

type Reference = { provider: string; id: string };
const key = (model: Reference) => `${model.provider}/${model.id}`;

export interface FailoverTargetOptions {
  /** The model that failed. */
  current: Reference;
  /** Your list, as provider/id, in your order. */
  listed: readonly string[];
  /** Models already used in this task (provider/id): not tried again. */
  tried: ReadonlySet<string>;
  /** The model when Casper can use it now: in the catalog, signed in, able to call tools. */
  usable(provider: string, id: string): Model<Api> | undefined;
  facts(provider: string, id: string): ModelFacts | undefined;
  /** What OpenRouter's list says about each of its models, by id. */
  openRouter: ReadonlyMap<string, ModelFacts>;
  now?: number;
}

/** The models to switch to, in order: yours, then, only after a free OpenRouter model, the newest free OpenRouter models
 * that can do the work. Never a paid model you didn't list. */
export function failoverTargets(options: FailoverTargetOptions): Array<Model<Api>> {
  const seen = new Set([...options.tried, key(options.current)]);
  const targets: Array<Model<Api>> = [];
  const add = (provider: string, id: string) => {
    if (seen.has(`${provider}/${id}`)) return;
    const model = options.usable(provider, id);
    if (!model) return;
    seen.add(`${provider}/${id}`);
    targets.push(model);
  };
  for (const listed of options.listed) {
    const slash = listed.indexOf("/");
    if (slash > 0) add(listed.slice(0, slash), listed.slice(slash + 1));
  }
  if (options.current.provider !== "openrouter" || options.facts(options.current.provider, options.current.id)?.free !== true) return targets;
  const now = options.now ?? Date.now();
  const free = [...options.openRouter].filter(([, facts]) => facts.free && facts.tools && (facts.contextWindow ?? 0) >= FAILOVER_MIN_WINDOW
    && (facts.expires === undefined || facts.expires - now > ENDING_SOON_MS));
  free.sort(([, a], [, b]) => (b.created ?? 0) - (a.created ?? 0));
  for (const [id] of free) add("openrouter", id);
  return targets;
}

export interface FailoverHooks {
  /** Your list (/model failover), as provider/id. */
  listed(): readonly string[];
  usable(provider: string, id: string): Model<Api> | undefined;
  /** The task goes on with this model; the model you chose stays your choice. */
  switchTo(model: Model<Api>): Promise<void>;
  notice(message: string): void;
  /** The task was told a switch would follow and none did: the error stands, as if there had been no list. */
  failed(errorMessage: string): void;
  /** You stopped the task: no switch. */
  aborted(): boolean;
}

type Failed = { role?: string; stopReason?: string; errorMessage?: string };
type Projection = { messages: Array<Parameters<typeof estimateTokens>[0]> };
/** The engine's own parts failover works through. */
interface Engine {
  model?: Model<Api>;
  sessionManager: { buildSessionProjection(): Projection; getBranch(): Array<{ type: string; id: string }> };
  settingsManager: { getCompactionSettings(model?: Model<Api>): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } };
  _retryAttempt: number;
  _isRetryableError(message: Failed): boolean;
  _willRetryAfterAgentEnd(event: { messages: Failed[] }): boolean;
  _prepareRetry(message: Failed): Promise<boolean>;
  _omitRecoveryAttempt(message: Failed): void;
  _exceedsCompactionThreshold(model: Model<Api>, projection: Projection): boolean;
  _runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<boolean>;
}
export const ENGINE_PARTS = ["_isRetryableError", "_willRetryAfterAgentEnd", "_prepareRetry", "_omitRecoveryAttempt", "_exceedsCompactionThreshold", "_runAutoCompaction"] as const;

/** One conversation's failover: what this task tried, and whether it switched. */
export class Failover {
  private readonly engine: Engine;
  private tried = new Set<string>();
  /** The model the task started on, once the task switched away from it. */
  private startedOn?: string;
  /** "No model to switch to" is said once a session. */
  private told = false;

  constructor(session: AgentSession, private readonly hooks: FailoverHooks) {
    this.engine = session as unknown as Engine;
  }

  /** Wraps the engine's retry decisions. False, and nothing wrapped, when the engine lacks one of them. */
  install(): boolean {
    const engine = this.engine;
    if (ENGINE_PARTS.some((part) => typeof engine[part] !== "function") || typeof engine._retryAttempt !== "number") return false;
    const retryable = engine._isRetryableError.bind(engine);
    const willRetry = engine._willRetryAfterAgentEnd.bind(engine);
    const prepare = engine._prepareRetry.bind(engine);
    engine._isRetryableError = (message) => retryable(message) || this.plan(message) !== undefined;
    engine._willRetryAfterAgentEnd = (event) => {
      if (willRetry(event)) return true;
      const last = [...event.messages].reverse().find((message) => message.role === "assistant");
      if (!last || this.hooks.aborted()) return false;
      if (this.plan(last)) return true;
      // The task stops here: say once how to have it switch next time.
      this.tellNoTarget(last);
      return false;
    };
    engine._prepareRetry = async (message) => {
      if (!this.plan(message)) return prepare(message);
      // A passing limit gets the engine's own tries on the same model first; a usage limit or a model that can't run
      // doesn't pass by waiting.
      if (failoverCause(message.errorMessage ?? "") !== "quota" && retryable(message)) {
        if (await prepare(message)) return true;
        if (this.hooks.aborted()) return false;
      }
      if (await this.failover(message)) return true;
      if (!this.hooks.aborted()) this.hooks.failed(message.errorMessage ?? "");
      return false;
    };
    return true;
  }

  /** A new task: nothing tried yet. */
  startTask(): void { this.tried.clear(); this.startedOn = undefined; }
  /** The task ended: true when it switched models, so the caller goes back to yours for the next one. */
  endTask(): boolean {
    const switched = this.startedOn !== undefined;
    this.startTask();
    return switched;
  }

  /** The models this failure can switch to, and whether there were others the conversation is too long for. */
  private targets(message: Failed): { cause: FailoverCause; targets: Array<Model<Api>>; tooLong: boolean } | undefined {
    if (message.stopReason !== "error") return undefined;
    const cause = failoverCause(message.errorMessage ?? "");
    const current = this.engine.model;
    if (!cause || !current) return undefined;
    let listed: readonly string[] = [];
    try { listed = this.hooks.listed(); } catch { /* a settings file Casper can't read lists nothing */ }
    const all = failoverTargets({ current, listed, tried: this.tried, usable: this.hooks.usable, facts: modelFacts, openRouter: providerFacts("openrouter") });
    const targets = all.filter(this.fits());
    return { cause, targets, tooLong: targets.length < all.length };
  }

  /** Whether the conversation can go to a model: it fits its window, or will once compacted. The engine compacts by
   * keeping the newest part and summarizing the rest in one request to that model, so the rest, the summary
   * instructions and the summary itself have to fit its window. */
  private fits(): (model: Model<Api>) => boolean {
    const engine = this.engine;
    // Counted as the engine counts once the failed answer is set aside: by characters, since the provider's own count
    // no longer covers what it sends.
    const size = engine.sessionManager.buildSessionProjection().messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    return (model) => {
      const settings = engine.settingsManager.getCompactionSettings(model);
      if (model.contextWindow <= 0 || !shouldCompact(size, model.contextWindow, settings)) return true;
      const summary = Math.min(Math.floor(0.8 * settings.reserveTokens), model.maxTokens > 0 ? model.maxTokens : Infinity);
      return size - settings.keepRecentTokens + SUMMARY_PROMPT_TOKENS + summary <= model.contextWindow;
    };
  }

  private plan(message: Failed): { cause: FailoverCause; target: Model<Api> } | undefined {
    const found = this.targets(message);
    return found?.targets[0] && { cause: found.cause, target: found.targets[0] };
  }

  private tellNoTarget(message: Failed): void {
    const found = this.targets(message);
    const current = this.engine.model;
    if (!found || found.targets.length || !current) return;
    if (found.tooLong) {
      this.hooks.notice(`${key(current)} ${REASON[found.cause]}, and this conversation is too long for the models to switch to, even compacted. /compact shortens it once ${key(current)} is back.`);
      return;
    }
    if (this.told) return;
    this.told = true;
    this.hooks.notice(`${key(current)} ${REASON[found.cause]}, and there's no model to switch to. To switch when that happens, list models: /model failover <provider/id> …`);
  }

  /** The failed request goes again on the next model that can take it. */
  private async failover(message: Failed): Promise<boolean> {
    const engine = this.engine;
    const from = engine.model!;
    this.tried.add(key(from));
    for (let tries = 0; tries < 5; tries++) {
      const plan = this.plan(message);
      if (!plan) return false;
      this.tried.add(key(plan.target));
      try { await this.hooks.switchTo(plan.target); } catch (error) {
        this.hooks.notice(`Couldn't switch to ${key(plan.target)}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      // Like the engine's own retry: the failed answer stays in the record, out of what the next request sends.
      engine._omitRecoveryAttempt(message);
      engine._retryAttempt = 0;
      const compacted = await this.compactFor(plan.target);
      this.startedOn ??= key(from);
      this.hooks.notice(`Switched to ${key(plan.target)} because ${key(from)} ${REASON[plan.cause]}`
        + `${compacted ? "; compacted the conversation to fit its window" : ""}. Your next request tries ${this.startedOn} again.`);
      return true;
    }
    return false;
  }

  /** Compacts the conversation when it doesn't fit the new model's window, by that model, as the engine does near a full
   * window. True when it did. */
  private async compactFor(model: Model<Api>): Promise<boolean> {
    const engine = this.engine;
    if (!engine.settingsManager.getCompactionSettings(model).enabled) return false;
    if (!engine._exceedsCompactionThreshold(model, engine.sessionManager.buildSessionProjection())) return false;
    const last = () => engine.sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1)?.id;
    const before = last();
    await engine._runAutoCompaction("threshold", false).catch(() => false);
    return last() !== before;
  }
}
