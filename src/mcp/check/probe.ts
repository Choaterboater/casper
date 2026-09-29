/**
 * Starts a server once for `casper mcp check`, lists its tools and records how it behaved: how long it
 * took, anything it wrote to stdout that is not an MCP message, and the end of its stderr.
 *
 * It uses its own small JSON-RPC client instead of the SDK Client: the SDK rejects a tool list with a
 * broken schema as a whole, and the check needs to grade exactly those schemas. Casper's own list caps
 * (5,000 tools / 8 MiB) are not applied here, so a big catalog can still be graded.
 *
 * The probe only ever sends initialize, notifications/initialized and tools/list. `ProbeConnection.call`
 * exists for the --live step alone, which decides what may be called (see live.ts).
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { osSupportsProcessGroups, ownSpawnedTree, terminateTree, type OwnedProcesses } from "../../platform/processes";
import { CASPER_VERSION } from "../../version";
import { redactServerText, ServerOutput } from "../server-output";
import type { StartDefinition } from "./examples";
import type { CheckTool } from "./labels";
import { SECRET_ENV_NAME } from "./sandbox";

export const PROBE_LIMITS = { maxTools: 20_000, maxBytes: 64 * 1024 * 1024 } as const;
const PROTOCOL_VERSION = "2025-06-18";
const NOISE_LINES = 3;
const NOISE_CHARS = 200;
const STDERR_LINES = 20;

export type ProbeTool = CheckTool & { outputSchema?: unknown };

export interface ProbeResult {
  started: boolean;
  /** Time from start to a full tool list (or to the failure). */
  ms: number;
  serverInfo?: { name?: string; version?: string };
  tools: ProbeTool[];
  /** Non-MCP lines the server wrote to stdout: the first 3, cut to 200 chars, secrets hidden. */
  stdoutNoise: string[];
  /** The last 20 lines of stderr, secrets hidden. */
  stderrTail: string[];
  /** Plain reason when it did not start. */
  error?: string;
  /** The child's pid (stdio only), so a test can prove it is gone. */
  pid?: number;
  /** Kept open only when asked (for --live). Close it when done. */
  connection?: ProbeConnection;
}

export interface ProbeOptions {
  connectMs: number;
  /** The check's environment (offline or live). The definition's own env goes on top. */
  env: NodeJS.ProcessEnv;
  /** False: only loopback HTTP servers may be contacted. */
  live: boolean;
  keepOpen?: boolean;
  maxTools?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** For tests: the fetch used for HTTP servers. */
  fetch?: typeof fetch;
}

/** `${NAME}`, `${NAME:-default}` and VS Code's `${env:NAME}`, resolved against the check's environment. A
 * missing name becomes empty: offline, credentials are removed on purpose. */
export function fillEnvironment(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_whole, name: string, fallback: string | undefined) => {
    const found = env[name];
    return found === undefined || found === "" ? fallback ?? "" : found;
  });
}

/** Whether an HTTP server is on this machine. Offline mode contacts nothing else. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch { return false; }
}

/** stdio transport for the probe: no shell, newline-framed JSON, and stdout lines that are not MCP
 * messages are recorded instead of failing the connection. */
class ProbeStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  readonly noise: string[] = [];
  readonly stderr = new ServerOutput(16 * 1024, 60);
  child?: ChildProcess;
  owner?: OwnedProcesses;
  exitCode?: number | null;
  private buffer = "";
  private bytes = 0;
  private closed = false;

  constructor(private readonly command: string, private readonly args: string[], private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv, private readonly maxBytes: number) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.child = spawn(this.command, this.args, {
        cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
        // Its own process group, so the whole tree (uv -> python) stops with it.
        detached: osSupportsProcessGroups,
      });
      child.once("error", (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        reject(new Error(code === "ENOENT" ? `${this.command} not found` : error.message));
      });
      child.once("spawn", () => {
        this.owner = ownSpawnedTree(child.pid, () => this.alive());
        resolve();
      });
      child.once("exit", (code) => { this.exitCode = code; this.finish(); });
      this.stderr.attach(child.stderr as Readable);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => this.read(chunk));
      child.stdin!.on("error", () => { /* the server went away; exit reports it */ });
    });
  }

  /** Waits (at most 300 ms) until stdout and stderr have delivered everything the server wrote. */
  async drained(): Promise<void> {
    const child = this.child;
    if (!child || this.alive()) return;
    const closed = (stream: Readable | null) => new Promise<void>((resolve) => {
      if (!stream || stream.readableEnded || stream.destroyed) return resolve();
      stream.once("close", () => resolve());
      stream.once("end", () => resolve());
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([closed(child.stdout), closed(child.stderr)]), new Promise((resolve) => { timer = setTimeout(resolve, 300); })]);
    clearTimeout(timer);
  }

  alive(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  private read(chunk: string): void {
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes > this.maxBytes) {
      this.onerror?.(new Error(`sent more than ${Math.round(this.maxBytes / 1024 / 1024)} MiB`));
      void this.close();
      return;
    }
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try { message = JSON.parse(line); } catch { message = undefined; }
    if (typeof message === "object" && message !== null && (message as { jsonrpc?: unknown }).jsonrpc === "2.0") {
      this.onmessage?.(message as JSONRPCMessage);
    } else if (this.noise.length < NOISE_LINES) {
      this.noise.push(line.slice(0, 4 * NOISE_CHARS));
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.alive()) throw new Error("the server is not running");
    this.child!.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  /** Stops the server and everything it started. */
  async close(): Promise<void> {
    const child = this.child;
    if (!child) return this.finish();
    try { child.stdin?.end(); } catch { /* already closed */ }
    if (this.alive() || this.owner) {
      await this.owner?.captureCurrent().catch(() => undefined);
      await terminateTree(this.owner, child.pid, "SIGTERM", () => this.alive()).catch(() => undefined);
      const exited = new Promise<void>((resolve) => {
        if (!this.alive()) return resolve();
        child.once("exit", () => resolve());
      });
      const force = setTimeout(() => { void terminateTree(this.owner, child.pid, "SIGKILL", () => this.alive()).catch(() => undefined); }, 500);
      let give: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exited, new Promise((resolve) => { give = setTimeout(resolve, 2000); })]);
      clearTimeout(force);
      clearTimeout(give);
      // The group may outlive the leader (a grandchild): make sure it is gone too.
      if (osSupportsProcessGroups && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
    }
    this.stderr.detach();
    this.finish();
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** A connected server: tools/list for the probe, tools/call for --live only. */
export class ProbeConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedError?: Error;

  /** Values to hide in anything shown from this server (the credentials it was started with). */
  secrets: readonly string[] = [];

  constructor(readonly transport: Transport) {
    transport.onmessage = (message) => this.receive(message);
    transport.onclose = () => this.fail(new Error("the server closed the connection"));
    transport.onerror = (error) => { if (/MiB/.test(error.message)) this.fail(error); };
  }

  private fail(error: Error): void {
    this.closedError ??= error;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private receive(message: JSONRPCMessage): void {
    const value = message as { id?: unknown; method?: unknown; result?: unknown; error?: { message?: unknown } };
    if (typeof value.method === "string") {
      // A request from the server (ping, roots, questions): only ping is answered; the check asks nobody.
      if (value.id !== undefined) {
        const reply = value.method === "ping"
          ? { jsonrpc: "2.0", id: value.id, result: {} }
          : { jsonrpc: "2.0", id: value.id, error: { code: -32601, message: "Not supported by casper mcp check" } };
        void this.transport.send(reply as JSONRPCMessage).catch(() => undefined);
      }
      return;
    }
    if (typeof value.id !== "number") return;
    const entry = this.pending.get(value.id);
    if (!entry) return;
    this.pending.delete(value.id);
    if (value.error) entry.reject(new Error(typeof value.error.message === "string" ? value.error.message : "error"));
    else entry.resolve(value.result);
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => done(() => reject(new Error("stopped")));
      const done = (settle: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        settle();
      };
      this.pending.set(id, { resolve: (value) => done(() => resolve(value)), reject: (error) => done(() => reject(error)) });
      timer = setTimeout(() => done(() => reject(new TimeoutError())), Math.max(1, timeoutMs));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.transport.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage).catch((error: Error) => done(() => reject(error)));
    });
  }

  notify(method: string): Promise<void> {
    return this.transport.send({ jsonrpc: "2.0", method } as JSONRPCMessage);
  }

  /** --live only: one tools/call. */
  call(name: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, timeoutMs, signal);
  }

  close(): Promise<void> {
    this.fail(new Error("closed"));
    return this.transport.close();
  }
}

class TimeoutError extends Error {
  constructor() { super("timed out"); this.name = "TimeoutError"; }
}

/** The environment a stdio server starts with: the check's environment plus the definition's own env,
 * `${NAME}` filled from the check's environment. Offline, credential-looking names are dropped here too. */
export function serverEnv(definition: Extract<StartDefinition, { type: "stdio" }>, env: NodeJS.ProcessEnv, live: boolean): NodeJS.ProcessEnv {
  const own = Object.fromEntries(Object.entries(definition.env)
    .filter(([name]) => live || !SECRET_ENV_NAME.test(name))
    .map(([name, value]) => [name, fillEnvironment(value, env)]));
  return { ...env, ...own };
}

