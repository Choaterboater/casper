import type { VerificationScope } from "../verify/scope";
import { isVerificationScope } from "../verify/scope";
import { blank, webURL } from "./arguments";

const ASSERTION_FIELDS: Record<string, string[]> = { text: ["selector", "expected"], visible: ["selector"], "no-horizontal-overflow": ["selector"], "no-overlap": ["selector", "other"] };
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

export interface BrowserStep { action: "click" | "fill" | "press"; selector: string; value?: string; impact: "local-test" | "consequential" | "uncertain"; reason: string }
export type BrowserAssertion = { kind: "text"; selector: string; expected: string }
  | { kind: "visible"; selector: string }
  /** Page-wide, or one element (its own scrolling content, or running past the viewport) when a selector names it. */
  | { kind: "no-horizontal-overflow"; selector?: string }
  | { kind: "no-overlap"; selector: string; other: string };
export interface BrowserScenario { name: string; url: string; viewport: { width: number; height: number }; steps: BrowserStep[]; assertions: BrowserAssertion[]; scope?: VerificationScope }
export interface BrowserCheck {
  id: string; name: string; scenarioSha256: string; url: string; viewport: { width: number; height: number };
  status: "pass" | "fail" | "incomplete"; baseline: "pass" | "fail" | "incomplete";
  freshness: "fresh" | "stale" | "unavailable"; scope?: VerificationScope; reason?: string;
  assertions: Array<{ kind: string; status: "pass" | "fail"; actual: unknown }>;
}
export interface BrowserReport { status: "pass" | "fail" | "incomplete"; checks: BrowserCheck[]; guidance: string }
/** Drops null and blank placeholders; a real value under a key this object does not take is named in the error. */
function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Browser ${label} must be an object with ${keys.join(", ")}`);
  const kept: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (keys.includes(key)) { if (entry !== null && entry !== "") kept[key] = entry; }
    else if (!blank(entry)) throw new Error(`Browser ${label} does not take ${JSON.stringify(key.slice(0, 40))}; it takes ${keys.join(", ")}`);
  }
  return kept;
}
function string(value: unknown, label: string, limit = 512): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Browser ${label} is missing`);
  if (Buffer.byteLength(value) > limit || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Browser ${label} must be one line of text under ${limit} bytes`);
  return value;
}
export function viewport(value: unknown): { width: number; height: number } {
  const v = object(value, ["width", "height"], "viewport");
  if (!Number.isInteger(v.width) || !Number.isInteger(v.height) || Number(v.width) < 240 || Number(v.width) > 1920 || Number(v.height) < 240 || Number(v.height) > 1080) throw new Error("Browser viewport must be 240–1920 wide and 240–1080 high");
  return { width: Number(v.width), height: Number(v.height) };
}
export function parseScenario(input: unknown): BrowserScenario {
  if (Buffer.byteLength(JSON.stringify(input) ?? "") > 16_384) throw new Error("Browser scenario exceeds 16 KiB");
  const entry = object(input, ["name", "url", "viewport", "steps", "assertions", "scope"], "scenario");
  const url = new URL(webURL(entry.url, "scenario url"));
  // An empty scope or a 0×0 viewport is a placeholder: no scope, default viewport.
  const scope = record(entry.scope) && Array.isArray(entry.scope.inputs) && !entry.scope.inputs.length && blank(entry.scope.exclude) ? undefined : entry.scope;
  if (scope !== undefined && !isVerificationScope(scope)) throw new Error("Browser scenario scope needs inputs: 1–32 project-relative paths (exclude is optional)");
  const steps = entry.steps ?? [];
  if (!Array.isArray(steps) || steps.length > 12) throw new Error("Browser scenario steps must be a list of 0–12 click/fill/press steps");
  if (!Array.isArray(entry.assertions) || !entry.assertions.length || entry.assertions.length > 4) throw new Error("Browser scenario needs 1–4 assertions");
  const parsedSteps = steps.map((value, index) => {
    const step = object(value, ["action", "selector", "value", "impact", "reason"], `scenario step ${index + 1}`);
    if (!["click", "fill", "press"].includes(String(step.action))) throw new Error(`Browser scenario step ${index + 1} action must be click, fill or press`);
    if (!["local-test", "consequential", "uncertain"].includes(String(step.impact))) throw new Error(`Browser scenario step ${index + 1} needs impact: local-test, consequential or uncertain`);
    if (step.action === "click" && step.value !== undefined) throw new Error(`Browser scenario step ${index + 1}: click does not take a value`);
    if (step.action !== "click") string(step.value, `scenario step ${index + 1} value`, 1024);
    return { action: step.action, selector: string(step.selector, `scenario step ${index + 1} selector`), impact: step.impact, reason: string(step.reason, `scenario step ${index + 1} reason`),
      ...(step.value === undefined ? {} : { value: step.value }) } as BrowserStep;
  });
  const assertions = entry.assertions.map((value, index) => {
    const label = `scenario assertion ${index + 1}`;
    const kind = record(value) ? value.kind : undefined;
    const fields = ASSERTION_FIELDS[String(kind)];
    if (!fields) throw new Error(`Browser ${label} kind must be one of: ${Object.keys(ASSERTION_FIELDS).join(", ")}`);
    const a = object(value, ["kind", ...fields], `${label} (${String(kind)})`);
    if (kind === "no-horizontal-overflow") return a.selector === undefined ? { kind } : { kind, selector: string(a.selector, `${label} selector`) };
    if (kind === "text") return { kind, selector: string(a.selector, `${label} selector`), expected: string(a.expected, `${label} expected`, 1024) };
    if (kind === "visible") return { kind, selector: string(a.selector, `${label} selector`) };
    return { kind, selector: string(a.selector, `${label} selector`), other: string(a.other, `${label} other`) };
  }) as BrowserAssertion[];
  const size = entry.viewport === undefined || blank(entry.viewport) ? { width: 1280, height: 800 } : entry.viewport;
  return { name: string(entry.name, "scenario name", 120), url: url.href, viewport: viewport(size), steps: parsedSteps, assertions,
    ...(scope ? { scope: structuredClone(scope) as VerificationScope } : {}) };
}
