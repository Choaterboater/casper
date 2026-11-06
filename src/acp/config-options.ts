// The model and effort an ACP app's picker shows and sets (decision 81), as ACP session config options: Casper's own
// models (the ones you're signed in to, in /model's order) and /effort's choices. A pick does what `/model
// provider/id` and `/effort <level>` do without --session: it changes this conversation and is saved as Casper's
// default. Only a listed value is taken; nothing else in the request reaches the runtime.

import { modelSelectedText } from "../app/commands";
import { providerName } from "../runtime/pi-models";
import type { RuntimeSession } from "../runtime/types";
import { effortChoices, effortHint } from "../tui/effort";
import { formatRuntimeStatus } from "../tui/format";
import { RpcFailure, RPC, type Json } from "./rpc";
import { hideDeep } from "./updates";

/** What one session offers now: the options as sent, and the values a set may take. */
export interface Offer {
  /** `configOptions` as the client gets them, hidden. */
  wire: Json[];
  /** Each listed model by its value (`provider/id`). */
  models: ReadonlyMap<string, { provider: string; id: string }>;
  /** The effort values offered for the current model; empty when there is no effort option. */
  efforts: readonly string[];
  /** The current model as `provider/id`, when there is one. */
  current?: string;
}

/** The parts of a runtime session an offer reads and a set calls. */
export type OfferRuntime = Pick<RuntimeSession, "getStatus" | "offeredModels" | "selectModel" | "setEffort">;

const EFFORT_NAMES: Record<string, string> = { auto: "Auto", off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** The effort values a model offers: /effort's choices when there is something to choose (at least three, as
 * Shift+Tab cycles), else none. */
export function offeredEfforts(levels: readonly string[] | undefined): string[] {
  const choices = effortChoices(levels);
  return choices.length >= 3 ? choices : [];
}

interface Entry { value: string; provider: string; name: string; efforts: string[]; description?: string; providerName?: string }

/** The options this session offers now. `hide` is the session's hiding: an option whose value it would change is left
 * out, and every name and description goes through it. */
export function offerOf(runtime: OfferRuntime | undefined, hide: (text: string) => string): Offer {
  const none: Offer = { wire: [], models: new Map(), efforts: [] };
  const status = runtime?.getStatus?.();
  if (!runtime || !status?.provider || !status.model) return none;
  const current = `${status.provider}/${status.model}`;
  const unchanged = (text: string) => hide(text) === text;
  const entries: Entry[] = (runtime.offeredModels?.() ?? []).map((model) => ({ value: `${model.provider}/${model.id}`, provider: model.provider,
    name: model.name || model.id, efforts: offeredEfforts(model.levels), ...(model.providerName ? { providerName: model.providerName } : {}) }));
  // The model in use stays listed when it can no longer be used (signed out, gone from its server), saying why.
  let mine = entries.find((entry) => entry.value === current);
  if (!mine) entries.unshift(mine = { value: current, provider: status.provider, name: status.model, efforts: [] });
  if (status.blocked) mine.description = status.blocked;
  const shown = entries.filter((entry) => unchanged(entry.value) && unchanged(entry.provider));
  if (!shown.includes(mine)) return none;
  const groups: Array<{ group: string; name: string; options: Json[] }> = [];
  for (const entry of shown) {
    let group = groups.find((item) => item.group === entry.provider);
    // Each group by its provider's name as Casper says it ("OpenAI Codex", "Claude Code plan"), never its id.
    if (!group) groups.push(group = { group: entry.provider, name: providerName(entry.provider, entry.providerName), options: [] });
    group.options.push({ value: entry.value, name: entry.name, ...(entry.description ? { description: entry.description } : {}),
      // The efforts the app's picker offers once this model is picked: the ones a set would take for it.
      _meta: { casper: { efforts: entry.efforts.filter(unchanged) } } });
  }
  const wire: Json[] = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: current, options: groups }];
  let efforts = offeredEfforts(status.availableThinkingLevels);
  const effort = status.configuredEffort ?? status.thinkingLevel;
  if (efforts.length && effort) {
    if (!efforts.includes(effort)) efforts = [effort, ...efforts];
    efforts = efforts.filter(unchanged);
    if (efforts.includes(effort)) {
      wire.push({ id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: effort,
        options: efforts.map((level) => ({ value: level, name: EFFORT_NAMES[level] ?? level, ...(effortHint(level) ? { description: effortHint(level) } : {}) })) });
    } else efforts = [];
  } else efforts = [];
  return { wire: hideDeep(wire, hide), models: new Map(shown.map((entry) => [entry.value, { provider: entry.provider, id: entry.value.slice(entry.provider.length + 1) }])), efforts, current };
}

const words = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Sets one option from the client. A refused request changes nothing: an unknown option, a value that is not a
 * string, a model that is not listed or an effort the model does not offer is refused before the runtime is called.
 * `write` gets the lines /model and /effort write (Casper's transcript on stderr).
 */
export async function setOption(runtime: OfferRuntime | undefined, offer: Offer, configId: unknown, value: unknown, write: (text: string) => void): Promise<void> {
  if (configId !== "model" && configId !== "effort") throw new RpcFailure(RPC.invalidParams, `Unknown option: ${String(configId)}`);
  if (typeof value !== "string") throw new RpcFailure(RPC.invalidParams, `${configId} takes one of its listed values`);
  if (configId === "model") {
    const model = offer.models.get(value);
    if (!model) throw new RpcFailure(RPC.invalidParams, `Casper can't use ${value}: it is not one of your signed-in models. Pick one from the list.`);
    if (!runtime?.selectModel) throw new RpcFailure(RPC.internal, "This runtime does not support model selection.");
    let result: Awaited<ReturnType<NonNullable<OfferRuntime["selectModel"]>>>;
    try { result = await runtime.selectModel({ exact: model, persist: true }); }
    catch (error) { throw new RpcFailure(RPC.internal, words(error)); }
    write(modelSelectedText(result));
    return;
  }
  if (!offer.efforts.includes(value)) {
    throw new RpcFailure(RPC.invalidParams, `${offer.current ?? "This model"} has no effort ${value}.${offer.efforts.length ? ` Choose: ${offer.efforts.join(", ")}` : ""}`);
  }
  if (!runtime?.setEffort) throw new RpcFailure(RPC.internal, "This runtime does not support effort controls.");
  try { write(`${formatRuntimeStatus(await runtime.setEffort(value, true))}\n`); }
  catch (error) { throw new RpcFailure(RPC.internal, words(error)); }
}
