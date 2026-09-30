/** How long the provider keeps the conversation's prompt cache: `cache:` in ~/.casper/config.yaml.
 * auto (default): the long cache only where it costs nothing extra, the short one elsewhere;
 * long: about an hour, or a day where the provider offers it; short: a few minutes; off: none. */
export type PromptCacheSetting = "auto" | "long" | "short" | "off";
export const PROMPT_CACHE_SETTINGS: readonly PromptCacheSetting[] = ["auto", "long", "short", "off"];

/** What the retention rule reads from Pi's model: the wire format and any compat overrides. */
export interface CacheModel {
  api: string;
  provider?: string;
  id?: string;
  baseUrl?: string;
  compat?: unknown;
}

function compatFlag(model: CacheModel, key: string): unknown {
  return model.compat && typeof model.compat === "object" ? (model.compat as Record<string, unknown>)[key] : undefined;
}

/** Whether Pi's request for the long cache is OpenAI's prompt_cache_retention, which costs nothing
 * extra to write, on a provider known to take it: OpenAI itself, and OpenRouter's non-Anthropic models.
 * Anthropic cache_control (API, OpenRouter's anthropic/ models, Bedrock) charges about twice base input
 * for the hour against 1.25x for five minutes, so those are not. Other OpenAI-style and local servers
 * keep the short one, so they never see a field they might reject. Mirrors how Pi picks
 * cacheControlFormat in openai-completions and prompt_cache_options in openai-responses. */
function longCacheIsFree(model: CacheModel): boolean {
  if (compatFlag(model, "supportsLongCacheRetention") === false) return false;
  const openai = model.provider === "openai" || model.baseUrl?.includes("api.openai.com") === true;
  if (model.api === "openai-completions") {
    const format = compatFlag(model, "cacheControlFormat")
      ?? (model.provider === "openrouter" && model.id?.startsWith("anthropic/") ? "anthropic" : undefined);
    return format !== "anthropic" && (openai || model.provider === "openrouter");
  }
  // The explicit cache mode's ttl is a different, provider-specific request; keep it short.
  if (model.api === "openai-responses") return openai && compatFlag(model, "supportsExplicitPromptCacheMode") !== true;
  return false;
}

/** Pi's retention for one conversation request. Pi sends the long lifetime only where the provider
 * says it supports it and falls back to the short one elsewhere. Bedrock is the exception: Pi asks
 * it for an hour on every Claude model without checking the model takes it, so it keeps the short one. */
export function cacheRetentionFor(setting: PromptCacheSetting | undefined, model: CacheModel): "long" | "short" | "none" {
  if (setting === "off") return "none";
  if (setting === "short" || model.api === "bedrock-converse-stream") return "short";
  if (setting === "long") return "long";
  return longCacheIsFree(model) ? "long" : "short";
}
