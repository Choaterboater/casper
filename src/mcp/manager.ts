import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { projectDefinitionReview, resolvedSecrets, resolveEnvironment, type MCPConfiguration, type MCPServerDefinition } from "./config";
import { ownSpawnedTree, type OwnedProcesses, ProcessCleanupError, terminateTree } from "../platform/processes";
import { CASPER_VERSION } from "../version";
import { NotExecutedError, OutcomeUnknownError } from "../capabilities/result";
import { scrubText } from "../secrets/scrub";
import { CallClock } from "./clock";
import { classifyCallError, describeFailure, redactServerText, ServerOutput, stoppedMessage } from "./server-output";

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: { type: "object"; [key: string]: unknown };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [key: string]: unknown };
  _meta?: Record<string, unknown>;
}

export interface MCPStatus {
  name: string;
  source: string;
  transport: "stdio" | "http";
  state: "disconnected" | "connecting" | "ready" | "failed" | "disabled";
  toolCount: number;
  /** The time limits in whole or decimal seconds, as /mcp shows them. */
  limits: { connectS: number; callS: number };
  error?: string;
  /** The server's last stderr lines, redacted, only while the state is "failed". Shown to the user, never to the model. */
  serverOutput?: string[];
}

/** Casper's defaults: 20 s to start, 90 s per call without progress, 10 min for any call. */
export const MCP_LIMITS = { connectMs: 20_000, callMs: 90_000, hardCapMs: 600_000 } as const;

/** The SDK's own request timeout cannot be paused, so it sits far above any call limit: Casper's
 * CallClock owns cancellation through the abort signal (a paused approval prompt must not trip it). */
const SDK_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface MCPManagerOptions {
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  hardCapMs?: number;
  /** Shorthand that sets both the start and the call limit (kept for tests and older callers). */
  timeoutMs?: number;
}

export interface MCPCallOptions {
  /** Receives the call's clock before the request is sent, so an approval or question prompt can pause it. */
  onClock?: (clock: CallClock) => void;
}

interface Entry {
  definition: MCPServerDefinition;
  state: MCPStatus["state"];
  tools: MCPTool[];
  client?: Client;
  transport?: Transport;
  stdio?: StdioClientTransport;
  owner?: OwnedProcesses;
  alive?: () => boolean;
  abort: AbortController;
  work?: Promise<void>;
  refresh?: Promise<void>;
  releaseWork?: Promise<void>;
  dirty: boolean;
  approved: boolean;
  attempts: number[];
  generation: number;
  error?: string;
  /** Last lines of the server's stderr (stdio only), kept across a failed start for /mcp. */
  output?: ServerOutput;
  /** Resolved secret values of this definition, hidden from any server text. */
  secrets: string[];
  /** Exit code of the current child, once it has exited (null when it was killed by a signal). */
  exitCode?: number | null;
  exited?: boolean;
}

const MAX_WIRE_BYTES = 8 * 1024 * 1024;

/** Key-order-independent serialization: reordered env/header maps are the same program. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : item);
}

/** Identity of a loaded server: everything except which file it came from and its time limits
 * (changing a timeout is not a different program, so it never revokes consent). */
function sameDefinition(a: MCPServerDefinition, b: MCPServerDefinition): boolean {
  const { source: _a, scope: _sa, shadows: _ha, limits: _la, ...restA } = a;
  const { source: _b, scope: _sb, shadows: _hb, limits: _lb, ...restB } = b;
  return canonical(restA) === canonical(restB);
}

/** Record the child's exit through the SDK's private `_process` (see stdioChildAlive). */
function watchExit(stdio: StdioClientTransport, onExit: (code: number | null) => void): void {
  const child = (stdio as unknown as { _process?: ChildProcess })._process;
  child?.once("exit", (code) => onExit(code));
}

/** Model-facing call text also goes through the device-config secret scrubber: server error and
 * progress text can carry config lines that the token-shape redaction does not know. */
function modelText(text: string): string {
  return scrubText(text).text;
}

function newEntry(definition: MCPServerDefinition): Entry {
  return {
    definition, state: definition.disabled ? "disabled" : "disconnected",
    tools: [], abort: new AbortController(), dirty: false, approved: false, attempts: [], generation: 0, secrets: [],
  };
}

