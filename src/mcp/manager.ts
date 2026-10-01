import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { IMPORT_LABELS, projectDefinitionReview, resolvedSecrets, resolveEnvironment, type MCPConfiguration, type MCPServerDefinition } from "./config";
import type { ConsentState, ConsentStore, RememberResult } from "./consent";
import { definitionIdentity } from "./consent";
import {
  matchPreset, planPins, presetById, presetLine, rememberBlock, type PinPlan, type PresetMatch,
} from "./presets";
import {
  accessCheckTool, accessStatusText, gatesConfirmedOff, parseAccessCheck, READ_ONLY_LOGIN_ENABLE_TEXT, type AccessCheck,
} from "./access";
import { toolLabel } from "../capabilities/labels";
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
  /** Where the definition was found when it came from another tool's file ("~/.claude.json", "VS Code"). */
  importedFrom?: string;
  scope?: MCPServerDefinition["scope"];
  /** Allowed to connect in this process (connected by you, or remembered). */
  approved: boolean;
  /** Remembered approval: none, remembered, or changed since you approved it. */
  consent: ConsentState;
  /** "off": write and delete tools are hidden and the preset's read-only pins are sent. Always "off" at start. */
  writes: "off" | "on";
  /** "login: read-only (checked)", "login: can make changes (checked)" or "access not checked". */
  access: string;
  /** Recognised preset, and the /mcp lines about it. */
  preset?: { id: string; lines: string[] };
  /** Plain show commands on a Junos server run without asking (the user's own opt-in). */
  showOptIn?: boolean;
}

/** What the broker needs to hide tools, guard arguments and word the model's notes, per server. */
export interface ServerPolicy {
  match?: PresetMatch;
  writes: "off" | "on";
  access?: AccessCheck;
  showOptIn: boolean;
}

/** Casper's defaults: 20 s to start, 90 s per call without progress, 10 min for any call. */
export const MCP_LIMITS = { connectMs: 20_000, callMs: 90_000, hardCapMs: 600_000 } as const;

/** The SDK's own request timeout cannot be paused, so it sits far above any call limit: Casper's
 * CallClock owns cancellation through the abort signal (a paused approval prompt must not trip it). */
const SDK_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** A yes/no or pick-one question a server asked during the one call the user approved. */
export interface ServerQuestion {
  server: string;
  /** The MCP tool Casper called (a router such as invoke_tool, or the tool itself). */
  tool: string;
  /** The real tool the user approved (the tool behind a router). */
  realTool: string;
  /** The server's own words, unredacted and up to 16,000 characters: the caller hides secrets, then cuts it. */
  message: string;
  /** The one form field the answer goes into. */
  field: string;
  /** "boolean": a yes answers true. "choice": the answer is one of `options`. */
  kind: "boolean" | "choice";
  options?: string[];
}
/** The user's answer: "accept" with the value, or a refusal. Only the user answers; never the model. */
export type ServerQuestionAnswer = { action: "accept"; value: boolean | string } | { action: "decline" | "cancel" };
export type ServerQuestionHandler = (question: ServerQuestion, signal: AbortSignal) => Promise<ServerQuestionAnswer>;

export interface MCPManagerOptions {
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  hardCapMs?: number;
  /** Shorthand that sets both the start and the call limit (kept for tests and older callers). */
  timeoutMs?: number;
  /**
   * Answers server questions (MCP elicitation). When set, Casper tells servers it can answer
   * questions, but only one asked while exactly one call the user approved is running on that
   * server reaches this handler. Every other question is declined without asking.
   */
  elicit?: ServerQuestionHandler;
  /** One plain line for the user, such as a declined server question. */
  onNote?: (text: string) => void;
  /** Remembered approval. Only your own and imported servers can be remembered, never project ones. */
  consent?: ConsentStore;
}

/** The call the user approved: its server questions may reach the user. */
export interface ApprovedCall {
  capabilityId: string;
  /** The real tool behind a router, or the tool itself. */
  realTool: string;
  label: string;
}

export interface MCPCallOptions {
  /** Receives the call's clock before the request is sent, so an approval or question prompt can pause it. */
  onClock?: (clock: CallClock) => void;
  /** Set only for a call the user said yes (or p) to. */
  approved?: ApprovedCall;
}

