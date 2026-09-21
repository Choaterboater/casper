import type { VerificationScope } from "../verify/scope";
import { isVerificationScope } from "../verify/scope";

export interface BrowserStep { action: "click" | "fill" | "press"; selector: string; value?: string; impact: "local-test" | "consequential" | "uncertain"; reason: string }
export type BrowserAssertion = { kind: "text"; selector: string; expected: string }
  | { kind: "visible"; selector: string }
  | { kind: "no-horizontal-overflow" }
  | { kind: "no-overlap"; selector: string; other: string };
export interface BrowserScenario { name: string; url: string; viewport: { width: number; height: number }; steps: BrowserStep[]; assertions: BrowserAssertion[]; scope?: VerificationScope }
export interface BrowserCheck {
  id: string; name: string; scenarioSha256: string; url: string; viewport: { width: number; height: number };
  status: "pass" | "fail" | "incomplete"; baseline: "pass" | "fail" | "incomplete";
  freshness: "fresh" | "stale" | "unavailable"; scope?: VerificationScope; reason?: string;
  assertions: Array<{ kind: string; status: "pass" | "fail"; actual: unknown }>;
}
export interface BrowserReport { status: "pass" | "fail" | "incomplete"; checks: BrowserCheck[]; guidance: string }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid browser scenario fields");
  return value as Record<string, unknown>;
}
function string(value: unknown, limit = 512): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > limit || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid browser scenario text");
  return value;
}
export function viewport(value: unknown): { width: number; height: number } {
  const v = object(value, ["width", "height"]);
  if (!Number.isInteger(v.width) || !Number.isInteger(v.height) || Number(v.width) < 240 || Number(v.width) > 1920 || Number(v.height) < 240 || Number(v.height) > 1080) throw new Error("Browser viewport must be 240–1920 wide and 240–1080 high");
  return { width: Number(v.width), height: Number(v.height) };
}
export function parseScenario(input: unknown): BrowserScenario {
  if (Buffer.byteLength(JSON.stringify(input) ?? "") > 16_384) throw new Error("Browser scenario exceeds 16 KiB");
  const entry = object(input, ["name", "url", "viewport", "steps", "assertions", "scope"]);
  const url = new URL(string(entry.url, 2048));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Scenario needs an HTTP(S) URL without credentials");
  if (entry.scope !== undefined && !isVerificationScope(entry.scope)) throw new Error("Invalid browser input scope");
  if (!Array.isArray(entry.steps) || entry.steps.length > 12 || !Array.isArray(entry.assertions) || !entry.assertions.length || entry.assertions.length > 4) throw new Error("Scenario needs 0–12 steps and 1–4 assertions");
  const steps = entry.steps.map(value => {
    const step = object(value, ["action", "selector", "value", "impact", "reason"]);
    if (!["click", "fill", "press"].includes(String(step.action)) || !["local-test", "consequential", "uncertain"].includes(String(step.impact))) throw new Error("Invalid browser step action or impact");
    if (step.action === "click" && step.value !== undefined) throw new Error("Click does not accept a value");
    if (step.action !== "click") string(step.value, 1024);
    return { action: step.action, selector: string(step.selector), impact: step.impact, reason: string(step.reason),
      ...(step.value === undefined ? {} : { value: step.value }) } as BrowserStep;
  });
  const assertions = entry.assertions.map(value => {
    const a = object(value, ["kind", "selector", "expected", "other"]);
    if (a.kind === "no-horizontal-overflow" && Object.keys(a).length === 1) return { kind: a.kind };
    if (a.kind === "text" && Object.keys(a).length === 3) return { kind: a.kind, selector: string(a.selector), expected: string(a.expected, 1024) };
    if (a.kind === "visible" && Object.keys(a).length === 2) return { kind: a.kind, selector: string(a.selector) };
    if (a.kind === "no-overlap" && Object.keys(a).length === 3) return { kind: a.kind, selector: string(a.selector), other: string(a.other) };
    throw new Error("Invalid browser assertion");
  }) as BrowserAssertion[];
  return { name: string(entry.name, 120), url: url.href, viewport: viewport(entry.viewport ?? { width: 1280, height: 800 }), steps, assertions,
    ...(entry.scope ? { scope: structuredClone(entry.scope) as VerificationScope } : {}) };
}