/** Liveness of the spawned child itself. The SDK's `pid` getter reads `_process`, which
 * `close()` clears synchronously before the child exits, so it cannot prove an exit. The
 * private field is pinned by the simulated-Windows cleanup test. */
function stdioChildAlive(stdio: StdioClientTransport): () => boolean {
  const child = (stdio as unknown as { _process?: ChildProcess })._process;
  // Without the child handle nothing proves the process is still ours: fail closed (no bare-PID kill).
  if (!child) return () => false;
  return () => child.exitCode === null && child.signalCode === null;
}

/** Credentials never enter status, error strings, or the capability index. */
export class MCPManager {
  diagnostics: readonly string[];
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  private closeWork?: Promise<void>;
  private readonly defaults: { connectMs: number; callMs: number; hardCapMs: number };
  private catalogVersion = 0;
  private cleanupError?: ProcessCleanupError;

  constructor(configuration: MCPConfiguration, options: MCPManagerOptions = {}) {
    this.diagnostics = configuration.diagnostics;
    this.defaults = {
      connectMs: options.connectTimeoutMs ?? options.timeoutMs ?? MCP_LIMITS.connectMs,
      callMs: options.callTimeoutMs ?? options.timeoutMs ?? MCP_LIMITS.callMs,
      hardCapMs: options.hardCapMs ?? MCP_LIMITS.hardCapMs,
    };
    for (const definition of configuration.servers) {
      if (this.entries.has(definition.name)) throw new Error("Duplicate MCP server name");
      this.entries.set(definition.name, newEntry(structuredClone(definition)));
    }
  }

  /** One server's limits: its own connectTimeout/callTimeout over the defaults. The hard cap is never below the call limit. */
  private limits(entry: Entry): { connectMs: number; callMs: number; hardMs: number } {
    const connectMs = entry.definition.limits?.connectMs ?? this.defaults.connectMs;
    const callMs = entry.definition.limits?.callMs ?? this.defaults.callMs;
    return { connectMs, callMs, hardMs: Math.max(this.defaults.hardCapMs, callMs) };
  }

  assertCleanup(): void { if (this.cleanupError) throw this.cleanupError; }

  status(): MCPStatus[] {
    return [...this.entries.values()].map((entry) => {
      const limits = this.limits(entry);
      const output = entry.state === "failed" ? entry.output?.tail(8, entry.secrets) : undefined;
      return {
        name: entry.definition.name, source: entry.definition.source, transport: entry.definition.transport.type,
        state: entry.state, toolCount: entry.tools.length, limits: { connectS: limits.connectMs / 1000, callS: limits.callMs / 1000 },
        error: entry.error, ...(output?.length ? { serverOutput: output } : {}),
      };
    });
  }

  /** Changes whenever routable metadata or connection identity changes. */
  get catalogRevision(): number { return this.catalogVersion; }

  catalog(): { server: string; generation: number; tools: MCPTool[] }[] {
    return [...this.entries.values()].filter((e) => e.state === "ready")
      .map((e) => ({ server: e.definition.name, generation: e.generation, tools: structuredClone(e.tools) }));
  }

  private publish(entry: Entry, tools: MCPTool[]): void {
    entry.tools = tools;
    this.catalogVersion++;
  }

  /** Review needed before consenting to a project-scope definition; undefined for user/profile ones. */
  review(name: string): { source: string; shadows?: string; preview: string } | undefined {
    const entry = this.entry(name);
    const { definition } = entry;
    // Already-consented live connections and disabled entries have nothing new to approve.
    const preview = definition.disabled || (entry.approved && entry.state === "ready") ? undefined : projectDefinitionReview(definition);
    return preview ? { source: definition.source, shadows: definition.shadows, preview } : undefined;
  }

  /** Explicit process-local consent to execute/contact this loaded definition. */
  async connect(name: string): Promise<void> {
    this.assertCleanup();
    const entry = this.entry(name);
    if (entry.state === "disabled") throw new Error("MCP server is disabled; edit configuration and restart");
    entry.approved = true;
    // The burst cap limits automatic reconnects; an explicit connect is fresh consent to try.
    entry.attempts = [];
    await this.ensureConnected(entry);
  }

