import path from "node:path";
import { freePort, ManagedProcess, ManagedProcessError, portInUse } from "../platform/managed-process";
import { ProcessCleanupError, type ProcessPlatform } from "../platform/processes";
import type { ServiceSpec } from "./config";

/** idle: declared, never started. failed: the last startup did not reach readiness. crashed: exited on its own after readiness. */
export type ServiceState = "idle" | "starting" | "ready" | "crashed" | "failed" | "stopped";

export interface ServiceStatus {
  name: string;
  command: string;
  state: ServiceState;
  /** The loopback origin while starting or ready. */
  origin?: string;
  pid?: number;
  /** An edit since the start may have changed what it serves; the next freshness check restarts it. */
  stale: boolean;
  readyMs?: number;
  /** Why the last start failed. */
  error?: string;
  /** Exit details and the recent log lines of a crash or failed start. */
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  tail?: string;
  /** Casper could not confirm the service's processes were stopped. */
  cleanup?: "unknown";
}

interface Slot {
  readonly name: string;
  readonly spec: ServiceSpec;
  state: ServiceState;
  stale: boolean;
  process?: ManagedProcess;
  port?: number;
  work?: Promise<ServiceStatus>;
  stopping?: Promise<void>;
  readyMs?: number;
  error?: string;
  exit?: ServiceStatus["exit"];
  tail?: string;
  cleanup?: "unknown";
}

const HOST = "127.0.0.1";
const TAIL_LINES = 20;
const within = (file: string, entry: string) => entry === "." || file === entry || file.startsWith(`${entry}/`);

/**
 * The managed services of one session. Each runs on the shared owned-process runner
 * with PORT/HOST set to its loopback address. A crash is recorded, not pushed into a
 * turn: it shows on the next status, tool call or smoke run. Freshness is lazy (no file
 * watching): edits mark services stale and `ensureFresh` restarts them before use.
 */
export class ServiceManager {
  private readonly slots = new Map<string, Slot>();
  private closing?: Promise<void>;
  private cleanupUnknown = false;
  constructor(private readonly options: { projectRoot: string; services: Record<string, ServiceSpec>; platform?: ProcessPlatform }) {
    for (const [name, spec] of Object.entries(options.services)) this.slots.set(name, { name, spec, state: "idle", stale: false });
  }

  get closed(): boolean { return this.closing !== undefined; }
  names(): string[] { return [...this.slots.keys()]; }
  status(): ServiceStatus[] { return [...this.slots.values()].map(slot => this.describe(slot)); }
  origin(name: string): string | undefined {
    const slot = this.slots.get(name);
    return slot?.state === "ready" && slot.port !== undefined ? `http://${HOST}:${slot.port}` : undefined;
  }
  logs(name: string, options: { lines?: number; filter?: string | RegExp } = {}): { text: string; truncated: boolean } {
    return this.slot(name).process?.logs(options) ?? { text: "", truncated: false };
  }

  /** Starts a declared service, or joins its startup in progress; a ready service is left as it is. */
  async start(name: string, signal: AbortSignal): Promise<ServiceStatus> {
    const slot = this.slot(name);
    if (slot.work) return slot.work;
    if (slot.state === "ready") return this.describe(slot);
    return this.launch(slot, signal);
  }

  async restart(name: string, signal: AbortSignal): Promise<ServiceStatus> {
    const slot = this.slot(name);
    await this.stop(name);
    await slot.work?.catch(() => {});
    return this.launch(slot, signal);
  }

  /** Stops the service's process tree; aborts a startup in progress. */
  async stop(name: string): Promise<void> {
    const slot = this.slot(name);
    if (!slot.process) return;
    if (slot.state !== "idle") slot.state = "stopped";
    slot.stale = false;
    await this.closeProcess(slot);
  }

