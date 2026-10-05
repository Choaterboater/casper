import { freePort, ManagedProcess, ManagedProcessError, portInUse } from "../platform/managed-process";
import { ProcessCleanupError, type ProcessPlatform } from "../platform/processes";
import { editAffects } from "../verify/task";
import { MAX_SERVICES, SERVICE_NAME, type ServiceSpec } from "./config";

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
  /** When this run of it started (Date.now()), while starting or ready. */
  startedAt?: number;
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
  /** Replaced when an ad-hoc command is started again with other readiness options. */
  spec: ServiceSpec;
  state: ServiceState;
  stale: boolean;
  process?: ManagedProcess;
  port?: number;
  work?: Promise<ServiceStatus>;
  /** Aborts the launch in progress, including before it has spawned anything. */
  launch?: AbortController;
  stopping?: Promise<void>;
  readyMs?: number;
  startedAt?: number;
  error?: string;
  exit?: ServiceStatus["exit"];
  tail?: string;
  cleanup?: "unknown";
  /** A crash after readiness that no tool call has reported yet. */
  crashUnreported?: boolean;
  /** How a host-added slot runs (see SlotOptions). */
  options?: SlotOptions;
  /** An ad-hoc command's question when the sandbox fails to start on it (see ManagedProcessOptions.unsandboxed). */
  approve?: (signal: AbortSignal) => Promise<string | undefined>;
}

const HOST = "127.0.0.1";

/** How a slot Casper adds itself runs. `listen: "network"` sets HOST to 0.0.0.0, so phones on the same network can
 * open it (/preview); Casper still probes it on loopback. `sandbox: false` runs a tool the person installed and said
 * yes to (a tunnel) outside the shell sandbox, which would hold its network. */