  /** Reconnect only previously approved servers, on demand, with a burst cap. */
  async prepare(): Promise<void> {
    this.assertCleanup();
    if (this.closed) return;
    await Promise.all([...this.entries.values()].filter((e) => e.approved).map(async (entry) => {
      try { await this.ensureConnected(entry); } catch { /* status retains failure */ }
      if (entry.dirty && entry.state === "ready" && entry.client) this.scheduleRefresh(entry, entry.client);
      await entry.refresh;
    }));
    this.assertCleanup();
  }

  async disconnect(name: string): Promise<void> {
    const entry = this.entry(name);
    entry.approved = false;
    entry.abort.abort();
    this.publish(entry, []);
    entry.state = entry.definition.disabled ? "disabled" : "disconnected";
    entry.error = undefined;
    await this.release(entry);
    await entry.work;
    await entry.refresh;
  }

  /** Re-read configuration: add new servers, drop removed ones, and replace changed
   * definitions (a changed command/url is a different program, so its consent resets and
   * it reconnects only via an explicit /mcp connect). Unchanged approved servers keep
   * their connection. Returns the diff for the command report; `revoked` lists the changed
   * servers that actually held consent. */
  async reload(configuration: MCPConfiguration): Promise<{ added: string[]; removed: string[]; changed: string[]; revoked: string[] }> {
    this.assertCleanup();
    const next = new Map<string, MCPServerDefinition>();
    for (const definition of configuration.servers) {
      if (next.has(definition.name)) throw new Error("Duplicate MCP server name in reloaded configuration");
      next.set(definition.name, structuredClone(definition));
    }
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    const revoked: string[] = [];
    for (const [name, entry] of this.entries) {
      const replacement = next.get(name);
      next.delete(name);
      if (!replacement) {
        await this.disconnect(name);
        this.entries.delete(name);
        removed.push(name);
        continue;
      }
      if (sameDefinition(entry.definition, replacement)) {
        // Same program from a different file: keep the connection, update the reported source.
        entry.definition.source = replacement.source;
        entry.definition.scope = replacement.scope;
        entry.definition.shadows = replacement.shadows;
        // New time limits apply to the next start or call; consent and the connection stay.
        if (replacement.limits) entry.definition.limits = replacement.limits;
        else delete entry.definition.limits;
        continue;
      }
      if (entry.approved) revoked.push(name);
      await this.disconnect(name);
      entry.definition = replacement;
      entry.approved = false;
      // A different program deserves a fresh burst budget.
      entry.attempts = [];
      entry.state = replacement.disabled ? "disabled" : "disconnected";
      this.publish(entry, []);
      changed.push(name);
    }
    for (const definition of next.values()) {
      this.entries.set(definition.name, newEntry(definition));
      added.push(definition.name);
    }
    this.diagnostics = configuration.diagnostics;
    await this.prepare();
    return { added, removed, changed, revoked };
  }

