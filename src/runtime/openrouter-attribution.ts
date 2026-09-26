/** OpenRouter files usage under an app page keyed by these headers, so Casper's model traffic
 * is not attributed to the runtime it is built on. This is app identity only: no user,
 * workspace, prompt, or credential data is added to a request.
 *
 * The visibility header creates the app hidden while this is an early preview: attribution and
 * the app's own analytics still work, but it stays out of the public rankings, marketplace, and
 * app pages. OpenRouter honors it only when the request creates a brand-new app, so listing
 * Casper publicly later means an explicit decision (and possibly contacting OpenRouter).
 * https://openrouter.ai/docs/app-attribution */
export const OPENROUTER_ATTRIBUTION: Record<string, string> = {
  "HTTP-Referer": "https://github.com/Choaterboater/casper",
  "X-OpenRouter-Title": "Casper",
  "X-OpenRouter-Categories": "cli-agent",
  "X-OpenRouter-App-Visibility": "hidden",
};

/** `CASPER_TELEMETRY` mirrors Pi's `PI_TELEMETRY`: unset leaves attribution on; set, only
 * `1`/`true`/`yes` keep it. The opt-out exists so a benchmark can send the same request headers
 * as Pi run with `PI_TELEMETRY=0`, and for anyone who wants no app identity on their traffic. */
export function casperTelemetryEnabled(value = process.env.CASPER_TELEMETRY): boolean {
  return value === undefined || ["1", "true", "yes"].includes(value.toLowerCase());
}

/** The attribution headers to send now, or none under `CASPER_TELEMETRY=0`. */
export function openRouterAttribution(): Record<string, string> {
  return casperTelemetryEnabled() ? OPENROUTER_ATTRIBUTION : {};
}

/** A request is OpenRouter's by provider id or by endpoint host, matching how the runtime
 * classifies a model. Anything else is left untouched. */
export function isOpenRouterModel(model: { provider?: string; baseUrl?: string } | undefined): boolean {
  if (!model) return false;
  if (model.provider === "openrouter") return true;
  try { return new URL(model.baseUrl ?? "").hostname === "openrouter.ai"; } catch { return false; }
}