export interface SlotOptions { listen?: "network"; sandbox?: false }
const portTaken = (port: number, name: string) => `Port ${port} is in use by a process Casper didn't start; stop that process or set services.${name}.port: auto. Casper never replaces a process it does not own.`;
const TAIL_LINES = 20;

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
  private adhocCount = 0;
  /** Slots added by ensureSlot (host-detected), as opposed to declared in .casper/project.yaml. */
  private readonly detected = new Set<string>();
  /** Unreported crashes whose service was relaunched since (by a freshness check, /services or a smoke run). */
  private replacedCrashes: ServiceStatus[] = [];
  /** Cleanup of ad-hoc slots dropped past the cap, which close() still awaits. */
  private readonly retired: Promise<void>[] = [];
  /** The project folder services run in. */
  get root(): string { return this.options.projectRoot; }

  constructor(private readonly options: { projectRoot: string; services: Record<string, ServiceSpec>; platform?: ProcessPlatform }) {
    for (const [name, spec] of Object.entries(options.services)) this.slots.set(name, { name, spec, state: "idle", stale: false });
  }

  get closed(): boolean { return this.closing !== undefined; }
  names(): string[] { return [...this.slots.keys()]; }
  /** Whether any service is starting or ready. `detected: false` leaves out the dev server Casper started for its
   * own page check, so that server alone never hands the model the service tool (and its tokens) on later tasks. */
  live(options: { detected?: boolean } = {}): boolean {
    return [...this.slots.values()].some(slot => (options.detected !== false || !this.detected.has(slot.name))
      && (slot.work !== undefined || slot.state === "starting" || slot.state === "ready"));
  }
  /** Crashes after readiness not yet reported, each returned once (with its exit and log tail) for the next tool call. */
  takeCrashes(): ServiceStatus[] {
    const replaced = this.replacedCrashes.splice(0);
    return [...replaced, ...[...this.slots.values()].filter(slot => slot.state === "crashed" && slot.crashUnreported)
      .map(slot => { slot.crashUnreported = false; return this.describe(slot); })];
  }
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

  /** Starts a command the model supplied as `adhoc-<n>`: an auto port, no scope (any edit makes it
   * stale) and no env beyond PORT/HOST. The same command already running is joined, not duplicated
   * (the caller makes it fresh); one that stopped, failed or crashed is relaunched under its name.
   * At most MAX_SERVICES ad-hoc slots are kept: past that the oldest one not running is dropped. */
  async startCommand(command: string, options: { ready?: ServiceSpec["ready"]; timeoutMs?: number;
    approve?: (signal: AbortSignal) => Promise<string | undefined> }, signal: AbortSignal): Promise<ServiceStatus> {
    if (this.closing) throw new Error("Casper's services were stopped with the conversation; start them again after it changes");
    const ready = options.ready ?? { http: "/" }, timeoutMs = options.timeoutMs ?? 30_000;
    if (!command.trim() || Buffer.byteLength(command) > 4096) throw new Error("command must be a nonempty shell command of at most 4 KiB");
    if ("http" in ready ? !/^\/(?!\/)[^\s\\]*$/.test(ready.http) || ready.http.length > 1024 : !ready.log.trim() || ready.log.length > 1024) {
      throw new Error("ready must be { http: <path such as /health> } or { log: <nonempty text> }");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new Error("timeoutMs must be an integer between 1000 and 120000");
    const adhoc = [...this.slots.values()].filter(slot => slot.name.startsWith("adhoc-"));
    const running = (slot: Slot) => slot.work !== undefined || slot.state === "starting" || slot.state === "ready";
    const spec: ServiceSpec = { command, port: "auto", ready, timeoutMs };
    const same = adhoc.find(slot => slot.spec.command === command);
    if (same && running(same)) return same.work ?? this.describe(same);
    if (same) { same.spec = spec; same.approve = options.approve; return this.launch(same, signal); }
    if (adhoc.filter(running).length >= MAX_SERVICES) throw new Error(`At most ${MAX_SERVICES} ad-hoc services run at once; stop one first`);
    if (adhoc.length >= MAX_SERVICES) {
      // Oldest first (insertion order); its crash, if any, was reported at the start of this call.
      const oldest = adhoc.find(slot => !running(slot))!;
      this.slots.delete(oldest.name);
      if (oldest.process) this.retired.push(this.closeProcess(oldest).catch(() => {}));
    }
    const slot: Slot = { name: `adhoc-${++this.adhocCount}`, spec, state: "idle", stale: false, ...(options.approve ? { approve: options.approve } : {}) };
    this.slots.set(slot.name, slot);
    return this.launch(slot, signal);
  }

  /** Adds a host-detected service (the dev server Casper found for page checks) under `name`, or keeps the
   * slot already there. A declared service of that name always wins and is left exactly as declared. A
   * detected slot whose command or readiness changed takes the new spec; if it is running, it is marked stale
   * so the next freshness check restarts it. The slot lives as long as the session, so later tasks reuse the
   * running server. It counts toward the MAX_SERVICES cap of named services; ad-hoc slots do not. Starts nothing. */
  ensureSlot(name: string, spec: ServiceSpec, options?: SlotOptions): ServiceStatus {
    if (this.closing) throw new Error("Casper's services were stopped with the conversation; start them again after it changes");
    if (!SERVICE_NAME.test(name) || name.startsWith("adhoc-")) throw new Error(`${JSON.stringify(name)} is not a service name`);
    const existing = this.slots.get(name);
    if (existing) {
      if (!this.detected.has(name) || (JSON.stringify(existing.spec) === JSON.stringify(spec) && JSON.stringify(existing.options) === JSON.stringify(options))) return this.describe(existing);
      existing.spec = spec;
      existing.options = options;
      if (existing.work !== undefined || existing.state === "starting" || existing.state === "ready") existing.stale = true;
      return this.describe(existing);
    }
    const named = [...this.slots.keys()].filter(key => !key.startsWith("adhoc-"));
    if (named.length >= MAX_SERVICES) throw new Error(`At most ${MAX_SERVICES} services are kept; ${name} was not added`);
    const slot: Slot = { name, spec, state: "idle", stale: false, ...(options ? { options } : {}) };
    this.slots.set(name, slot);
    this.detected.add(name);
    return this.describe(slot);
  }

  async restart(name: string, signal: AbortSignal): Promise<ServiceStatus> {
    const slot = this.slot(name);
    await this.stop(name);
    await slot.work?.catch(() => {});
    return this.launch(slot, signal);
  }

  /** Stops the service's process tree and aborts a startup in progress, even one still
   * choosing its port. Resolves whether it was running (starting or ready). */
  async stop(name: string): Promise<boolean> {
    const slot = this.slot(name);
    const work = slot.work;
    const running = work !== undefined || slot.state === "starting" || slot.state === "ready";
    if (!slot.process && !work) return false;
    this.keepCrash(slot);
    if (slot.state !== "idle") slot.state = "stopped";
    slot.stale = false;
    slot.launch?.abort(new Error(`Service ${name} was stopped during startup`));
    try { await this.closeProcess(slot); }
    finally {
      // Wait for the launch to unwind; only its unconfirmed cleanup matters here.
      await work?.catch((error: unknown) => { if (error instanceof ProcessCleanupError) throw error; });
    }
    return running;
  }

  /** An edited file (absolute or project-relative) marks the running services whose scope may cover it
   * stale, resolved the way verification scopes are (aliases, case; unprovable counts as covered).
   * Unknown files (a shell command) mark every running service stale. */
  markEdited(file?: string): void {
    const affects = file === undefined ? () => true : editAffects(this.options.projectRoot, file);
    for (const slot of this.slots.values()) {
      if (slot.state !== "ready" && slot.state !== "starting") continue;
      // Without a scope, any edit inside the project counts.
      if (affects(slot.spec.scope)) slot.stale = true;
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
      await Promise.allSettled(this.retired);
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
      ...(live && slot.startedAt !== undefined ? { startedAt: slot.startedAt } : {}),
      ...(slot.state === "ready" && slot.readyMs !== undefined ? { readyMs: slot.readyMs } : {}),
      ...(slot.error && slot.state === "failed" ? { error: slot.error } : {}),
      ...(slot.exit && (slot.state === "crashed" || slot.state === "failed") ? { exit: { ...slot.exit } } : {}),
      ...(tail && (slot.state === "crashed" || slot.state === "failed") ? { tail } : {}),
      ...(slot.cleanup ? { cleanup: slot.cleanup } : {}) };
  }

  private launch(slot: Slot, callerSignal: AbortSignal): Promise<ServiceStatus> {
    // stop() and close() abort this launch through its own controller, so a launch they
    // interrupt before its spawn never spawns afterwards; the caller's signal still cancels it.
    const controller = slot.launch = new AbortController();
    const signal = AbortSignal.any([callerSignal, controller.signal]);
    const work = (async () => {
      if (this.closing) throw new Error("Casper's services were stopped with the conversation; start them again after it changes");
      this.assertCleanup();
      await slot.stopping?.catch(() => {});
      signal.throwIfAborted();
      this.keepCrash(slot);
      Object.assign(slot, { state: "starting", startedAt: Date.now(), stale: false, crashUnreported: false, readyMs: undefined, error: undefined, exit: undefined, tail: undefined });
      const { spec, name } = slot;
      try {
        let port: number;
        if (spec.port === "auto") {
          // Keep the address the model already knows when it is still free.
          port = slot.port !== undefined && !(await portInUse(HOST, slot.port)) ? slot.port : await freePort(HOST);
        } else {
          port = spec.port;
          if (await portInUse(HOST, port)) throw new Error(portTaken(port, name));
        }
        signal.throwIfAborted();
        if (this.closing) throw new Error("Casper's services were stopped with the conversation; start them again after it changes");
        // Never orphan an earlier process by overwriting the slot's only reference to it.
        if (slot.process) await this.closeProcess(slot);
        signal.throwIfAborted();
        slot.port = port;
        const target = (at: number) => ({ env: { ...spec.env, PORT: String(at), HOST: slot.options?.listen === "network" ? "0.0.0.0" : HOST },
          ready: "http" in spec.ready ? { http: new URL(spec.ready.http, `http://${HOST}:${at}`) } : { log: spec.ready.log } });
        // The answer may take a while: a port something else took meanwhile is picked again (auto) or refused.
        const unsandboxed = async () => {
          const refused = await slot.approve!(signal);
          if (refused) return refused;
          if (!(await portInUse(HOST, port))) return undefined;
          if (spec.port !== "auto") return portTaken(port, name);
          slot.port = await freePort(HOST);
          return target(slot.port);
        };
        const managed: ManagedProcess = new ManagedProcess({ command: spec.command, cwd: this.options.projectRoot,
          ...target(port),
          timeoutMs: spec.timeoutMs, label: `Service ${name}`, tempPrefix: "casper-service-", platform: this.options.platform,
          ...(slot.options?.sandbox === false ? { sandbox: false as const } : {}),
          ...(slot.approve ? { unsandboxed } : {}),
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
    void work.finally(() => { if (slot.work === work) slot.work = undefined; if (slot.launch === controller) slot.launch = undefined; }).catch(() => {});
    return work;
  }

  /** A crash after readiness: record it, then clean up whatever the root left behind (its process group). */
  private crashed(slot: Slot, managed: ManagedProcess, details: NonNullable<ServiceStatus["exit"]>): void {
    if (slot.process !== managed || slot.state !== "ready") return;
    slot.state = "crashed"; slot.exit = details; slot.crashUnreported = true;
    void this.closeProcess(slot).catch(() => {});
  }

  /** A stop or relaunch must not hide a crash no call has reported yet; keep it (bounded) for the next one. */
  private keepCrash(slot: Slot): void {
    if (slot.state !== "crashed" || !slot.crashUnreported) return;
    this.replacedCrashes = [...this.replacedCrashes, this.describe(slot)].slice(-MAX_SERVICES * 2);
    slot.crashUnreported = false;
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
