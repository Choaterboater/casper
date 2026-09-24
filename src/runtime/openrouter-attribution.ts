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

/** A request is OpenRouter's by provider id or by endpoint host, matching how the runtime
 * classifies a model. Anything else is left untouched. */
export function isOpenRouterModel(model: { provider?: string; baseUrl?: string } | undefined): boolean {
  if (!model) return false;
  if (model.provider === "openrouter") return true;
  try { return new URL(model.baseUrl ?? "").hostname === "openrouter.ai"; } catch { return false; }
}