/** Values to hide in anything the server printed: every value it was given under a credential-looking name. */
function knownSecrets(env: NodeJS.ProcessEnv, definition: StartDefinition): string[] {
  const values = Object.entries(env).filter(([name, value]) => value && SECRET_ENV_NAME.test(name)).map(([, value]) => value!);
  // Only values under credential-looking names: hiding every value would also hide plain paths.
  if (definition.type === "stdio") {
    values.push(...Object.entries(definition.env).filter(([name]) => SECRET_ENV_NAME.test(name)).map(([, value]) => fillEnvironment(value, env)));
  } else {
    values.push(...Object.entries(definition.headers).filter(([name]) => SECRET_ENV_NAME.test(name) || /^(authorization|x-api-key|cookie)$/i.test(name))
      .map(([, value]) => fillEnvironment(value, env).replace(/^(Bearer|Basic|Token)\s+/i, "")));
  }
  return values.filter((value) => value.length >= 4);
}

function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(ms < 10_000 ? 1 : 0))} s`;
}

/** Starts the server, lists every tool and stops it again (unless keepOpen). Never sends tools/call. */
export async function probeServer(definition: StartDefinition, options: ProbeOptions): Promise<ProbeResult> {
  const maxTools = options.maxTools ?? PROBE_LIMITS.maxTools;
  const maxBytes = options.maxBytes ?? PROBE_LIMITS.maxBytes;
  const began = Date.now();
  let transport: Transport;
  let stdio: ProbeStdioTransport | undefined;
  let secrets: string[];
  if (definition.type === "stdio") {
    const env = serverEnv(definition, options.env, options.live);
    secrets = knownSecrets(env, definition);
    transport = stdio = new ProbeStdioTransport(fillEnvironment(definition.command, env), definition.args.map((arg) => fillEnvironment(arg, env)), definition.cwd, env, maxBytes);
  } else {
    secrets = knownSecrets(options.env, definition);
    const url = fillEnvironment(definition.url, options.env);
    if (!options.live && !isLoopbackUrl(url)) {
      return { started: false, ms: 0, tools: [], stdoutNoise: [], stderrTail: [], error: "Remote server: needs --live (offline only contacts localhost)." };
    }
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const baseFetch = options.fetch ?? fetch;
    transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: Object.fromEntries(Object.entries(definition.headers).map(([key, value]) => [key, fillEnvironment(value, options.env)])) },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 500, maxReconnectionDelay: 500, reconnectionDelayGrowFactor: 1 },
      fetch: (target, init) => {
        if (!options.live && !isLoopbackUrl(String(target))) return Promise.reject(new Error("offline: only localhost may be contacted"));
        return baseFetch(target, { ...init, redirect: "error" });
      },
    });
  }
  const connection = new ProbeConnection(transport);
  connection.secrets = secrets;
  const result: ProbeResult = { started: false, ms: 0, tools: [], stdoutNoise: [], stderrTail: [] };
  const deadline = began + options.connectMs;
  const left = () => deadline - Date.now();
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transport.start(),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new TimeoutError()), Math.max(1, left())); }),
      ]);
    } finally { clearTimeout(timer); }
    result.pid = stdio?.child?.pid;
    const init = await connection.request("initialize", {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "casper-mcp-check", version: CASPER_VERSION },
    }, left(), options.signal) as { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown } } | undefined;
    const protocol = typeof init?.protocolVersion === "string" ? init.protocolVersion : PROTOCOL_VERSION;
    (transport as { setProtocolVersion?: (version: string) => void }).setProtocolVersion?.(protocol);
    if (init?.serverInfo) result.serverInfo = { name: String(init.serverInfo.name ?? ""), version: String(init.serverInfo.version ?? "") };
    await connection.notify("notifications/initialized");
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const listed = await connection.request("tools/list", cursor ? { cursor } : {}, left(), options.signal) as { tools?: unknown; nextCursor?: unknown } | undefined;
      const tools = Array.isArray(listed?.tools) ? listed.tools : [];
      for (const tool of tools) {
        if (typeof tool === "object" && tool !== null && typeof (tool as { name?: unknown }).name === "string") result.tools.push(tool as ProbeTool);
      }
      if (result.tools.length > maxTools) throw new Error(`lists more than ${maxTools.toLocaleString("en-US")} tools`);
      cursor = typeof listed?.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : undefined;
      if (!cursor) break;
    }
    result.started = true;
  } catch (error) {
    const exited = stdio !== undefined && stdio.exitCode !== undefined;
    result.error = error instanceof TimeoutError
      ? `Did not start in ${seconds(options.connectMs)}.`
      : exited
        ? `Stopped before it was ready (exit code ${stdio!.exitCode ?? "none"}).`
        : `Did not start: ${redactServerText(error instanceof Error ? error.message : String(error), secrets)}.`;
  }
  result.ms = Date.now() - began;
  // A server that exited may still have its last lines in the pipes.
  await stdio?.drained();
  if (result.started && options.keepOpen) result.connection = connection;
  else await connection.close().catch(() => undefined);
  if (stdio) {
    result.stdoutNoise = stdio.noise.map((line) => redactServerText(line, secrets, NOISE_CHARS));
    result.stderrTail = stdio.stderr.tail(STDERR_LINES, secrets);
  }
  return result;
}
