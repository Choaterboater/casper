import { boundedObservation } from "../capabilities/result";
import type { RuntimeTool } from "../runtime/types";
import type { ServiceSpec } from "./config";
import type { ServiceManager } from "./manager";
import type { SmokeChecks } from "./smoke";

/** Server vocabulary in the task, declared services or a live one pull in the service tool; elsewhere it costs no prompt tokens. */
export function serviceRequested(task: string, services: { declared: boolean; live: boolean }): boolean {
  return services.declared || services.live || /\b(?:dev|http|web)[ -]?servers?\b|\blocalhost\b|\bendpoints?\b|\bcurl\b/i.test(task);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
/** Headers worth a model's attention; the rest are counted, not shown. */
const SHOWN_HEADERS = ["content-type", "content-length", "location", "allow", "cache-control", "etag", "last-modified", "retry-after", "www-authenticate"];
const BODY_BYTES = 8192;
/** Read at most this much of a body: enough to pretty-print moderate JSON before the 8 KiB cut. */
const READ_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 10_000;

const string = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a nonempty string`);
  return value;
};
const optional = (value: unknown, name: string): string | undefined => value === undefined ? undefined : string(value, name);

/** Reads up to READ_BYTES, then stops the stream; `complete` says whether the whole body arrived. */
export async function readBody(response: Response): Promise<{ bytes: Buffer; complete: boolean }> {
  if (!response.body) return { bytes: Buffer.alloc(0), complete: true };
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: Buffer.concat(chunks), complete: true };
    chunks.push(Buffer.from(value)); size += value.byteLength;
    if (size > READ_BYTES) { await reader.cancel().catch(() => {}); return { bytes: Buffer.concat(chunks).subarray(0, READ_BYTES), complete: false }; }
  }
}

/** JSON is pretty-printed; the shown body is cut at 8 KiB on a character boundary with a marker naming the
 * size of what is shown (pretty JSON is larger than it was on the wire, so the marker says which). */
function showBody(bytes: Buffer, complete: boolean, contentType: string): string {
  let text = bytes.toString("utf8"), pretty = false;
  if (complete && /\bjson\b|\+json/i.test(contentType)) { try { text = JSON.stringify(JSON.parse(text), null, 2); pretty = true; } catch { /* shown as sent */ } }
  const size = Buffer.byteLength(text);
  if (complete && size <= BODY_BYTES) return text;
  const shown = Buffer.from(text).subarray(0, BODY_BYTES).toString("utf8").replace(/\uFFFD+$/, "");
  return `${shown}\n[truncated: ${complete ? `${size} bytes${pretty ? " as pretty-printed JSON" : ""}` : `more than ${READ_BYTES} bytes`}, first ${BODY_BYTES} shown]`;
}

/** The model's handle on Casper's managed services. `manager` is created on first use; `smoke`
 * is the current task's smoke checks, which `check` records into and Casper replays after the change. */
export function serviceTool(manager: () => ServiceManager, lifetime?: AbortSignal, smoke?: () => SmokeChecks | undefined): RuntimeTool {
  const describe = (services: ServiceManager, name: string) => services.status().find(service => service.name === name)!;

  /** A request goes to a managed service's origin (by name and path, or by its URL) or to another loopback URL; nothing else. */
  async function request(services: ServiceManager, args: Record<string, unknown>, signal: AbortSignal) {
    const method = (optional(args.method, "method") ?? "GET").toUpperCase();
    if (!METHODS.includes(method)) throw new Error(`method must be one of ${METHODS.join(", ")}`);
    let name = optional(args.service, "service"), url: URL, restarted = false;
    if (args.url !== undefined) {
      if (args.path !== undefined) throw new Error("Give path (with service) or url, not both");
      try { url = new URL(string(args.url, "url")); } catch { throw new Error("url must be an absolute http://localhost, 127.0.0.1 or [::1] URL"); }
      if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) {
        throw new Error("Requests are limited to Casper's services and loopback http:// URLs (localhost, 127.0.0.1, [::1])");
      }
      const owner = services.status().find(service => service.origin && new URL(service.origin).port === url.port);
      if (name !== undefined && owner?.name !== name) throw new Error(`url is not ${name}'s address; give service and path instead`);
      name = owner?.name;
    } else {
      const target = string(args.path, "path");
      // URL parsing reads a backslash as a slash (`/\host/x` would name a host), so it is refused, not rewritten.
      if (!/^\/(?!\/)[^\\]*$/.test(target)) throw new Error("path must start with a single / and contain no \\ (use url for a full loopback URL)");
      if (name === undefined) {
        const names = services.names();
        if (names.length !== 1) throw new Error(`Name the service: ${names.join(", ") || "none declared or started"}`);
        name = names[0]!;
      }
      url = new URL(target, "http://127.0.0.1");
    }
    if (name !== undefined) {
      // Never test stale code: edits since the start (or a crash) restart the service first.
      ({ restarted } = await services.ensureFresh(name, signal));
      const origin = services.origin(name);
      if (!origin) throw new Error(`Service ${name} is not ready`);
      url = new URL(url.pathname + url.search, origin);
    }
    const headers = args.headers === undefined ? {} : args.headers;
    if (typeof headers !== "object" || headers === null || Array.isArray(headers) || Object.values(headers).some(value => typeof value !== "string")) {
      throw new Error("headers must map names to strings");
    }
    const sent = new Headers(headers as Record<string, string>);
    let body: string | undefined;
    if (typeof args.body === "string") body = args.body;
    else if (args.body !== undefined) { body = JSON.stringify(args.body); if (!sent.has("content-type")) sent.set("content-type", "application/json"); }
    const began = performance.now();
    // Redirects are shown, not followed: a Location may leave loopback.
    const response = await fetch(url, { method, headers: sent, body, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
    const { bytes, complete } = await readBody(response);
    const timeMs = Math.round(performance.now() - began);
    const shown = Object.fromEntries(SHOWN_HEADERS.flatMap(header => { const value = response.headers.get(header); return value === null ? [] : [[header, value]]; }));
    return { ...(name ? { service: name } : {}), method, url: url.href, restarted, status: response.status, statusText: response.statusText,
      headers: shown, otherHeaders: [...response.headers.keys()].filter(header => !SHOWN_HEADERS.includes(header)).length,
      body: showBody(bytes, complete, response.headers.get("content-type") ?? ""), timeMs };
  }

  async function run(services: ServiceManager, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const start = async (name: string) => { const { restarted } = await services.ensureFresh(name, signal); return { restarted, service: describe(services, name) }; };
    const action = args.action;
    if (action === "status") return { services: services.status() };
    if (action === "request") return request(services, args, signal);
    if (action === "check" || action === "replay") {
      const checks = smoke?.();
      if (!checks) throw new Error("Checks are recorded during a task with Casper's verification on");
      const check = action === "check" ? await checks.record({ name: args.name, service: args.service, request: args.request, expect: args.expect }, signal)
        : await checks.replay(string(args.id, "id"), signal);
      return { check, guidance: "Casper replays every recorded check after the change. A check counts as evidence only when it failed before the change and passes after it; one that passed before is an observation." };
    }
    if (action === "start" && args.command !== undefined) {
      if (args.service !== undefined) throw new Error("Give service (declared) or command (ad-hoc), not both");
      const ready = args.ready as Record<string, unknown> | undefined;
      let spec: ServiceSpec["ready"] | undefined;
      if (ready !== undefined) {
        if (typeof ready !== "object" || ready === null || Object.keys(ready).length !== 1) throw new Error("ready must be { http: <path> } or { log: <text> }");
        spec = "http" in ready ? { http: string(ready.http, "ready.http") } : { log: string(ready.log, "ready.log") };
      }
      const timeoutMs = args.timeoutMs === undefined ? undefined : Number(args.timeoutMs);
      // Joining the same command then takes the declared start's path, so a stale one restarts.
      return start((await services.startCommand(string(args.command, "command"), { ready: spec, timeoutMs }, signal)).name);
    }
    const name = string(args.service, "service");
    if (action === "start") return start(name);
    if (action === "restart") return { service: await services.restart(name, signal) };
    if (action === "stop") { const stopped = await services.stop(name); return { stopped, service: describe(services, name) }; }
    if (action === "logs") {
      const lines = Math.min(200, Math.max(1, Number.isInteger(args.lines) ? Number(args.lines) : 40));
      const { text, truncated } = services.logs(name, { lines, ...(typeof args.filter === "string" && args.filter ? { filter: args.filter } : {}) });
      return { service: name, logs: text, truncated };
    }
    throw new Error("action must be start, status, logs, restart, stop, request, check or replay");
  }

  return {
    name: "service",
    description: "Run and observe the project's services (dev servers) in the background under Casper's control; do not background servers with bash. Casper gives each a loopback port (PORT/HOST env), waits until it is ready, keeps its log, restarts it after edits and stops it with the session. start a declared service by name, or an ad-hoc one by command (it must listen on $HOST:$PORT); status; logs (lines, filter); restart; stop. request sends HTTP to a service path or a loopback URL, restarting a stale or crashed service first; nothing else is reachable. Crashes are reported on your next call. For new or changed endpoint behavior, record a check before editing (check: name, service, request { method, path, headers?, body? }, expect { status?, headers?, json? subset, bodyMatches? }); Casper replays it after the change, and replay { id } reruns it.",
    inputSchema: { type: "object", additionalProperties: false, required: ["action"], properties: {
      action: { type: "string", enum: ["start", "status", "logs", "restart", "stop", "request", "check", "replay"] },
      service: { type: "string" }, command: { type: "string" },
      ready: { type: "object", additionalProperties: false, properties: { http: { type: "string" }, log: { type: "string" } } },
      timeoutMs: { type: "integer" }, lines: { type: "integer" }, filter: { type: "string" },
      method: { type: "string", enum: METHODS }, path: { type: "string" }, url: { type: "string" },
      headers: { type: "object", additionalProperties: { type: "string" } }, body: {},
      name: { type: "string" }, id: { type: "string" },
      request: { type: "object", additionalProperties: false, required: ["method", "path"], properties: {
        method: { type: "string", enum: METHODS }, path: { type: "string" }, headers: { type: "object", additionalProperties: { type: "string" } }, body: {} } },
      expect: { type: "object", additionalProperties: false, properties: {
        status: { type: "integer" }, headers: { type: "object", additionalProperties: { type: "string" } }, json: {}, bodyMatches: { type: "string" } } },
    } },
    async execute(args, signal) {
      const services = manager();
      // A crash is recorded, not pushed into a turn: it surfaces here, before a restart can replace it.
      const crashed = services.takeCrashes();
      const report = crashed.length ? { crashed: crashed.map(({ name, exit, tail }) => ({ name, exit, tail })) } : {};
      try {
        const signals = [lifetime, signal].filter((entry): entry is AbortSignal => Boolean(entry));
        const result = await run(services, args, signals.length ? AbortSignal.any(signals) : new AbortController().signal);
        return { text: boundedObservation({ ...result, ...report }, "Service observation") };
      } catch (error) {
        // Crash tails ride along here too, so the error is bounded like any observation.
        return { isError: true, text: boundedObservation({ error: (error instanceof Error ? error.message : "Service operation failed").slice(0, 4096), ...report }, "Service error") };
      }
    },
  };
}
