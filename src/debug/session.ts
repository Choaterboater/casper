import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { formatTerminalJSON } from "../tui/json";
import { lines, projectFile, readTargets, record, resolveTarget, type DebugTarget } from "./config";
import { DAPConnection } from "./protocol";

export interface DebugOptions {
  projectRoot: string;
  confirm(preview: string, signal: AbortSignal): Promise<boolean>;
}
export type DebugRequest =
  | { action: "start"; target: string }
  | { action: "breakpoints"; path: string; lines: number[] }
  | { action: "threads" }
  | { action: "stack" | "continue"; threadId: number }
  | { action: "scopes"; frame: string }
  | { action: "variables"; reference: string };
export interface DebugResult { items?: Record<string, unknown>[]; truncated?: boolean; [key: string]: unknown }
type State = "idle" | "starting" | "running" | "stopped" | "closing" | "closed" | "failed";
const id = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) < 2 ** 31;
const text = (value: unknown, length = 256) => typeof value === "string" ? value.slice(0, length) : "";

/** Owns launch consent, stop-scoped inspection, protocol lifetime and subprocess cleanup. */
export class DebugSession {
  private readonly lifetime = new AbortController();
  private readonly prefix = randomUUID();
  private state: State = "idle";
  private connection?: DAPConnection;
  private target?: DebugTarget;
  private root?: string;
  private home?: string;
  private work?: Promise<DebugResult>;
  private closeWork?: Promise<void>;
  private cleanupWork?: Promise<void>;
  private operations = 0;
  private epoch = 0;
  private nextHandle = 0;
  private readonly frames = new Map<string, number>();
  private readonly variables = new Map<string, number>();
  private readonly threads = new Set<number>();
  private stoppedThread?: number;
  private allStopped = false;
  private stopReason?: string;
  private exitCode?: number;
  private cleanupOutcome?: "stopped" | "unknown";

  constructor(private readonly options: DebugOptions) {}
  status() {
    return { state: this.state, target: this.target?.name, ownedAdapterPid: this.connection?.pid,
      stoppedThread: this.state === "stopped" ? this.stoppedThread : undefined,
      reason: this.state === "stopped" ? this.stopReason : undefined,
      debuggeeExit: this.exitCode === undefined ? "unknown" : "adapter-reported", exitCode: this.exitCode,
      ownedProcessCleanup: this.cleanupOutcome, guidance: "Debug observations are not verification. Values may contain secrets." };
  }
  async targets(): Promise<string[]> { return Object.keys((await readTargets(this.options.projectRoot)).targets); }

