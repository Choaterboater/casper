/** The fields each browser action reads. The tool schema, its description and the validator all use this table. */
export const BROWSER_ACTION_FIELDS = {
  open: ["url"], inspect: [], screenshot: [], diagnostics: [], viewport: ["width", "height"],
  check: ["scenario"], replay: ["id"], serve: ["script", "url", "impact", "reason"],
  click: ["selector", "impact", "reason"], fill: ["selector", "value", "impact", "reason"], press: ["selector", "value", "impact", "reason"],
} as const satisfies Record<string, readonly string[]>;
export type BrowserAction = keyof typeof BROWSER_ACTION_FIELDS;
export const BROWSER_ACTIONS = Object.keys(BROWSER_ACTION_FIELDS) as BrowserAction[];
/** Every field any action reads. A key outside this list is a mistake worth naming, never a placeholder. */
export const BROWSER_FIELDS: string[] = [...new Set(Object.values(BROWSER_ACTION_FIELDS).flat())];

/** A placeholder some models send for every schema field they do not need: null, "", 0, [], {} or an object of those. */
export function blank(value: unknown): boolean {
  if (value === null || value === undefined || value === 0 || value === false) return true;
  if (typeof value === "string") return !value.trim();
  if (Array.isArray(value)) return value.every(blank);
  if (typeof value === "object") return Object.values(value).every(blank);
  return false;
}

/** What one action takes, in words, for errors and the tool description. */
export function actionUsage(action: BrowserAction): string {
  const fields = BROWSER_ACTION_FIELDS[action];
  return fields.length ? `${action} takes ${fields.join(", ")}` : `${action} takes no other fields`;
}

/**
 * Keeps the fields the chosen action reads and sets the rest aside. Models that fill every schema field
 * (a serve call carrying width, height and a placeholder scenario) still run; the result names what was
 * not applied. Unknown keys and a scenario on replay are still errors, and each error says what to send.
 */
export function browserArguments(input: Record<string, unknown>): { action: BrowserAction; args: Record<string, unknown>; ignored: string[] } {
  const action = input.action;
  if (typeof action !== "string" || !(BROWSER_ACTIONS as string[]).includes(action)) {
    throw new Error(`Unknown browser action ${JSON.stringify(action ?? null).slice(0, 40)}; use one of: ${BROWSER_ACTIONS.join(", ")}`);
  }
  const chosen = action as BrowserAction;
  const fields: readonly string[] = BROWSER_ACTION_FIELDS[chosen];
  const unknown = Object.keys(input).filter(key => key !== "action" && !BROWSER_FIELDS.includes(key));
  if (unknown.length) throw new Error(`Unknown browser argument ${unknown.map(key => JSON.stringify(key.slice(0, 40))).join(", ")}; ${actionUsage(chosen)}`);
  if (chosen === "replay" && input.scenario !== undefined && input.scenario !== null) {
    throw new Error("replay runs the recorded scenario unchanged; send only action and id (record a new check to change the scenario)");
  }
  const args: Record<string, unknown> = { action: chosen };
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (key === "action") continue;
    if (fields.includes(key)) { if (value !== null && value !== "") args[key] = value; }
    else if (!blank(value)) ignored.push(key);
  }
  return { action: chosen, args, ignored };
}

export function text(value: unknown, label: string, limit = 2048): string {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) throw new Error(`Browser ${label} is missing`);
  if (typeof value !== "string" || Buffer.byteLength(value) > limit || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Browser ${label} must be one line of text under ${limit} bytes`);
  return value;
}
/** Accepts a loopback host:port without a scheme (127.0.0.1:3000) as http. */
export function webURL(value: unknown, label = "url"): string {
  const source = text(value, label);
  let url: URL;
  try { url = new URL(/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(source) ? `http://${source}` : source); }
  catch { throw new Error(`Browser ${label} must be a full HTTP(S) URL like http://localhost:3000`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`Browser ${label} must be an HTTP(S) URL without credentials, like http://localhost:3000`);
  return url.href;
}