/** At most this many server questions are answered during one approved call. */
export const MAX_SERVER_QUESTIONS = 3;

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
  /** Calls sent on this connection that have not finished yet. */
  inFlight: number;
  /** The one call the user approved that is running now, if any. */
  approvedCall?: RunningApprovedCall;
  /** Always "off" at start and after a changed definition; only the user turns it on. */
  writes: "off" | "on";
  consent: ConsentState;
  /** The parsed access_check answer for this connection (never its raw text). */
  access?: AccessCheck;
  /** A preset recognised from the tool list only (the definition did not match). */
  toolPreset?: string;
  /** Whether the tool list fits the preset recognised by the definition. */
  mismatch: boolean;
  /** The pin plan the current connection was started with. */
  pins: PinPlan;
  showOptIn: boolean;
  /** Waiting to restart with pins once the running calls finish. */
  repin?: Promise<void>;
}

interface RunningApprovedCall extends ApprovedCall {
  tool: string;
  client: Client;
  generation: number;
  signal: AbortSignal;
  clock: CallClock;
  questions: number;
}

const MAX_WIRE_BYTES = 8 * 1024 * 1024;

/** Identity of a loaded server: name, start folder and transport, compared key-order-independently.
 * Which file it came from and its time limits are not part of it (changing a timeout is not a
 * different program, so it never revokes consent); preset pins are never in the definition. */
function sameDefinition(a: MCPServerDefinition, b: MCPServerDefinition): boolean {
  return definitionIdentity(a) === definitionIdentity(b) && a.disabled === b.disabled;
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

/**
 * The one form field Casper can answer: a single boolean (yes/no) or a single string enum (pick
 * one). Anything else (several fields, free text, numbers) is not a yes/no question.
 */
function questionShape(schema: unknown): { field: string; kind: "boolean" | "choice"; options?: string[] } | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length !== 1) return undefined;
  const [field, property] = entries[0]!;
  if (!property || typeof property !== "object") return undefined;
  const { type, enum: values, oneOf } = property as { type?: unknown; enum?: unknown; oneOf?: unknown };
  if (type === "boolean") return { field, kind: "boolean" };
  if (type !== "string") return undefined;
  const options = Array.isArray(values) ? values
    : Array.isArray(oneOf) ? oneOf.map((option) => (option as { const?: unknown })?.const) : undefined;
  if (!options?.length || options.length > 10 || !options.every((option) => typeof option === "string" && option.length > 0 && option.length <= 64)) return undefined;
  return { field, kind: "choice", options: options as string[] };
}

