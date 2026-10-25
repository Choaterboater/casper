/**
 * What Casper knows about a model that the engine's catalog has no field for, by provider and id: whether it is free,
 * its price, its window, when its provider listed it, whether it calls tools, and how it scores. OpenRouter's own model
 * list fills it, from the same read that adds its models to the catalog (src/runtime/openrouter-models.ts); /model's
 * orders and score column read it.
 */

export interface ModelFacts {
  /** Free to use: an OpenRouter `:free` model, or one it prices at 0. */
  free: boolean;
  /** US dollars per million tokens. None when the price is that of whichever model a router picks. */
  price?: { input: number; output: number };
  /** Tokens. */
  contextWindow?: number;
  /** When the provider listed the model, in milliseconds since 1970. */
  created?: number;
  /** Whether it can call tools (Casper's work needs them). */
  tools: boolean;
  /** Artificial Analysis' Intelligence, Coding and Agentic Indexes (higher is better); none for a model it hasn't rated. */
  intelligence?: number;
  coding?: number;
  agentic?: number;
  /** Its place on Design Arena's coding board (1 is first). */
  codingRank?: number;
  /** The hosts that keep nothing of a request (OpenRouter's zero-data-retention list): none means every host may keep
   * prompts; unknown (left out) when that list wasn't read. OpenRouter may still send a request to another host. */
  privateHosts?: string[];
}

const known = new Map<string, ReadonlyMap<string, ModelFacts>>();

/** What is known about `provider/id`, if anything. */
export function modelFacts(provider: string, id: string): ModelFacts | undefined {
  return known.get(provider)?.get(id);
}

/** Every model of one provider something is known about, by id. */
export function providerFacts(provider: string): ReadonlyMap<string, ModelFacts> {
  return known.get(provider) ?? new Map();
}

/** Replaces what is known about one provider's models with a newer read. */
export function setModelFacts(provider: string, facts: ReadonlyMap<string, ModelFacts>): void {
  known.set(provider, facts);
}

/** Forgets one provider's facts, or all of them (tests). */
export function forgetModelFacts(provider?: string): void {
  if (provider === undefined) known.clear();
  else known.delete(provider);
}