  run(request: DebugRequest, caller?: AbortSignal): Promise<DebugResult> {
    if (this.work) return Promise.reject(new Error("Debugger operation already active"));
    if (this.lifetime.signal.aborted) return Promise.reject(new Error("Debugger session closed"));
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 15_000);
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal, ...(caller ? [caller] : [])]);
    this.work = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      if (++this.operations > 256) { await this.cleanup(); this.state = "failed"; throw new Error("Debugger operation budget exceeded"); }
      const result = await this.execute(request, signal);
      await this.connection?.captureProcesses();
      return this.bound(result);
    }).catch(async error => {
      if (signal.aborted) { await this.cleanup(); if (this.state !== "failed") this.state = "closed"; throw new Error("Debugger operation cancelled or timed out"); }
      throw error;
    }).finally(() => { clearTimeout(timer); this.work = undefined; });
    return this.work;
  }
  private bound(result: DebugResult): DebugResult {
    while (Buffer.byteLength(formatTerminalJSON(result)) > 16_384 && result.items?.length) {
      result.items.pop(); result.truncated = true;
    }
    if (Buffer.byteLength(formatTerminalJSON(result)) > 16_384) return { truncated: true, state: this.state };
    return result;
  }
  private invalidate(): void { this.epoch++; this.frames.clear(); this.variables.clear(); }
  private handle(kind: "frame" | "variable", value: unknown): string | undefined {
    if (!id(value) || (kind === "variable" && value === 0)) return undefined;
    const table = kind === "frame" ? this.frames : this.variables;
    if (table.size >= 2048) throw new Error("Debugger handle budget exceeded");
    const handle = `${this.prefix}:${kind === "frame" ? "f" : "v"}${++this.nextHandle}`;
    table.set(handle, value); return handle;
  }
  private requireStop(): void { if (this.state !== "stopped") throw new Error("Debugger is not stopped"); }
  private requireThread(thread: number): void {
    this.requireStop();
    if (!id(thread) || !this.threads.has(thread) || (!this.allStopped && this.stoppedThread !== thread)) throw new Error("Unknown or running debugger thread");
  }
  private async request(command: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const result = await this.connection!.request(command, args, signal);
      if (!record(result)) throw new Error("Invalid body");
      return result;
    } catch {
      this.state = "failed"; await this.cleanup();
      throw new Error("Debugger request failed, cancelled or timed out; session closed");
    }
  }
  private array(body: Record<string, unknown>, key: string): Record<string, unknown>[] {
    const values = body[key];
    if (!Array.isArray(values) || values.some(value => !record(value))) throw new Error("Invalid debugger inspection response");
    return values;
  }
  private async execute(request: DebugRequest, signal: AbortSignal): Promise<DebugResult> {
    if (request.action === "start") return this.start(request.target, signal);
    if (!this.connection?.alive || !["running", "stopped"].includes(this.state)) throw new Error("Debugger is not active");
    if (request.action === "breakpoints") {
      if (!lines(request.lines)) throw new Error("Invalid debugger breakpoint lines");
      const source = await projectFile(this.root!, request.path);
      const definitions = { ...this.target!.breakpoints, [source]: request.lines };
      if (Object.keys(definitions).length > 32 || Object.values(definitions).reduce((n, value) => n + value.length, 0) > 128) throw new Error("Debugger breakpoint budget exceeded");
      const result = await this.setBreakpoints(source, request.lines, signal);
      this.target!.breakpoints = definitions;
      return result;
    }
    if (request.action === "threads") {
      const epoch = this.epoch;
      const items = this.array(await this.request("threads", {}, signal), "threads");
      if (epoch !== this.epoch) throw new Error("Debugger state changed during inspection; retry");
      this.threads.clear();
      return { items: items.slice(0, 32).filter(item => id(item.id)).map(item => {
        this.threads.add(Number(item.id)); return { id: item.id, name: text(item.name) };
      }), truncated: items.length > 32 };
    }
    if (request.action === "continue") {
      this.requireThread(request.threadId);
      this.state = "running"; this.invalidate();
      await this.request("continue", { threadId: request.threadId }, signal);
      return this.status();
    }
    this.requireStop();
    const epoch = this.epoch;
    let body: Record<string, unknown>;
    if (request.action === "stack") {
      this.requireThread(request.threadId);
      body = await this.request("stackTrace", { threadId: request.threadId, startFrame: 0, levels: 32 }, signal);
    } else if (request.action === "scopes") {
      const frameId = this.frames.get(request.frame);
      if (frameId === undefined) throw new Error("Invalid or expired debugger frame handle");
      body = await this.request("scopes", { frameId }, signal);
    } else if (request.action === "variables") {
      const variablesReference = this.variables.get(request.reference);
      if (variablesReference === undefined) throw new Error("Invalid or expired debugger variable handle");
      body = await this.request("variables", { variablesReference, start: 0, count: 64 }, signal);
    } else throw new Error("Unsupported debugger action");
    if (this.state !== "stopped" || this.epoch !== epoch) throw new Error("Debugger stop changed during inspection; handles expired");
    const key = request.action === "stack" ? "stackFrames" : request.action === "scopes" ? "scopes" : "variables";
    const limit = request.action === "stack" ? 32 : request.action === "scopes" ? 16 : 64;
    const items = this.array(body, key);
    return { items: items.slice(0, limit).map(item => request.action === "stack" ? {
      handle: this.handle("frame", item.id), name: text(item.name), line: id(item.line) ? item.line : undefined,
      path: record(item.source) ? text(item.source.path, 1024) : undefined,
    } : { handle: this.handle("variable", item.variablesReference), name: text(item.name),
      ...(request.action === "variables" ? { value: text(item.value, 2048), type: text(item.type) } : { expensive: item.expensive === true }) }),
      truncated: items.length > limit || (request.action === "stack" && Number(body.totalFrames) > items.length) || items.some(item =>
        (typeof item.name === "string" && item.name.length > 256) || (typeof item.type === "string" && item.type.length > 256) ||
        (typeof item.value === "string" && item.value.length > 2048) || (record(item.source) && typeof item.source.path === "string" && item.source.path.length > 1024)) };
  }
  private async setBreakpoints(source: string, values: number[], signal: AbortSignal): Promise<DebugResult> {
    const items = this.array(await this.request("setBreakpoints", { source: { path: source }, breakpoints: values.map(line => ({ line })) }, signal), "breakpoints");
    return { items: items.slice(0, 128).map(item => ({ verified: item.verified === true, line: id(item.line) ? item.line : undefined })), truncated: items.length > 128 };
  }
  private async start(name: string, signal: AbortSignal): Promise<DebugResult> {
    if (this.state !== "idle") throw new Error("Stop the existing debugger before starting another");
    this.root = await realpath(this.options.projectRoot);
    const target = await resolveTarget(this.root, name);
    const preview = formatTerminalJSON({ ...target, stopOnEntry: true, environment: "temporary HOME; allowlisted environment; no inherited provider credentials" });
    if (Buffer.byteLength(preview) > 16_384) throw new Error("Debugger approval preview exceeds 16 KiB; simplify the target");
    const allowed = await new Promise<boolean>((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Debugger approval cancelled")); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      Promise.resolve().then(() => this.options.confirm(preview, signal)).then(answer => {
        signal.removeEventListener("abort", abort); resolve(answer && !signal.aborted);
      }, () => { signal.removeEventListener("abort", abort); reject(new Error("Debugger approval failed")); });
    });
    if (!allowed) throw new Error("Debugger launch denied");
    signal.throwIfAborted();
    if (JSON.stringify(await resolveTarget(this.root, name)) !== JSON.stringify(target)) throw new Error("Debugger configuration or launch files changed during approval");
    signal.throwIfAborted(); this.target = target; this.state = "starting";
    try {
      this.home = await mkdtemp(path.join(os.tmpdir(), "casper-debug-home-"));
      signal.throwIfAborted();
      this.connection = new DAPConnection(target, this.home);
      this.connection.onClose = () => {
        this.invalidate();
        if (!["closing", "closed", "failed"].includes(this.state)) { this.state = "failed"; void this.cleanup(); }
      };
      this.connection.onEvent = (event, body) => {
        if (event === "exited" && Number.isInteger(body.exitCode)) this.exitCode = Number(body.exitCode);
        if (["closing", "closed", "failed"].includes(this.state)) return;
        if (event === "stopped") {
          this.invalidate(); this.state = "stopped"; this.stopReason = text(body.reason);
          this.stoppedThread = id(body.threadId) ? body.threadId : undefined;
          this.allStopped = body.allThreadsStopped === true;
          if (this.stoppedThread !== undefined) this.threads.add(this.stoppedThread);
        } else if (event === "continued") { this.invalidate(); this.state = "running"; }
        else if (event === "terminated") { this.invalidate(); this.state = "closed"; void this.cleanup(); }
      };
      const capabilities = await this.request("initialize", { adapterID: target.adapterID, clientID: "casper", clientName: "Casper",
        pathFormat: "path", linesStartAt1: true, columnsStartAt1: true, supportsRunInTerminalRequest: false,
        supportsStartDebuggingRequest: false, supportsVariablePaging: true }, signal);
      if (capabilities.supportsConfigurationDoneRequest !== true) throw new Error("Adapter must support configurationDone");
      const launching = this.request("launch", { program: target.program, cwd: target.cwd, args: target.programArgs, stopOnEntry: true,
        ...(target.adapterID === "python" ? { python: [target.command], console: "internalConsole", subProcess: false } : {}) }, signal);
      void launching.catch(() => {});
      await this.connection.waitInitialized(signal);
      const breakpoints: Record<string, unknown>[] = [];
      for (const [source, values] of Object.entries(target.breakpoints)) breakpoints.push({ path: source, ...await this.setBreakpoints(source, values, signal) });
      await this.request("configurationDone", {}, signal); await launching;
      if (this.state === "starting") this.state = "running";
      await this.connection.captureProcesses();
      return { ...this.status(), items: breakpoints };
    } catch (error) {
      this.state = signal.aborted ? "closed" : "failed"; await this.cleanup();
      throw error;
    }
  }
  private cleanup(): Promise<void> {
    if (this.cleanupWork) return this.cleanupWork;
    this.invalidate();
    return this.cleanupWork = (async () => {
      this.cleanupOutcome = await this.connection?.close();
      if (this.home) await rm(this.home, { recursive: true, force: true }).catch(() => {});
    })();
  }
  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.lifetime.abort();
    if (this.state !== "failed") this.state = "closing";
    // Revoke protocol work immediately, then drain startup before deleting its temporary HOME.
    void this.connection?.close();
    return this.closeWork = (async () => {
      await this.work?.catch(() => {}); await this.cleanup();
      if (this.state !== "failed") this.state = "closed";
    })();
  }
}