function newEntry(definition: MCPServerDefinition, consent?: ConsentStore): Entry {
  const personal = definition.scope !== "project";
  return {
    definition, state: definition.disabled ? "disabled" : "disconnected",
    tools: [], abort: new AbortController(), dirty: false, attempts: [], generation: 0, secrets: [], inFlight: 0,
    // Remembered approval only ever means "connect with writes off"; project servers always ask.
    approved: personal && !definition.disabled && (consent?.has(definition) ?? false),
    consent: personal ? consent?.state(definition) ?? "none" : "none",
    writes: "off", mismatch: false, pins: { kind: "none" }, showOptIn: false,
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
  private readonly elicit?: ServerQuestionHandler;
  private readonly onNote?: (text: string) => void;
  private readonly consent?: ConsentStore;

  constructor(configuration: MCPConfiguration, options: MCPManagerOptions = {}) {
    this.diagnostics = [...configuration.diagnostics, ...options.consent?.diagnostics ?? []];
    this.elicit = options.elicit;
    this.onNote = options.onNote;
    this.consent = options.consent;
    this.defaults = {
      connectMs: options.connectTimeoutMs ?? options.timeoutMs ?? MCP_LIMITS.connectMs,
      callMs: options.callTimeoutMs ?? options.timeoutMs ?? MCP_LIMITS.callMs,
      hardCapMs: options.hardCapMs ?? MCP_LIMITS.hardCapMs,
    };
    for (const definition of configuration.servers) {
      if (this.entries.has(definition.name)) throw new Error("Duplicate MCP server name");
      this.entries.set(definition.name, newEntry(structuredClone(definition), this.consent));
    }
  }

  /** One server's limits: its own connectTimeout/callTimeout over the defaults. The hard cap is never below the call limit. */
  private limits(entry: Entry): { connectMs: number; callMs: number; hardMs: number } {
    // A preset's limits (Junos commits take minutes) come after the server's own and before Casper's.
    const preset = this.match(entry)?.preset.limits;
    const connectMs = entry.definition.limits?.connectMs ?? preset?.connectMs ?? this.defaults.connectMs;
    const callMs = entry.definition.limits?.callMs ?? preset?.callMs ?? this.defaults.callMs;
    return { connectMs, callMs, hardMs: Math.max(this.defaults.hardCapMs, callMs) };
  }

  assertCleanup(): void { if (this.cleanupError) throw this.cleanupError; }

  status(): MCPStatus[] {
    return [...this.entries.values()].map((entry) => {
      const limits = this.limits(entry);
      const output = entry.state === "failed" ? entry.output?.tail(8, entry.secrets) : undefined;
      const match = this.match(entry);
      const importedFrom = entry.definition.importedFrom;
      return {
        name: entry.definition.name, source: entry.definition.source, transport: entry.definition.transport.type,
        state: entry.state, toolCount: entry.tools.length, limits: { connectS: limits.connectMs / 1000, callS: limits.callMs / 1000 },
        error: entry.error, ...(output?.length ? { serverOutput: output } : {}),
        ...(importedFrom ? { importedFrom: IMPORT_LABELS[importedFrom] } : {}),
        ...(entry.definition.scope ? { scope: entry.definition.scope } : {}),
        approved: entry.approved, consent: entry.consent, writes: entry.writes,
        access: entry.state === "ready" ? accessStatusText(entry.access) : "access not checked",
        ...(match ? { preset: { id: match.preset.id, lines: this.presetLines(entry, match) } } : {}),
        ...(entry.showOptIn ? { showOptIn: true } : {}),
      };
    });
  }

  /** The preset for this server: by its definition, else by the tool list it showed. */
  private match(entry: Entry): PresetMatch | undefined {
    const tools = entry.tools.length ? entry.tools : undefined;
    const found = matchPreset(entry.definition, tools);
    if (found) return found;
    const byTools = presetById(entry.toolPreset);
    return byTools ? { preset: byTools, by: "tools", mismatch: false } : undefined;
  }

  private presetLines(entry: Entry, match: PresetMatch): string[] {
    // While writes are on no pins are sent; show what would be pinned only while they are off.
    const plan: PinPlan = entry.writes === "off" ? (entry.state === "ready" ? entry.pins : planPins(entry.definition, match.preset)) : { kind: "none" };
    const lines = presetLine({ ...match, mismatch: entry.mismatch }, plan, gatesConfirmedOff(entry.access));
    return entry.writes === "on" ? lines.filter((line) => !line.startsWith("Can't pin")) : lines;
  }

  /** How the broker must treat this server's tools. */
  policy(server: string): ServerPolicy {
    const entry = this.entries.get(server);
    if (!entry) return { writes: "off", showOptIn: false };
    const match = this.match(entry);
    return { ...(match ? { match } : {}), writes: entry.writes, ...(entry.access ? { access: entry.access } : {}), showOptIn: entry.showOptIn };
  }

  /** A copy of one loaded definition (for the user's own notes; never shown to the model). */
  definition(name: string): MCPServerDefinition { return structuredClone(this.entry(name).definition); }

  /** Servers with writes turned on, for the footer badge. */
  writesOn(): string[] {
    return [...this.entries.values()].filter((entry) => entry.writes === "on").map((entry) => entry.definition.name);
  }

  /** Why this server can't be remembered, or undefined when it can. */
  rememberBlock(name: string): string | undefined {
    const { definition } = this.entry(name);
    if (definition.scope === "project") return `Not remembered: ${definition.name} comes from the project, so Casper asks each time.`;
    if (!this.consent) return "Not remembered: this session can't keep approvals.";
    return rememberBlock(definition, matchPreset(definition));
  }

  /** Remember this server's approval: next time it connects on its own, with writes off. */
  async remember(name: string): Promise<RememberResult> {
    const entry = this.entry(name);
    if (!this.consent) return { remembered: false, reason: "Not remembered: this session can't keep approvals." };
    const result = await this.consent.remember(entry.definition);
    if (result.remembered) entry.consent = "remembered";
    return result;
  }

  /** Drop a remembered approval. The current connection stays until it ends. */
  async forget(name: string): Promise<boolean> {
    if (this.closed) throw new Error("MCP manager is closed");
    // A server no longer in any file can still be forgotten, so re-adding it later asks again.
    const entry = this.entries.get(name);
    const forgotten = await this.consent?.forget(name) ?? false;
    if (entry) entry.consent = "none";
    else if (!forgotten) throw new Error("Unknown MCP server; use /mcp to list definitions");
    return forgotten;
  }

  /** The user's opt-in: plain Junos show commands on this server run without asking. */
  setShowOptIn(name: string, on: boolean): void {
    const entry = this.entry(name);
    if (this.match(entry)?.preset.id !== "junos-mcp-server") throw new Error(`${name} is not a Junos server.`);
    entry.showOptIn = on;
    this.catalogVersion++;
  }

  /**
   * Turn writes on or off for one server. Only the user does this (/mcp writes, ctrl+o). Turning
   * writes off takes effect at once in Casper; a server started without pins is restarted with
   * them once its running calls finish. Turning writes on waits for running calls, then restarts
   * the server without the preset's pins. A read-only login (from access_check) can't turn on.
   */
  /** The product name a person knows the server by ("Mist", "Central"), from its preset; else the server name. */
  productLabel(name: string): string {
    try { return this.match(this.entry(name))?.preset.label ?? name; } catch { return name; }
  }

  async setWrites(name: string, on: boolean): Promise<void> {
    const entry = this.entry(name);
    if (!on) {
      if (entry.writes === "off") return;
      entry.writes = "off";
      this.catalogVersion++;
      await this.repin(entry);
      return;
    }
    if (entry.access?.state === "read-only") throw new Error(READ_ONLY_LOGIN_ENABLE_TEXT);
    if (entry.writes === "on") return;
    await this.idle(entry);
    // A reconnect while waiting may have checked the login again.
    if ((entry.access as AccessCheck | undefined)?.state === "read-only") throw new Error(READ_ONLY_LOGIN_ENABLE_TEXT);
    entry.writes = "on";
    this.catalogVersion++;
    if (entry.pins.kind === "pinned" && (entry.state === "ready" || entry.state === "connecting")) await this.restart(entry);
  }

  /** Restart with the read-only pins once no call is running, if the connection has none. */
  private repin(entry: Entry): Promise<void> {
    if (entry.repin) return entry.repin;
    const match = this.match(entry);
    if (!match || entry.pins.kind === "pinned" || planPins(entry.definition, match.preset).kind !== "pinned") return Promise.resolve();
    if (entry.state !== "ready" && entry.state !== "connecting") return Promise.resolve();
    entry.repin = (async () => {
      await this.idle(entry);
      if (!this.closed && entry.writes === "off" && entry.pins.kind !== "pinned") await this.restart(entry);
    })().catch(() => {}).finally(() => { entry.repin = undefined; });
    return entry.repin;
  }

  private async idle(entry: Entry): Promise<void> {
    while (entry.inFlight > 0 && !this.closed) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  /** Close this connection and, when the server is still approved, open it again. */
  private async restart(entry: Entry): Promise<void> {
    entry.abort.abort();
    await entry.work?.catch(() => {});
    await entry.refresh;
    await this.release(entry);
    this.publish(entry, []);
    entry.state = entry.definition.disabled ? "disabled" : "disconnected";
    entry.error = undefined;
    // Casper restarted it on purpose: that does not spend the reconnect budget.
    entry.attempts = [];
    if (entry.approved) await this.ensureConnected(entry);
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
      // Moving into a project file is a trust change: the repository now owns it, so it needs the review.
      const intoProject = replacement.scope === "project" && entry.definition.scope !== "project";
      if (sameDefinition(entry.definition, replacement) && !intoProject) {
        // Same program from a different file: keep the connection, update the reported source.
        entry.definition.source = replacement.source;
        entry.definition.scope = replacement.scope;
        entry.definition.shadows = replacement.shadows;
        if (replacement.importedFrom) entry.definition.importedFrom = replacement.importedFrom;
        else delete entry.definition.importedFrom;
        entry.consent = replacement.scope === "project" ? "none" : this.consent?.state(replacement) ?? "none";
        // New time limits apply to the next start or call; consent and the connection stay.
        if (replacement.limits) entry.definition.limits = replacement.limits;
        else delete entry.definition.limits;
        continue;
      }
      // Back to a definition you remembered: it connects on its own again (writes off), like at start.
      const remembered = replacement.scope !== "project" && !replacement.disabled && (this.consent?.has(replacement) ?? false);
      if (entry.approved && !remembered) revoked.push(name);
      await this.disconnect(name);
      entry.definition = replacement;
      entry.approved = remembered;
      // A different program starts over: writes off, no opt-ins, and its remembered approval no longer matches.
      entry.writes = "off";
      entry.showOptIn = false;
      entry.toolPreset = undefined;
      entry.access = undefined;
      entry.mismatch = false;
      entry.consent = replacement.scope === "project" ? "none" : this.consent?.state(replacement) ?? "none";
      // A different program deserves a fresh burst budget.
      entry.attempts = [];
      entry.state = replacement.disabled ? "disabled" : "disconnected";
      this.publish(entry, []);
      changed.push(name);
    }
    for (const definition of next.values()) {
      this.entries.set(definition.name, newEntry(definition, this.consent));
      added.push(definition.name);
    }
    this.diagnostics = [...configuration.diagnostics, ...this.consent?.diagnostics ?? []];
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
    const callSignal = AbortSignal.any([...(signal ? [signal] : []), entry.abort.signal, clock.signal]);
    const running: RunningApprovedCall | undefined = options.approved ? {
      ...options.approved, tool: name, client, generation: entry.generation, signal: callSignal, clock, questions: 0,
    } : undefined;
    entry.inFlight++;
    if (running) entry.approvedCall = running;
    try {
      return await client.callTool({ name, arguments: args }, undefined, {
        signal: callSignal,
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
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (running && entry.approvedCall === running) entry.approvedCall = undefined;
      clock.dispose();
    }
  }

  /**
   * A server asked a question (MCP elicitation). MCP does not say which call it belongs to, so it is
   * tied to a call by timing: it reaches the user only while exactly one call is running on this
   * server and that call is one the user approved. Everything else is declined without asking.
   */
  private async serverQuestion(entry: Entry, client: Client, generation: number, params: Record<string, unknown>, requestSignal: AbortSignal): Promise<ServerQuestionAnswer> {
    const server = entry.definition.name;
    const call = entry.approvedCall;
    const decline = (note?: string): ServerQuestionAnswer => {
      if (note && !this.closed) this.onNote?.(`[mcp] ${server} ${note}; declined.`);
      return { action: "decline" };
    };
    if (this.closed || !this.elicit || entry.client !== client || entry.generation !== generation) return decline();
    if (!call || call.client !== client || call.generation !== generation || entry.inFlight !== 1 || call.signal.aborted) {
      return decline("asked a question outside a call you approved");
    }
    if (params.mode === "url" || params.task !== undefined) return decline("asked a question Casper can only answer yes/no");
    if (++call.questions > MAX_SERVER_QUESTIONS) return decline(`asked more than ${MAX_SERVER_QUESTIONS} questions in one call`);
    const shape = questionShape(params.requestedSchema);
    if (!shape) return decline("asked a question Casper can only answer yes/no");
    // Kept long enough that the caller can hide secrets first and cut the shown text after.
    const message = typeof params.message === "string" ? params.message.slice(0, 16_000) : "";
    const question: ServerQuestion = { server, tool: call.tool, realTool: call.realTool, message, ...shape };
    // The user's reading time is not the server's time: hold the call clock while they answer.
    call.clock.pause();
    try {
      const answer = await this.elicit(question, AbortSignal.any([call.signal, entry.abort.signal, requestSignal]));
      if (call.signal.aborted || entry.client !== client) return { action: "cancel" };
      if (answer.action !== "accept") return answer;
      if (shape.kind === "boolean" ? answer.value !== true : !shape.options?.includes(String(answer.value))) return { action: "decline" };
      return { action: "accept", value: answer.value };
    } catch {
      return { action: "cancel" };
    } finally {
      call.clock.resume();
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
    entry.work = (async () => {
      // A server recognised only by its tool list is started once more, with the preset's pins.
      if (await this.open(entry) === "restart-with-pins") await this.open(entry);
    })().finally(() => { entry.work = undefined; });
    return entry.work;
  }

  private async open(entry: Entry): Promise<"restart-with-pins" | void> {
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
    entry.access = undefined;
    // While writes are off, the preset's read-only settings go to the server (env beats the user's own).
    const pinMatch = this.match(entry);
    entry.pins = entry.writes === "off" && pinMatch ? planPins(entry.definition, pinMatch.preset) : { kind: "none" };
    let client: Client | undefined;
    const current = () => !this.closed && entry.approved && entry.client === client && !controller.signal.aborted && entry.state !== "failed";
    try {
      const [{ Client }, { ToolListChangedNotificationSchema, ElicitRequestSchema }] = await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/types.js"),
      ]);
      // Module loading cannot be aborted. Recheck consent/deadline before any
      // client or transport is created, including after the transport import.
      if (!current()) throw new Error("stale connection");
      // Servers learn Casper can answer questions only when someone can answer them (form mode, no URLs).
      const connectedClient = new Client({ name: "casper", version: CASPER_VERSION }, { capabilities: this.elicit ? { elicitation: { form: {} } } : {} });
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
      if (this.elicit) {
        const generation = entry.generation;
        connectedClient.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
          const answer = await this.serverQuestion(entry, connectedClient, generation, request.params as Record<string, unknown>, extra.signal);
          if (answer.action !== "accept") return { action: answer.action };
          const field = questionShape((request.params as Record<string, unknown>).requestedSchema)!.field;
          return { action: "accept", content: { [field]: answer.value } };
        });
      }
      connectedClient.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        if (entry.client !== connectedClient || controller.signal.aborted) return;
        entry.dirty = true;
        if (entry.state === "ready") this.scheduleRefresh(entry, connectedClient);
      });
      const config = entry.pins.kind === "pinned" ? entry.pins.transport : entry.definition.transport;
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
      const match = matchPreset(entry.definition, tools);
      entry.mismatch = match?.mismatch ?? false;
      if (match?.by === "tools") {
        const first = entry.toolPreset !== match.preset.id;
        entry.toolPreset = match.preset.id;
        // Started without pins because the definition did not show what it runs: restart once with them.
        if (first && entry.writes === "off" && entry.pins.kind !== "pinned" && planPins(entry.definition, match.preset).kind === "pinned") {
          clearTimeout(deadline);
          controller.abort();
          await this.release(entry);
          entry.state = "disconnected";
          return "restart-with-pins";
        }
      }
      clearTimeout(deadline);
      // Ask the login what it may do, once per connection, before any tool is shown.
      const accessTool = accessCheckTool(tools, toolLabel);
      if (accessTool) entry.access = await this.checkAccess(entry, client, accessTool.name, controller.signal);
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

  /**
   * Call the server's own read-only access_check once, under the call limit (and never longer
   * than the start limit). Only the parsed answer is kept; any error or odd answer is "not checked".
   */
  private async checkAccess(entry: Entry, client: Client, tool: string, signal: AbortSignal): Promise<AccessCheck | undefined> {
    const { callMs, connectMs } = this.limits(entry);
    try {
      const raw = await client.callTool({ name: tool, arguments: {} }, undefined, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(callMs, connectMs))]), timeout: SDK_REQUEST_TIMEOUT_MS,
      });
      const parsed = parseAccessCheck(raw);
      return parsed.state === "unknown" ? undefined : parsed;
    } catch {
      return undefined;
    }
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
