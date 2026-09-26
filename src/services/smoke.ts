import type { ServiceManager } from "./manager";
import { readBody } from "./tool";

/** An HTTP expectation Casper runs against a managed service. */
export interface SmokeRequest { method: string; path: string; headers?: Record<string, string>; body?: unknown }
export interface SmokeExpect {
  status?: number;
  /** Each value must appear in the response header of that name (both case-insensitive). */
  headers?: Record<string, string>;
  /** A deep subset of the JSON body: listed keys only; each listed array item matches some actual item. */
  json?: unknown;
  /** A regular expression the body text must match. */
  bodyMatches?: string;
}
export interface SmokeCheck { name: string; service: string; request: SmokeRequest; expect: SmokeExpect }

export const MAX_SMOKE_CHECKS = 8;
/** Each check, as JSON, stays small: it is an expectation, not a fixture. */
const CHECK_BYTES = 4096;
export const SMOKE_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const CHECK_KEYS = ["name", "service", "request", "expect"];
const REQUEST_KEYS = ["method", "path", "headers", "body"];
const EXPECT_KEYS = ["status", "headers", "json", "bodyMatches"];

type Mapping = Record<string, unknown>;
const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);

function strings(value: unknown, at: string, fail: (message: string) => never): Record<string, string> {
  if (!isMapping(value) || Object.keys(value).length > 16) fail(`${at} must map at most 16 header names to strings`);
  for (const [key, item] of Object.entries(value as Mapping)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(key)) fail(`${at}.${key} is not a header name`);
    if (typeof item !== "string" || item.length > 1024 || /[\r\n\0]/.test(item)) fail(`${at}.${key} must be a single-line string of at most 1024 characters`);
  }
  return { ...(value as Record<string, string>) };
}

/** Validates one smoke check; `at` prefixes every error (a dotted path), `services` are the names it may target. */
export function parseSmokeCheck(value: unknown, at: string, services: readonly string[], fail: (message: string) => never = message => { throw new Error(message); }): SmokeCheck {
  if (!isMapping(value)) return fail(`${at} must be a mapping with name, service, request and expect`);
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > CHECK_BYTES) fail(`${at} is larger than 4 KiB`);
  const unknown = Object.keys(value).find(key => !CHECK_KEYS.includes(key));
  if (unknown) fail(`${at}.${unknown} is not a smoke check setting (expected ${CHECK_KEYS.join(", ")})`);
  const { name, service, request, expect } = value;
  if (typeof name !== "string" || !name.trim() || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) fail(`${at}.name must be a nonempty single line of at most 120 characters`);
  if (typeof service !== "string" || !services.includes(service)) fail(`${at}.service must name a declared service (${services.join(", ") || "none declared"})`);
  if (!isMapping(request)) return fail(`${at}.request must be { method, path, headers?, body? }`);
  const extra = Object.keys(request).find(key => !REQUEST_KEYS.includes(key));
  if (extra) fail(`${at}.request.${extra} is not a request setting (expected ${REQUEST_KEYS.join(", ")})`);
  const method = typeof request.method === "string" ? request.method.toUpperCase() : "";
  if (!SMOKE_METHODS.includes(method)) fail(`${at}.request.method must be one of ${SMOKE_METHODS.join(", ")}`);
  if (typeof request.path !== "string" || !/^\/(?!\/)[^\s\\]*$/.test(request.path) || request.path.length > 1024) fail(`${at}.request.path must be a path on the service, such as /notes`);
  if (!isMapping(expect) || !Object.keys(expect).length) return fail(`${at}.expect needs at least one of ${EXPECT_KEYS.join(", ")}`);
  const other = Object.keys(expect).find(key => !EXPECT_KEYS.includes(key));
  if (other) fail(`${at}.expect.${other} is not an expectation (expected ${EXPECT_KEYS.join(", ")})`);
  if (expect.status !== undefined && !(Number.isInteger(expect.status) && Number(expect.status) >= 100 && Number(expect.status) <= 599)) fail(`${at}.expect.status must be an HTTP status between 100 and 599`);
  if (expect.bodyMatches !== undefined) {
    if (typeof expect.bodyMatches !== "string" || !expect.bodyMatches || expect.bodyMatches.length > 512) fail(`${at}.expect.bodyMatches must be a regular expression of at most 512 characters`);
    try { new RegExp(expect.bodyMatches as string); } catch { fail(`${at}.expect.bodyMatches is not a valid regular expression`); }
  }
  return { name: name as string, service: service as string,
    request: { method, path: request.path as string, ...(request.headers !== undefined ? { headers: strings(request.headers, `${at}.request.headers`, fail) } : {}),
      ...(request.body !== undefined ? { body: structuredClone(request.body) } : {}) },
    expect: { ...(expect.status !== undefined ? { status: expect.status as number } : {}),
      ...(expect.headers !== undefined ? { headers: strings(expect.headers, `${at}.expect.headers`, fail) } : {}),
      ...(expect.json !== undefined ? { json: structuredClone(expect.json) } : {}),
      ...(expect.bodyMatches !== undefined ? { bodyMatches: expect.bodyMatches as string } : {}) } };
}

