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
