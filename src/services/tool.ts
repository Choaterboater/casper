import { boundedObservation } from "../capabilities/result";
import type { RuntimeTool } from "../runtime/types";
import type { ServiceSpec } from "./config";
import type { ServiceManager } from "./manager";
import type { SmokeChecks } from "./smoke";
import type { BackgroundCommands } from "../runtime/background-commands";
import { gitGuardReason } from "../runtime/git-guard";
import { gitInternalsCommand, privatePathCommand } from "../platform/project-paths";

const SERVER_WORDS = /\b(?:dev|http|web)[ -]?servers?\b|\blocalhost\b|\bendpoints?\b|\bcurl\b/i;

/** Server vocabulary in the task (or in the plan the person accepted for it), declared services or a live one pull in
 * the service tool; elsewhere it costs no prompt tokens. */
export function serviceRequested(task: string, services: { declared: boolean; live: boolean }, plan?: string): boolean {
  return services.declared || services.live || SERVER_WORDS.test(task) || (plan !== undefined && SERVER_WORDS.test(plan));
}

const LOCAL_SERVER = /\blocalhost\b|\b127\.0\.0\.1\b|\b0\.0\.0\.0\b|\[::1\]|\bhttp\.server\b|\b(?:uvicorn|gunicorn|runserver|nodemon)\b|\bflask\s+run\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|serve|start)\b/i;

/** The AI's own shell command reached a server on this machine or started a common dev server. The service tool then
 * joins the next task (src/app.ts), so a server the AI runs stays up across turns and restarts after edits, instead of
 * dying with its shell call or living in a tmux server a later task may not touch. */