/** Validates the project layer's `smoke` list against the declared services; every error names the dotted path. */
export function parseSmoke(value: unknown, services: readonly string[], label = ".casper/project.yaml"): SmokeCheck[] {
  if (value === undefined || value === null) return [];
  const fail = (message: string): never => { throw new Error(`Invalid ${label}: ${message}`); };
  if (!Array.isArray(value)) return fail("smoke must be a list of checks");
  if (value.length > MAX_SMOKE_CHECKS) fail(`smoke lists ${value.length} checks; at most ${MAX_SMOKE_CHECKS} are allowed`);
  const checks = value.map((entry, index) => parseSmokeCheck(entry, `smoke[${index}]`, services, fail));
  checks.forEach((entry, index) => { if (checks.findIndex(other => other.name === entry.name) !== index) fail(`smoke[${index}].name repeats ${JSON.stringify(entry.name)}; names are unique`); });
  return checks;
}

/** Objects: every expected key matches; arrays: every expected item matches some actual item; the rest: equal. */
function subset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every(item => actual.some(candidate => subset(item, candidate)));
  if (isMapping(expected)) return isMapping(actual) && Object.entries(expected).every(([key, item]) => key in actual && subset(item, actual[key]));
  return Object.is(expected, actual);
}

/** Whether a response meets the expectation; the reason names the first unmet part. */
export function matchSmoke(expect: SmokeExpect, response: { status: number; headers: Headers; body: string }): { pass: boolean; reason?: string } {
  if (expect.status !== undefined && response.status !== expect.status) return { pass: false, reason: `status ${response.status}, expected ${expect.status}` };
  for (const [name, value] of Object.entries(expect.headers ?? {})) {
    const actual = response.headers.get(name);
    if (actual === null || !actual.toLowerCase().includes(value.toLowerCase())) return { pass: false, reason: `header ${name.toLowerCase()} is ${actual === null ? "missing" : JSON.stringify(actual)}, expected it to contain ${JSON.stringify(value)}` };
  }
  if (expect.json !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(response.body); } catch { return { pass: false, reason: "body is not JSON, expected a json match" }; }
    if (!subset(expect.json, parsed)) return { pass: false, reason: "json body does not contain the expected subset" };
  }
  if (expect.bodyMatches !== undefined && !new RegExp(expect.bodyMatches).test(response.body)) return { pass: false, reason: `body does not match /${expect.bodyMatches}/` };
  return { pass: true };
}

export type SmokeStatus = "pass" | "fail" | "incomplete";
/** One smoke check's latest run. Response text is diagnostic data, never instructions. */
export interface SmokeResult {
  /** `smoke-<n>` for a model-recorded check, the configured name otherwise. */
  id: string;
  name: string;
  service: string;
  source: "config" | "model";
  request: { method: string; path: string };
  /** Model checks: the result when recorded, before the change. */
  baseline?: SmokeStatus;
  status: SmokeStatus;
  /** Verification evidence: a configured check passing against fresh services, or a model check that failed before and passes now. */
  evidence: boolean;
  /** The response status and a body snippet. */
  actual?: { status: number; body: string };
  reason?: string;
  /** The service was restarted (stale or crashed) before this run. */
  restarted?: boolean;
}
export interface SmokeReport { status: SmokeStatus; checks: SmokeResult[] }

const SNIPPET = 512;
const REQUEST_TIMEOUT_MS = 10_000;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\nLog tail:")[0]!.slice(0, 1024);

