/** OpenRouter files usage under an app page keyed by these headers, so Casper's model traffic
 * is not attributed to the runtime it is built on. This is app identity only: no user,
 * workspace, prompt, or credential data is added to a request.
 *
 * The visibility header creates the app hidden while this is an early preview: attribution and
 * the app's own analytics still work, but it stays out of the public rankings, marketplace, and
 * app pages. OpenRouter honors it only when the request creates a brand-new app, so listing
 * Casper publicly later means an explicit decision (and possibly contacting OpenRouter).
 * https://openrouter.ai/docs/app-attribution */
/* The referer is Casper's site, so OpenRouter shows the site's icon for the app (a GitHub URL showed
 * GitHub's). OpenRouter keys apps by referer, so the change may start a new app entry. */
export const OPENROUTER_ATTRIBUTION: Record<string, string> = {
  "HTTP-Referer": "https://choaterboater.github.io/casper/",
  "X-OpenRouter-Title": "Casper",
  "X-OpenRouter-Categories": "cli-agent",
  "X-OpenRouter-App-Visibility": "hidden",
};

/** The engine's own OpenRouter attribution, which Casper's replaces (or takes out when off). */
const ENGINE_ATTRIBUTION: Record<string, string> = {
  "HTTP-Referer": "https://pi.dev", "X-OpenRouter-Title": "pi", "X-OpenRouter-Categories": "cli-agent",
};

/** `telemetry:` in your own config, as the session reads it now (undefined: nothing set). */
let ownSetting: (() => boolean | undefined) | undefined;

/** The session reads `telemetry: off` from your config through this; the returned function stops it
 * (closing the session). One session per process, so the last one to start is the one read. */
export function useTelemetrySetting(read: () => boolean | undefined): () => void {
  ownSetting = read;
  return () => { if (ownSetting === read) ownSetting = undefined; };
}

/** `CASPER_TELEMETRY` mirrors Pi's `PI_TELEMETRY`: unset leaves attribution on; set, only
 * `1`/`true`/`yes` keep it. The opt-out exists so a benchmark can send the same request headers
 * as Pi run with `PI_TELEMETRY=0`, and for anyone who wants no app identity on their traffic.
 * `telemetry: off` in your config (/settings) turns it off as well; either one off is off. */
export function casperTelemetryEnabled(value = process.env.CASPER_TELEMETRY): boolean {
  if (ownSetting?.() === false) return false;
  return value === undefined || ["1", "true", "yes"].includes(value.toLowerCase());
}

/** The attribution headers to send now, or none under `CASPER_TELEMETRY=0` or `telemetry: off`. */
export function openRouterAttribution(): Record<string, string> {
  return casperTelemetryEnabled() ? OPENROUTER_ATTRIBUTION : {};
}

/** A conversation request's headers, changed in place: Casper's attribution replaces the engine's, or,
 * when it is off, the engine's is taken out too (PI_TELEMETRY is set only at startup, before your
 * config is read). Headers that aren't the engine's attribution are left alone; null removes a header. */
export function applyOpenRouterAttribution(headers: Record<string, string | null>): void {
  const ours = openRouterAttribution();
  if (Object.keys(ours).length) { Object.assign(headers, ours); return; }
  for (const [key, value] of Object.entries(ENGINE_ATTRIBUTION)) if (headers[key] === value) headers[key] = null;
}

/** A request is OpenRouter's by provider id or by endpoint host, matching how the runtime
 * classifies a model. Anything else is left untouched. */
export function isOpenRouterModel(model: { provider?: string; baseUrl?: string } | undefined): boolean {
  if (!model) return false;
  if (model.provider === "openrouter") return true;
  try { return new URL(model.baseUrl ?? "").hostname === "openrouter.ai"; } catch { return false; }
}
/** Stream options for a direct request (completeSimple) that bypasses the session's header hook:
 * Casper's attribution when the model is OpenRouter's, nothing otherwise. Without it OpenRouter
 * files the request under "Unknown". */
export function openRouterRequestHeaders(model: { provider?: string; baseUrl?: string } | undefined): { headers?: Record<string, string> } {
  const headers = isOpenRouterModel(model) ? openRouterAttribution() : {};
  return Object.keys(headers).length ? { headers: { ...headers } } : {};
}