export function reachesLocalServer(command: string): boolean {
  return LOCAL_SERVER.test(command);
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

/** The call that works for `action`, shown in an error so a model that got the shape wrong sends it right next time. */
export function serviceCall(action: string, service?: string): string {
  const call = action === "start" && service === undefined ? { action, command: "npm start" }
    : action === "request" ? { action, service: service ?? "<name>", method: "GET", path: "/" }
    : action === "logs" ? { action, service: service ?? "<name>", lines: 40 }
    : { action, service: service ?? "<name>" };
  return `Call it like this: ${JSON.stringify(call)}`;
}

/** The service a call names: `service`, or `name` or `id` as some models send it. A check's name and a replay's id
 * are their own fields; on a start by command, `name` is the name the AI gives the new service. */
function namedService(args: Record<string, unknown>): unknown {
  if (args.service !== undefined) return args.service;
  if (args.action === "check" || args.action === "replay" || (args.action === "start" && args.command !== undefined)) return undefined;
  return args.name ?? args.id;
}

/** A request's fields nested under `request` (the shape `check` takes), used where the call left them out. */
function flatRequest(args: Record<string, unknown>): Record<string, unknown> {
  const nested = args.request;
  if (args.action !== "request" || !nested || typeof nested !== "object" || Array.isArray(nested)) return args;
  const flat: Record<string, unknown> = { ...args };
  delete flat.request;
  for (const key of ["method", "path", "url", "headers", "body"]) if (flat[key] === undefined && (nested as Record<string, unknown>)[key] !== undefined) flat[key] = (nested as Record<string, unknown>)[key];
  return flat;
}

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
/** `commands`: slow bash commands moved to the background (cmd-1), which status lists and logs and stop take. */
/** `approve`: the same gate the AI's bash has when no sandbox runs (a numbered question), or undefined to start. */
/** `whenSteered`: a line the person sends the AI ends a start's wait for readiness (src/app/steer-waits.ts). */
export function serviceTool(manager: () => ServiceManager, lifetime?: AbortSignal, smoke?: () => SmokeChecks | undefined,
  approve?: (command: string, signal: AbortSignal, options?: { reached?: boolean }) => Promise<string | undefined>,
  commands?: () => BackgroundCommands | undefined, whenSteered?: (end: () => void) => () => void): RuntimeTool {
  const describe = (services: ServiceManager, name: string) => services.status().find(service => service.name === name)!;
  /** The /preview app and public link start only after the person asks (and, for the link, says yes). */
  const allowed = (services: ServiceManager, name: string) => {
    if (services.casperOnly(name)) throw new Error(`${name} is Casper's own: only the person starts it, with /preview`);
    return name;
  };

  const running = (services: ServiceManager) => services.status()
    .filter(service => !services.casperOnly(service.name) && (service.state === "ready" || service.state === "starting"));

  /** The service a call means. None named: the only one there is, or the only one running. A name nobody has: the
   * only one running, said in `note` (not on start, which starts what it names). Otherwise the error shows the call. */
  function choose(services: ServiceManager, given: unknown, action: string): { name: string; note?: string } {
    const names = services.aiNames();
    const live = running(services);
    if (given === undefined) {
      if (names.length === 1) return { name: allowed(services, names[0]!) };
      if (live.length === 1) return { name: live[0]!.name };
      throw new Error(`Name the service: ${names.join(", ") || "none declared or started yet"}. ${serviceCall(names.length ? action : "start", names[0])}`);
    }
    if (typeof given !== "string" || !given) throw new Error(`service must be a service's name. ${serviceCall(action, live[0]?.name ?? names[0])}`);
    const known = services.resolve(given);
    if (known) return { name: allowed(services, known) };
    if (action !== "start" && live.length === 1) return { name: live[0]!.name, note: `No service is named ${JSON.stringify(given)}; this went to ${live[0]!.name}, the only one running.` };
    throw new Error(`No service named ${JSON.stringify(given)}; ${names.length ? `there are: ${names.join(", ")}` : "none is declared or started yet"}. ${serviceCall(names.length ? action : "start", names[0])}`);
  }

  /** A request goes to a managed service's origin (by name and path, or by its URL) or to another loopback URL; nothing else. */
  async function request(services: ServiceManager, args: Record<string, unknown>, signal: AbortSignal) {
    const method = (optional(args.method, "method") ?? "GET").toUpperCase();
    if (!METHODS.includes(method)) throw new Error(`method must be one of ${METHODS.join(", ")}`);
    const given = namedService(args);
    let name: string | undefined, note: string | undefined, url: URL, restarted = false;
    // A url that is only a path ("/api/items") is the path.
    const pathArg = args.path ?? (typeof args.url === "string" && args.url.startsWith("/") ? args.url : undefined);
    const urlArg = pathArg === args.url ? undefined : args.url;
    if (urlArg !== undefined) {
      if (pathArg !== undefined) throw new Error("Give path (with service) or url, not both");
      try { url = new URL(string(urlArg, "url")); } catch { throw new Error("url must be an absolute http://localhost, 127.0.0.1 or [::1] URL"); }
      if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) {
        throw new Error("Requests are limited to Casper's services and loopback http:// URLs (localhost, 127.0.0.1, [::1])");
      }
      const owner = services.status().find(service => service.origin && new URL(service.origin).port === url.port);
      if (given !== undefined) {
        ({ name, note } = choose(services, given, "request"));
        // An old address of the named service (it moved), or another's: the service named is the one meant.
        if (owner?.name !== name) note = [note, `${url.origin} is not ${name}'s address; this went to ${name} at its own.`].filter(Boolean).join(" ");
      } else name = owner && allowed(services, owner.name);
    } else {
      if (pathArg === undefined) {
        const service = given === undefined ? running(services)[0]?.name ?? services.aiNames()[0] : services.resolve(String(given)) ?? String(given);
        throw new Error(`request needs path (or a full loopback url). ${serviceCall("request", service)}`);
      }
      const target = string(pathArg, "path");
      // URL parsing reads a backslash as a slash (`/\host/x` would name a host), so it is refused, not rewritten.
      if (!/^\/(?!\/)[^\\]*$/.test(target)) throw new Error("path must start with a single / and contain no \\ (use url for a full loopback URL)");
      ({ name, note } = choose(services, given, "request"));
      url = new URL(target, "http://127.0.0.1");
    }
    if (name !== undefined) {
      allowed(services, name);
      // Never test stale code: edits since the start (or a crash) restart the service first.
      ({ restarted } = await services.ensureFresh(name, signal));
      const origin = services.origin(name);
      if (!origin) throw new Error(`Service ${name} is not ready. ${serviceCall("logs", name)}`);
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
    const response = await fetch(url, { method, headers: sent, body, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) })
      .catch((error: unknown) => {
        signal.throwIfAborted();
        const reason = error instanceof Error ? error.message.split(". ")[0] : String(error);
        if (!name) throw new Error(`Nothing answered at ${url.origin} (${reason})`);
        const now = services.status().find(service => service.name === name);
        throw new Error(`${name} did not answer at ${url.origin} (${reason}); it is ${now?.state ?? "gone"}${now?.origin && now.origin !== url.origin ? ` at ${now.origin}` : ""}. ${serviceCall("logs", name)}`);
      });
    const { bytes, complete } = await readBody(response);
    const timeMs = Math.round(performance.now() - began);
    const shown = Object.fromEntries(SHOWN_HEADERS.flatMap(header => { const value = response.headers.get(header); return value === null ? [] : [[header, value]]; }));
    return { ...(name ? { service: name } : {}), ...(note ? { note } : {}), method, url: url.href, restarted, status: response.status, statusText: response.statusText,
      headers: shown, otherHeaders: [...response.headers.keys()].filter(header => !SHOWN_HEADERS.includes(header)).length,
      body: showBody(bytes, complete, response.headers.get("content-type") ?? ""), timeMs };
  }

  /** A start or restart waits for readiness. A line the person sends the AI ends the wait, not the start: the service
   * keeps starting, the turn's stop no longer reaches it (as for a slow command in the background), and the call
   * returns now, so the AI reads the line (Pi reads one only once every call of the step has ended). */
  async function unlessSteered<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T | "line"> {
    if (!whenSteered) return work(signal);
    const own = new AbortController();
    const forward = () => own.abort(signal.reason);
    if (signal.aborted) own.abort(signal.reason); else signal.addEventListener("abort", forward, { once: true });
    const line = Promise.withResolvers<"line">();
    const unlisten = whenSteered(() => line.resolve("line"));
    try {
      const working = work(own.signal);
      const first = await Promise.race([working, line.promise]);
      // How it goes on shows in status and logs.
      if (first === "line") working.catch(() => {});
      return first;
    } finally { unlisten(); signal.removeEventListener("abort", forward); }
  }

  async function run(services: ServiceManager, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    // The call's start goes on. A restart that is still stopping the old run shows "starting" a moment later; it says so
    // now, so the AI doesn't take it for stopped and start it a second time.
    const steered = (name: string | undefined) => {
      const service = name ? describe(services, name) : undefined;
      return { ...(service ? { service: service.state === "starting" || service.state === "ready" ? service : { ...service, state: "starting" } } : {}),
        guidance: "The person sent you a message, so this stopped waiting for the service to be ready. It keeps starting: read the message; status or logs show when it is ready." };
    };
    const start = async (name: string) => {
      const fresh = await unlessSteered(inner => services.ensureFresh(name, inner), signal);
      return fresh === "line" ? steered(name) : { restarted: fresh.restarted, service: describe(services, name) };
    };
    const action = args.action;
    const background = commands?.();
    if (action === "status") {
      const running = background?.list() ?? [];
      return { services: services.status().filter(service => !services.casperOnly(service.name)),
        ...(running.length ? { commands: running.map(({ id, command, log }) => ({ id, command, ...(log ? { log } : {}) })) } : {}) };
    }
    const given = namedService(args);
    if (typeof given === "string" && /^cmd-\d+$/.test(given) && (action === "logs" || action === "stop")) {
      const id = given;
      if (!background?.has(id)) throw new Error(`${id} is not running (it ended, or was never started)`);
      if (action === "stop") return { command: id, stopped: await background.stop(id, "model") };
      return { command: id, logs: background.logs(id, Math.min(200, Math.max(1, Number.isInteger(args.lines) ? Number(args.lines) : 40))) };
    }
    if (action === "request") return request(services, flatRequest(args), signal);
    if (action === "check" || action === "replay") {
      const checks = smoke?.();
      if (!checks) throw new Error("Checks are recorded during a task with Casper's verification on");
      const check = action === "check" ? await checks.record({ name: args.name, service: args.service, request: args.request, expect: args.expect }, signal)
        : await checks.replay(string(args.id, "id"), signal);
      return { check, guidance: `Casper replays every recorded check after the change. A check counts as evidence only when it failed before the change and passes after it; one that passed before is an observation.${
        check.baselineAfterEdits ? " This one was recorded after edits in this task, so it is an observation too: record checks before editing." : ""}` };
    }
    if (action === "start" && args.command !== undefined) {
      // service or name next to a command is the name the AI gives it; a declared service starts by its name alone.
      const alias = typeof args.service === "string" ? args.service : typeof args.name === "string" ? args.name : undefined;
      if (alias !== undefined && services.declared(alias)) throw new Error(`${alias} is declared: start it by name alone. ${serviceCall("start", alias)}`);
      const ready = args.ready as Record<string, unknown> | undefined;
      let spec: ServiceSpec["ready"] | undefined;
      if (ready !== undefined) {
        if (typeof ready !== "object" || ready === null || Object.keys(ready).length !== 1) throw new Error("ready must be { http: <path> } or { log: <text> }");
        spec = "http" in ready ? { http: string(ready.http, "ready.http") } : { log: string(ready.log, "ready.log") };
      }
      const timeoutMs = args.timeoutMs === undefined ? undefined : Number(args.timeoutMs);
      const command = string(args.command, "command");
      // An ad-hoc command is the AI's shell too: the same git guard as bash, and the same question when no sandbox runs.
      const refused = gitGuardReason(command) ?? gitInternalsCommand(command, services.root) ?? privatePathCommand(command, { root: services.root }) ?? await approve?.(command, signal);
      if (refused) throw new Error(refused);
      // Joining the same command then takes the declared start's path, so a stale one restarts.
      // The sandbox may fail to start on this very command: then it asks too, before it runs not sandboxed.
      const started = await unlessSteered(launch => services.startCommand(command, { ready: spec, timeoutMs, ...(alias ? { alias } : {}),
        ...(approve ? { approve: (inner: AbortSignal) => approve(command, inner, { reached: true }) } : {}) }, launch), signal);
      // An ad-hoc service is named when its slot is made: found by its command.
      if (started === "line") return steered(services.status().find(service => service.name.startsWith("adhoc-") && service.command === command)?.name);
      return start(started.name);
    }
    if (!["start", "restart", "stop", "logs"].includes(String(action))) throw new Error("action must be start, status, logs, restart, stop, request, check or replay");
    const { name, note } = choose(services, given, String(action));
    const noted = <T extends Record<string, unknown>>(result: T) => note ? { ...result, note } : result;
    if (action === "start") return start(name);
    if (action === "restart") {
      const target = allowed(services, name);
      const restarted = await unlessSteered(inner => services.restart(target, inner), signal);
      return restarted === "line" ? steered(target) : noted({ service: restarted });
    }
    if (action === "stop") { const stopped = await services.stop(name); return noted({ stopped, service: describe(services, name) }); }
    const lines = Math.min(200, Math.max(1, Number.isInteger(args.lines) ? Number(args.lines) : 40));
    const { text, truncated } = services.logs(name, { lines, ...(typeof args.filter === "string" && args.filter ? { filter: args.filter } : {}) });
    return noted({ service: name, logs: text, truncated });
  }

  /** Said once, after the call: a service whose port moved (anything holding the old address is wrong now), and hosts
   * the sandbox kept a service from reaching (its outside calls fail here, which is not the app's fault). */
  function afterCall(services: ServiceManager): Record<string, string> {
    const moved = services.takeMoves().map(({ name, from, to }) =>
      `${name} moved from ${from} to ${to} because its old port was still taken: anything that points at ${from} (config, checks, another service) must use ${to}.`);
    const blocked = services.takeBlocked().map(({ name, hosts }) =>
      `Casper's sandbox kept ${name} from reaching ${hosts.join(", ")} in this run, so the app's calls there fail here. That is not a bug in the app: do not debug it; test those calls against a local stand-in service.`);
    return { ...(moved.length ? { moved: moved.join(" ") } : {}), ...(blocked.length ? { blocked: blocked.join(" ") } : {}) };
  }

  return {
    name: "service",
    description: "Run and observe the project's services (dev servers) in the background under Casper's control; do not background servers with bash. Casper gives each a loopback port (PORT/HOST env), waits until it is ready, keeps its log, restarts it after edits and stops it with the session. start a declared service by name, or an ad-hoc one by command (it must listen on $HOST:$PORT); status; logs (lines, filter); restart; stop. logs and stop also take a slow command's id (service cmd-1). request sends HTTP to a service path or a loopback URL, restarting a stale or crashed service first; nothing else is reachable. Crashes are reported on your next call. For new or changed endpoint behavior, record a check before editing (check: name, service, request { method, path, headers?, body? }, expect { status?, headers?, json? subset, bodyMatches? }); Casper replays it after the change, and replay { id } reruns it.",
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
        return { text: boundedObservation({ ...result, ...report, ...afterCall(services) }, "Service observation") };
      } catch (error) {
        // Crash tails ride along here too, so the error is bounded like any observation.
        return { isError: true, text: boundedObservation({ error: (error instanceof Error ? error.message : "Service operation failed").slice(0, 4096), ...report, ...afterCall(services) }, "Service error") };
      }
    },
  };
}