  /** An edited file (absolute or project-relative) marks the running services whose scope covers it stale.
   * Unknown files (a shell command) mark every running service stale. */
  markEdited(file?: string): void {
    const relative = file === undefined ? undefined : path.relative(this.options.projectRoot, path.resolve(this.options.projectRoot, file)).split(path.sep).join("/");
    if (relative !== undefined && (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))) return;
    for (const slot of this.slots.values()) {
      if (slot.state !== "ready" && slot.state !== "starting") continue;
      const scope = slot.spec.scope;
      if (relative === undefined || !scope || (scope.inputs.some(entry => within(relative, entry)) && !scope.exclude?.some(entry => within(relative, entry)))) slot.stale = true;
    }
  }

  /** Restarts a stale or crashed service, starts one that is not running, and re-probes a ready one. */
  async ensureFresh(name: string, signal: AbortSignal): Promise<{ restarted: boolean }> {
    const slot = this.slot(name);
    await slot.work?.catch(() => {});
    if (slot.state === "ready" && !slot.stale && await this.answers(slot, signal)) return { restarted: false };
    const restarted = slot.state === "ready" || slot.state === "crashed";
    await (restarted ? this.restart(name, signal) : this.start(name, signal));
    return { restarted };
  }

  assertCleanup(): void { if (this.cleanupUnknown) throw new ProcessCleanupError(); }

  /** Stops every service. Idempotent; the manager is not reused afterwards. */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      const results = await Promise.allSettled([...this.slots.keys()].map(name => this.stop(name)));
      await Promise.allSettled([...this.slots.values()].map(slot => slot.work));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason instanceof ProcessCleanupError ? new ProcessCleanupError() : failure.reason;
    })();
  }

  private slot(name: string): Slot {
    const slot = this.slots.get(name);
    if (!slot) throw new Error(`No service named ${JSON.stringify(name)}; declared: ${this.names().join(", ") || "none"} (.casper/project.yaml services)`);
    return slot;
  }

  private describe(slot: Slot): ServiceStatus {
    const live = slot.state === "starting" || slot.state === "ready";
    const tail = slot.tail ?? (slot.state === "crashed" ? slot.process?.logs({ lines: TAIL_LINES }).text : undefined);
    return { name: slot.name, command: slot.spec.command, state: slot.state, stale: slot.stale,
      ...(live && slot.port !== undefined ? { origin: `http://${HOST}:${slot.port}` } : {}),
      ...(slot.process?.pid !== undefined && live ? { pid: slot.process.pid } : {}),
      ...(slot.state === "ready" && slot.readyMs !== undefined ? { readyMs: slot.readyMs } : {}),
      ...(slot.error && slot.state === "failed" ? { error: slot.error } : {}),
      ...(slot.exit && (slot.state === "crashed" || slot.state === "failed") ? { exit: { ...slot.exit } } : {}),
      ...(tail && (slot.state === "crashed" || slot.state === "failed") ? { tail } : {}),
      ...(slot.cleanup ? { cleanup: slot.cleanup } : {}) };
  }

  private launch(slot: Slot, signal: AbortSignal): Promise<ServiceStatus> {
    const work = (async () => {
      if (this.closing) throw new Error("Casper's services were stopped with the conversation; start them again after it changes");
      this.assertCleanup();
      await slot.stopping?.catch(() => {});
      Object.assign(slot, { state: "starting", stale: false, readyMs: undefined, error: undefined, exit: undefined, tail: undefined });
      const { spec, name } = slot;
      try {
        let port: number;
        if (spec.port === "auto") {
          // Keep the address the model already knows when it is still free.
          port = slot.port !== undefined && !(await portInUse(HOST, slot.port)) ? slot.port : await freePort(HOST);
        } else {
          port = spec.port;
          if (await portInUse(HOST, port)) throw new Error(`Port ${port} is in use by a process Casper didn't start; stop that process or set services.${name}.port: auto. Casper never replaces a process it does not own.`);
        }
        signal.throwIfAborted();
        slot.port = port;
        const origin = `http://${HOST}:${port}`;
        const managed: ManagedProcess = new ManagedProcess({ command: spec.command, cwd: this.options.projectRoot,
          env: { ...spec.env, PORT: String(port), HOST },
          ready: "http" in spec.ready ? { http: new URL(spec.ready.http, origin) } : { log: spec.ready.log },
          timeoutMs: spec.timeoutMs, label: `Service ${name}`, tempPrefix: "casper-service-", platform: this.options.platform,
          onExit: details => this.crashed(slot, managed, details) });
        slot.process = managed;
        slot.stopping = undefined;
        const ready = await managed.start(signal);
        if (slot.process === managed && slot.state === "starting") { slot.state = "ready"; slot.readyMs = ready.readyMs; }
        return this.describe(slot);
      } catch (error) {
        if (error instanceof ProcessCleanupError) { this.markUnknown(slot); throw error; }
        const stopped = signal.aborted || slot.state === "stopped" || (error instanceof ManagedProcessError && (error.reason === "aborted" || error.reason === "closed"));
        slot.state = stopped ? "stopped" : "failed";
        slot.error = error instanceof Error ? error.message.split("\nLog tail:")[0] : String(error);
        if (error instanceof ManagedProcessError) { slot.tail = error.tail.split("\n").filter(Boolean).slice(-TAIL_LINES).join("\n"); slot.exit = slot.process?.exit(); }
        throw error;
      }
    })();
    slot.work = work;
    void work.finally(() => { if (slot.work === work) slot.work = undefined; }).catch(() => {});
    return work;
  }

  /** A crash after readiness: record it, then clean up whatever the root left behind (its process group). */
  private crashed(slot: Slot, managed: ManagedProcess, details: NonNullable<ServiceStatus["exit"]>): void {
    if (slot.process !== managed || slot.state !== "ready") return;
    slot.state = "crashed"; slot.exit = details;
    void this.closeProcess(slot).catch(() => {});
  }

  private closeProcess(slot: Slot): Promise<void> {
    const managed = slot.process;
    if (!managed) return Promise.resolve();
    return slot.stopping = managed.close().catch((error: unknown) => {
      if (error instanceof ProcessCleanupError) this.markUnknown(slot);
      throw error;
    });
  }

  private markUnknown(slot: Slot): void { slot.cleanup = "unknown"; this.cleanupUnknown = true; }

  /** A ready service with an HTTP readiness path must still answer it; a log-ready one must still be running. */
  private async answers(slot: Slot, signal: AbortSignal): Promise<boolean> {
    if (slot.process?.state() !== "ready") return false;
    if (!("http" in slot.spec.ready) || slot.port === undefined) return true;
    try {
      const response = await fetch(new URL(slot.spec.ready.http, `http://${HOST}:${slot.port}`), { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), redirect: "manual" });
      await response.body?.cancel();
      return true;
    } catch { return false; }
  }
}