  /**
   * Call one tool. Nothing is retried: a lost answer does not prove an action did not run.
   *
   * Throws NotExecutedError when nothing was sent, and OutcomeUnknownError when the call was sent but
   * did not finish cleanly. A JSON-RPC error answer from the server keeps the connection; a timeout,
   * cancel or lost connection releases it (the next task reconnects, within the retry budget).
   */
  async call(server: string, name: string, args: Record<string, unknown>, signal?: AbortSignal, options: MCPCallOptions = {}): Promise<unknown> {
    let entry: Entry;
    try {
      this.assertCleanup();
      entry = this.entry(server);
    } catch {
      throw new NotExecutedError("server not connected");
    }
    if (signal?.aborted) throw new NotExecutedError("cancelled");
    if (entry.state !== "ready" || !entry.client) throw new NotExecutedError("server not connected");
    if (!entry.tools.some((tool) => tool.name === name)) throw new NotExecutedError("tool changed; search again");
    const client = entry.client;
    const limits = this.limits(entry);
    const clock = new CallClock(limits.callMs, limits.hardMs);
    const context = { phase: "call" as const, server, secrets: entry.secrets, idleMs: limits.callMs, hardMs: limits.hardMs, scrub: modelText };
    try {
      options.onClock?.(clock);
    } catch {
      // Nothing was sent yet: a failing hook must not look like a lost call or cost the connection.
      clock.dispose();
      throw new NotExecutedError("could not prepare the call");
    }
    try {
      return await client.callTool({ name, arguments: args }, undefined, {
        signal: AbortSignal.any([...(signal ? [signal] : []), entry.abort.signal, clock.signal]),
        timeout: SDK_REQUEST_TIMEOUT_MS,
        // Passing onprogress makes the SDK send a progress token; each message restarts the idle timer.
        onprogress: (progress) => {
          const message = typeof progress.message === "string" ? progress.message.slice(0, 1000) : undefined;
          clock.progress(message === undefined ? undefined : redactServerText(message, entry.secrets, 1000));
        },
      });
    } catch (error) {
      const kind = classifyCallError(error);
      if (kind === "not-sent") throw new NotExecutedError("the tool needs a mode Casper does not support");
      if (kind === "server-answered") {
        // The server answered: the connection is fine and stays ready (and nothing is released).
        throw new OutcomeUnknownError(modelText(describeFailure(error, context)));
      }
      const cancelled = !clock.reason() && (signal?.aborted || entry.abort.signal.aborted);
      if (entry.client === client) {
        if (entry.state === "ready") {
          // A failing call spends the automatic-reconnect budget once (onclose already counted a
          // server-side close, which leaves the state "failed"); a caller's cancellation does not.
          if (!cancelled && !this.closed && entry.approved) entry.attempts.push(Date.now());
          entry.state = "failed";
          this.publish(entry, []);
          entry.error = "The last call did not finish. The next task reconnects; the call is not repeated.";
        }
        // Protocol cancellation alone does not abort the SDK's pending HTTP POST.
        // Invalidate this connection and abort its I/O; never replay its calls.
        await this.release(entry);
      }
      throw new OutcomeUnknownError(modelText(describeFailure(error, {
        ...context, clockReason: clock.reason(), lastProgress: clock.lastProgress, cancelled: Boolean(cancelled),
        exited: entry.exited, exitCode: entry.exitCode,
      })));
    } finally {
      clock.dispose();
    }
  }

  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closed = true;
    // Abort before awaiting anything, including a pending handshake.
    for (const entry of this.entries.values()) {
      entry.approved = false;
      entry.abort.abort();
      entry.state = "disconnected";
      this.publish(entry, []);
    }
    this.closeWork = Promise.all([...this.entries.values()].map(async (entry) => {
      await this.release(entry);
      await entry.work;
      await entry.refresh;
    })).then(() => { this.assertCleanup(); });
    return this.closeWork;
  }

  private entry(name: string): Entry {
    if (this.closed) throw new Error("MCP manager is closed");
    const entry = this.entries.get(name);
    if (!entry) throw new Error("Unknown MCP server; use /mcp to list definitions");
    return entry;
  }

  /** Options for starting and listing tools: bounded by the server's start limit. */
  private requestOptions(entry: Entry, signal?: AbortSignal) {
    const { connectMs } = this.limits(entry);
    return {
      signal: signal ? AbortSignal.any([signal, entry.abort.signal]) : entry.abort.signal,
      timeout: connectMs, maxTotalTimeout: connectMs,
    };
  }

  private async ensureConnected(entry: Entry): Promise<void> {
    if (this.closed || !entry.approved) return;
    if (entry.work) return entry.work;
    if (entry.state === "ready") return;
    entry.attempts = entry.attempts.filter((time) => Date.now() - time < 30_000);
    if (entry.attempts.length >= 2) {
      entry.error = "Connection retry limit reached; retry after 30 seconds";
      return;
    }
    entry.work = this.open(entry).finally(() => { entry.work = undefined; });
    return entry.work;
  }

  private async open(entry: Entry): Promise<void> {
    await this.release(entry);
    if (this.closed || !entry.approved) return;
    entry.abort = new AbortController();
    const controller = entry.abort;
    const { connectMs } = this.limits(entry);
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, connectMs);
    entry.state = "connecting";
    entry.error = undefined;
    entry.generation++;
    entry.exited = false;
    entry.exitCode = undefined;
    entry.output = undefined;
    entry.secrets = resolvedSecrets(entry.definition);
    let client: Client | undefined;
    const current = () => !this.closed && entry.approved && entry.client === client && !controller.signal.aborted && entry.state !== "failed";
    try {
      const [{ Client }, { ToolListChangedNotificationSchema }] = await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/types.js"),
      ]);
      // Module loading cannot be aborted. Recheck consent/deadline before any
      // client or transport is created, including after the transport import.
      if (!current()) throw new Error("stale connection");
      const connectedClient = new Client({ name: "casper", version: CASPER_VERSION }, { capabilities: {} });
      client = connectedClient;
      entry.client = connectedClient;
      connectedClient.onerror = () => { /* Raw transport errors can contain headers/URLs. */ };
      connectedClient.onclose = () => {
        // While starting, the pending handshake or tool list fails too; the catch below describes it.
        if (!current() || entry.state === "connecting") return;
        // A server that handshakes and then dies must not respawn on every task.
        if (!this.closed && entry.approved) entry.attempts.push(Date.now());
        this.publish(entry, []);
        entry.state = "failed";
        entry.error = stoppedMessage(entry.exited ? entry.exitCode : undefined);
      };
      connectedClient.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        if (entry.client !== connectedClient || controller.signal.aborted) return;
        entry.dirty = true;
        if (entry.state === "ready") this.scheduleRefresh(entry, connectedClient);
      });
      const config = entry.definition.transport;
      let transport: Transport;
      if (config.type === "stdio") {
        const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
        if (!current()) throw new Error("stale connection");
        transport = entry.stdio = new StdioClientTransport({
          command: resolveEnvironment(config.command), args: config.args.map(resolveEnvironment),
          env: Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, resolveEnvironment(v)])),
          cwd: entry.definition.cwd, stderr: "pipe", maxBufferSize: MAX_WIRE_BYTES,
        });
        // Attached before start: the pipe always drains, so a chatty server never blocks on stderr.
        entry.output = new ServerOutput().attach(entry.stdio.stderr as Readable | null);
      } else {
        const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
        if (!current()) throw new Error("stale connection");
        transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: Object.fromEntries(Object.entries(config.headers).map(([k, v]) => [k, resolveEnvironment(v)])) },
          reconnectionOptions: { maxRetries: 2, initialReconnectionDelay: 500, maxReconnectionDelay: 2000, reconnectionDelayGrowFactor: 2 },
          fetch: async (url, init) => {
            const response = await fetch(url, {
              ...init, redirect: "error",
              signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
            });
            if (!response.body) return response;
            let bytes = 0;
            const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, stream) {
                bytes += chunk.byteLength;
                if (bytes > MAX_WIRE_BYTES) throw new Error("MCP response exceeds wire budget");
                stream.enqueue(chunk);
              },
            }));
            return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
          },
        });
      }
      entry.transport = transport;
      if (entry.stdio) {
        const stdio = entry.stdio;
        const start = stdio.start.bind(stdio);
        stdio.start = async () => {
          await start();
          const generation = entry.generation;
          // The child's "exit" comes before the SDK's "close" (onclose), so failure text can name the code.
          watchExit(stdio, (code) => { if (entry.generation === generation) { entry.exited = true; entry.exitCode = code; } });
          const pid = stdio.pid;
          // Own the child before the protocol handshake, which can fail or stall.
          entry.alive = stdioChildAlive(stdio);
          entry.owner = ownSpawnedTree(pid, entry.alive);
          await entry.owner?.capture();
        };
      }
      await client.connect(transport, this.requestOptions(entry));
      const tools = await this.listTools(entry, client);
      if (!current()) throw new Error("stale connection");
      entry.state = "ready";
      this.publish(entry, tools);
      if (entry.dirty) this.scheduleRefresh(entry, client);
    } catch (error) {
      if (!this.closed && entry.approved) {
        entry.state = "failed";
        entry.error = describeFailure(error, {
          phase: "start", secrets: entry.secrets,
          command: entry.definition.transport.type === "stdio" ? entry.definition.transport.command : undefined,
          connectMs, timedOut, exited: entry.exited, exitCode: entry.exitCode,
        });
      }
      // Failed opens, server-side closes and failed calls spend the burst budget; a
      // reconnect after a cancelled call, or an open abandoned by disconnect/close, does not.
      if (!this.closed && entry.approved) entry.attempts.push(Date.now());
      this.publish(entry, []);
      controller.abort();
      await this.release(entry);
    } finally { clearTimeout(deadline); }
  }

  private async listTools(entry: Entry, client: Client): Promise<MCPTool[]> {
    const tools: MCPTool[] = [];
    const deadline = AbortSignal.timeout(this.limits(entry).connectMs);
    const cursors = new Set<string>();
    let catalogBytes = 0;
    const names = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, this.requestOptions(entry, deadline));
      for (const tool of page.tools) {
        catalogBytes += Buffer.byteLength(JSON.stringify(tool));
        if (catalogBytes > MAX_WIRE_BYTES) throw new Error("Catalog exceeds 8 MB budget");
        if (names.has(tool.name) || tool.name.length > 256 || tools.length >= 5000) throw new Error("Invalid catalog");
        names.add(tool.name);
        tools.push(tool);
      }
      cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error("Invalid pagination");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return tools;
  }

  private scheduleRefresh(entry: Entry, client: Client): void {
    if (entry.refresh) return;
    entry.refresh = (async () => {
      // Coalesce storms; a still-dirty catalog is refreshed on the next prepare.
      for (let round = 0; round < 2 && entry.dirty && entry.client === client && entry.state === "ready"; round++) {
        entry.dirty = false;
        try {
          const tools = await this.listTools(entry, client);
          if (entry.client === client && !entry.abort.signal.aborted && entry.state === "ready") this.publish(entry, tools);
        } catch {
          if (entry.client === client && entry.state === "ready") {
            this.publish(entry, []);
            entry.state = "failed";
            entry.error = "Tool refresh failed; stale tools removed";
            // Like failed calls, timed-out discovery must abort pending HTTP I/O.
            await this.release(entry);
          }
        }
      }
    })().finally(() => { entry.refresh = undefined; });
    // A list-change notification can start this work without a waiting caller.
    // Cleanup errors remain latched on the manager for status/prepare/reconnect.
    void entry.refresh.catch(() => {});
  }

  private release(entry: Entry): Promise<void> {
    if (entry.releaseWork) return entry.releaseWork;
    entry.abort.abort();
    const client = entry.client;
    const transport = entry.transport;
    const pid = entry.stdio?.pid;
    const owner = entry.owner;
    const alive = entry.alive;
    entry.client = undefined;
    entry.transport = undefined;
    entry.stdio = undefined;
    entry.owner = undefined;
    entry.alive = undefined;
    if (client) client.onclose = undefined;
    // The SDK allows 4s before KILL, longer than Casper's 1s CLI exit deadline.
    // Accelerate cleanup of this exact tree; close() still owns stdin and reaping.
    entry.releaseWork = (async () => {
      await owner?.captureCurrent();
      const ownedStop = owner ? terminateTree(owner, pid, "SIGTERM") : undefined;
      // SDK children are not group leaders: POSIX reaches them only by liveness-gated PID.
      const kill = (signal: NodeJS.Signals) => { void terminateTree(owner, pid, signal, alive); };
      const term = pid ? setTimeout(() => kill("SIGTERM"), 200) : undefined;
      const force = pid ? setTimeout(() => kill("SIGKILL"), 450) : undefined;
      try { await (client ? client.close() : transport?.close())?.catch(() => {}); }
      finally { clearTimeout(term); clearTimeout(force); }
      if (await ownedStop === "unknown") {
        this.cleanupError = new ProcessCleanupError();
        entry.error = this.cleanupError.message;
        entry.state = "failed"; entry.approved = false;
        throw this.cleanupError;
      }
    })().finally(() => { entry.releaseWork = undefined; });
    return entry.releaseWork;
  }
}
