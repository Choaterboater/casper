import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolveEnvironment, type MCPConfiguration, type MCPServerDefinition } from "./config";

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
  error?: string;
}

interface Entry {
  definition: MCPServerDefinition;
  state: MCPStatus["state"];
  tools: MCPTool[];
  client?: Client;
  transport?: Transport;
  stdio?: StdioClientTransport;
  abort: AbortController;
  work?: Promise<void>;
  refresh?: Promise<void>;
  releaseWork?: Promise<void>;
  dirty: boolean;
  approved: boolean;
  attempts: number[];
  generation: number;
  error?: string;
}

const MAX_WIRE_BYTES = 8 * 1024 * 1024;

/** Credentials never enter status, error strings, or the capability index. */
export class MCPManager {
  readonly diagnostics: readonly string[];
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  private closeWork?: Promise<void>;
  private readonly timeoutMs: number;
  private catalogVersion = 0;

  constructor(configuration: MCPConfiguration, options: { timeoutMs?: number } = {}) {
    this.diagnostics = configuration.diagnostics;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    for (const definition of configuration.servers) {
      if (this.entries.has(definition.name)) throw new Error("Duplicate MCP server name");
      this.entries.set(definition.name, {
        definition: structuredClone(definition), state: definition.disabled ? "disabled" : "disconnected",
        tools: [], abort: new AbortController(), dirty: false, approved: false, attempts: [], generation: 0,
      });
    }
  }

  status(): MCPStatus[] {
    return [...this.entries.values()].map((entry) => ({
      name: entry.definition.name, source: entry.definition.source, transport: entry.definition.transport.type,
      state: entry.state, toolCount: entry.tools.length, error: entry.error,
    }));
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

  /** Explicit process-local consent to execute/contact this loaded definition. */
  async connect(name: string): Promise<void> {
    const entry = this.entry(name);
    if (entry.state === "disabled") throw new Error("MCP server is disabled; edit configuration and restart");
    entry.approved = true;
    await this.ensureConnected(entry);
  }

  /** Reconnect only previously approved servers, on demand, with a burst cap. */
  async prepare(): Promise<void> {
    if (this.closed) return;
    await Promise.all([...this.entries.values()].filter((e) => e.approved).map(async (entry) => {
      try { await this.ensureConnected(entry); } catch { /* status retains failure */ }
      if (entry.dirty && entry.state === "ready" && entry.client) this.scheduleRefresh(entry, entry.client);
      await entry.refresh;
    }));
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

  async call(server: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const entry = this.entry(server);
    signal?.throwIfAborted();
    if (entry.state !== "ready" || !entry.client || !entry.tools.some((tool) => tool.name === name)) {
      throw new Error("MCP capability is unavailable; reconnect or search again");
    }
    const client = entry.client;
    try {
      // No retry: a lost response does not prove an external action did not run.
      return await client.callTool({ name, arguments: args }, undefined, this.requestOptions(entry, signal));
    } catch {
      const cancelled = signal?.aborted || entry.abort.signal.aborted;
      if (entry.client === client) {
        if (entry.state === "ready") {
          entry.state = "failed";
          this.publish(entry, []);
          entry.error = "Call failed or cancelled; connection will be re-established on demand, without replay";
        }
        // Protocol cancellation alone does not abort the SDK's pending HTTP POST.
        // Invalidate this connection and abort its I/O; never replay its calls.
        await this.release(entry);
      }
      throw new Error(cancelled
        ? "MCP call cancelled; execution may have occurred"
        : "MCP call failed or timed out; execution may have occurred; not retried");
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
    })).then(() => {});
    return this.closeWork;
  }

  private entry(name: string): Entry {
    if (this.closed) throw new Error("MCP manager is closed");
    const entry = this.entries.get(name);
    if (!entry) throw new Error("Unknown MCP server; use /mcp to list definitions");
    return entry;
  }

  private requestOptions(entry: Entry, signal?: AbortSignal) {
    return {
      signal: signal ? AbortSignal.any([signal, entry.abort.signal]) : entry.abort.signal,
      timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs,
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
    const deadline = setTimeout(() => controller.abort(), this.timeoutMs);
    entry.state = "connecting";
    entry.error = undefined;
    entry.attempts.push(Date.now());
    entry.generation++;
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
      const connectedClient = new Client({ name: "casper", version: "0.1.0" }, { capabilities: {} });
      client = connectedClient;
      entry.client = connectedClient;
      connectedClient.onerror = () => { /* Raw transport errors can contain headers/URLs. */ };
      connectedClient.onclose = () => {
        if (!current()) return;
        this.publish(entry, []);
        entry.state = "failed";
        entry.error = "Connection closed; next task may reconnect (bounded)";
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
          cwd: entry.definition.cwd, stderr: "ignore", maxBufferSize: MAX_WIRE_BYTES,
        });
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
      await client.connect(transport, this.requestOptions(entry));
      const tools = await this.listTools(entry, client);
      if (!current()) throw new Error("stale connection");
      entry.state = "ready";
      this.publish(entry, tools);
      if (entry.dirty) this.scheduleRefresh(entry, client);
    } catch {
      if (current()) {
        entry.state = "failed";
        entry.error = "Connection or tool discovery failed (check configuration, environment, and server)";
      } else if (!this.closed && entry.approved) {
        entry.state = "failed";
        entry.error ??= "Connection or tool discovery timed out";
      }
      this.publish(entry, []);
      controller.abort();
      await this.release(entry);
    } finally { clearTimeout(deadline); }
  }

  private async listTools(entry: Entry, client: Client): Promise<MCPTool[]> {
    const tools: MCPTool[] = [];
    const deadline = AbortSignal.timeout(this.timeoutMs);
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
  }

  private release(entry: Entry): Promise<void> {
    if (entry.releaseWork) return entry.releaseWork;
    entry.abort.abort();
    const client = entry.client;
    const transport = entry.transport;
    const pid = entry.stdio?.pid;
    entry.client = undefined;
    entry.transport = undefined;
    entry.stdio = undefined;
    if (client) client.onclose = undefined;
    // The SDK allows 4s before KILL, longer than Casper's 1s CLI exit deadline.
    // Accelerate direct-child cleanup; close() still owns stdin and reaping.
    const kill = (signal: NodeJS.Signals) => { if (pid) try { process.kill(pid, signal); } catch { /* already exited */ } };
    const term = pid ? setTimeout(() => kill("SIGTERM"), 200) : undefined;
    const force = pid ? setTimeout(() => kill("SIGKILL"), 450) : undefined;
    entry.releaseWork = (async () => {
      try { await (client ? client.close() : transport?.close())?.catch(() => {}); }
      finally { clearTimeout(term); clearTimeout(force); }
    })().finally(() => { entry.releaseWork = undefined; });
    return entry.releaseWork;
  }
}