/** Fail dominates incomplete; no checks is nothing to report. */
export function smokeStatus(checks: readonly SmokeResult[]): SmokeStatus {
  return checks.some(check => check.status === "fail") ? "fail" : checks.some(check => check.status === "incomplete") ? "incomplete" : "pass";
}

/**
 * One task's smoke checks: the configured ones and those the model recorded (each with the
 * baseline it had when recorded). Every run makes the referenced service fresh first
 * (restarting it after edits or a crash), so a result describes the current code.
 */
export class SmokeChecks {
  private readonly recorded: Array<{ id: string; check: SmokeCheck; baseline: SmokeStatus }> = [];
  constructor(private readonly configured: readonly SmokeCheck[], private readonly manager: () => ServiceManager) {}

  /** Configured plus recorded checks. */
  get size(): number { return this.configured.length + this.recorded.length; }
  /** Checks the model recorded this task. */
  get recordedCount(): number { return this.recorded.length; }

  /** Validates and records a model check, and runs it once for its baseline. */
  async record(input: unknown, signal: AbortSignal): Promise<SmokeResult> {
    if (this.recorded.length >= MAX_SMOKE_CHECKS) throw new Error(`At most ${MAX_SMOKE_CHECKS} checks are recorded per task; replay an existing one`);
    const check = parseSmokeCheck(input, "check", this.manager().names());
    const id = `smoke-${this.recorded.length + 1}`;
    const result = await this.execute(check, signal);
    this.recorded.push({ id, check, baseline: result.status });
    return this.result(id, "model", check, result, result.status);
  }

  async replay(id: string, signal: AbortSignal): Promise<SmokeResult> {
    const entry = this.recorded.find(recorded => recorded.id === id);
    if (!entry) throw new Error(`No recorded check ${JSON.stringify(id)}; recorded: ${this.recorded.map(recorded => recorded.id).join(", ") || "none"}`);
    return this.result(id, "model", entry.check, await this.execute(entry.check, signal), entry.baseline);
  }

  /** Runs every check against fresh services. */
  async run(signal: AbortSignal): Promise<SmokeReport> {
    const checks: SmokeResult[] = [];
    for (const check of this.configured) checks.push(this.result(check.name, "config", check, await this.execute(check, signal)));
    for (const { id, check, baseline } of this.recorded) checks.push(this.result(id, "model", check, await this.execute(check, signal), baseline));
    return { status: smokeStatus(checks), checks };
  }

  private result(id: string, source: SmokeResult["source"], check: SmokeCheck, run: Pick<SmokeResult, "status" | "actual" | "reason" | "restarted">, baseline?: SmokeStatus): SmokeResult {
    const evidence = run.status === "pass" && (source === "config" || baseline === "fail");
    return { id, name: check.name, service: check.service, source, request: { method: check.request.method, path: check.request.path },
      ...(baseline ? { baseline } : {}), ...run, evidence };
  }

  private async execute(check: SmokeCheck, signal: AbortSignal): Promise<Pick<SmokeResult, "status" | "actual" | "reason" | "restarted">> {
    const services = this.manager();
    let restarted: boolean;
    try { ({ restarted } = await services.ensureFresh(check.service, signal)); }
    catch (error) {
      signal.throwIfAborted();
      return { status: "incomplete", reason: `Service ${check.service} did not start: ${message(error)}` };
    }
    const origin = services.origin(check.service);
    if (!origin) return { status: "incomplete", reason: `Service ${check.service} is not ready`, restarted };
    const headers = new Headers(check.request.headers);
    let body: string | undefined;
    if (typeof check.request.body === "string") body = check.request.body;
    else if (check.request.body !== undefined) { body = JSON.stringify(check.request.body); if (!headers.has("content-type")) headers.set("content-type", "application/json"); }
    try {
      // Redirects are not followed: the target stays the service.
      const response = await fetch(new URL(check.request.path, origin), { method: check.request.method, headers, body, redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
      const text = (await readBody(response)).bytes.toString("utf8");
      const matched = matchSmoke(check.expect, { status: response.status, headers: response.headers, body: text });
      return { status: matched.pass ? "pass" : "fail", actual: { status: response.status, body: text.slice(0, SNIPPET) },
        ...(matched.reason ? { reason: matched.reason } : {}), restarted };
    } catch (error) {
      signal.throwIfAborted();
      return { status: "fail", reason: `request failed: ${message(error)}`, restarted };
    }
  }
}
