import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { isolatedEnvironment } from "./environment";
import { osSupportsProcessGroups, ownSpawnedTree, OwnedProcesses, ProcessCleanupError, terminateTree, type ProcessPlatform } from "./processes";

export type ManagedProcessState = "starting" | "ready" | "exited" | "stopped";
export type Readiness = { http: URL } | { log: string | RegExp };

export interface ManagedProcessOptions {
  /** Shell command, run exactly as written from `cwd`. */
  command: string;
  cwd: string;
  /** Variables added to the isolated environment; they override its defaults. */
  env?: Record<string, string>;
  ready: Readiness;
  timeoutMs: number;
  /** Retained log ring size (stdout and stderr interleaved). */
  logBytes?: number;
  /** Names the process in errors ("Development server", "Service api"). */
  label?: string;
  tempPrefix?: string;
  /** Process-table seam; the host platform by default. Tests simulate Windows through it. */
  platform?: ProcessPlatform;
}

/** A startup that did not reach readiness. The process is already cleaned up when this is thrown. */
export class ManagedProcessError extends Error {
  constructor(readonly reason: "exited" | "timeout" | "aborted" | "closed", message: string, readonly tail: string) {
    super(tail.trim() ? `${message}\nLog tail:\n${tail.split("\n").slice(-20).join("\n").slice(-2048)}` : message);
  }
}

const loopbackHost = (host: string) => host.replace(/^\[|\]$/g, "");

/** Whether something already accepts connections on this loopback port. Throws when that cannot be established. */
export async function portInUse(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = connect({ host: loopbackHost(host), port });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error(`Cannot establish that port ${port} is unused`)); });
    socket.once("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve(false) : reject(new Error(`Cannot inspect port ${port}`)));
  });
}

// The OS may hand a just-released ephemeral port out again; remembering recent
// answers keeps two services started by this process from colliding.
const recentPorts: number[] = [];

/** A loopback port nothing listened on at the time of asking (listen on 0, read it, release it). */
export async function freePort(host = "127.0.0.1"): Promise<number> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, loopbackHost(host), () => {
        const address = server.address();
        server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port was assigned")));
      });
    });
    if (recentPorts.includes(port)) continue;
    recentPorts.push(port); if (recentPorts.length > 64) recentPorts.shift();
    return port;
  }
  throw new Error("Cannot find a free loopback port");
}

/**
 * One owned, long-running shell command (a development server or a managed
 * service): spawned in its own process group with the isolated environment,
 * a bounded log ring, readiness within a deadline, and TERM-then-KILL cleanup
 * through process ownership. Only the tree spawned here is ever signalled.
 */
export class ManagedProcess {
  private child?: ChildProcess;
  private owner?: OwnedProcesses;
  private exited?: Promise<void>;
  private stopWork?: Promise<void>;
  private home?: string;
  private log = Buffer.alloc(0);
  private totalBytes = 0;
  private logMatched = false;
  private current: ManagedProcessState = "starting";
  private exitDetails?: { code: number | null; signal: NodeJS.Signals | null };
  private readonly logBytes: number;
  private readonly label: string;
  constructor(private readonly options: ManagedProcessOptions) {
    this.logBytes = options.logBytes ?? 16_384;
    this.label = options.label ?? "Managed process";
  }

  get pid(): number | undefined { return this.child?.pid; }
  state(): ManagedProcessState { return this.current; }
  /** Set once the root exited on its own (a crash or clean exit), not when Casper stopped it. */
  exit(): { code: number | null; signal: NodeJS.Signals | null } | undefined { return this.exitDetails && { ...this.exitDetails }; }

  /** Retained output; `lines` keeps the most recent lines, `filter` keeps matching lines only. */
  logs(options: { lines?: number; filter?: string | RegExp } = {}): { text: string; truncated: boolean } {
    const text = this.log.toString("utf8");
    if (options.lines === undefined && options.filter === undefined) return { text, truncated: this.totalBytes > this.logBytes };
    const filter = options.filter;
    let lines = text.split("\n").filter(line => line.length > 0);
    if (filter !== undefined) lines = lines.filter(line => typeof filter === "string" ? line.includes(filter) : new RegExp(filter.source, filter.flags.replace("g", "")).test(line));
    const kept = options.lines === undefined ? lines : lines.slice(-Math.max(0, options.lines));
    return { text: kept.join("\n"), truncated: this.totalBytes > this.logBytes || kept.length < lines.length };
  }

  /** Resolves once ready; otherwise cleans up and rejects with a `ManagedProcessError` carrying the log tail. */
  async start(signal: AbortSignal): Promise<{ readyMs: number; httpStatus?: number }> {
    if (this.child || this.stopWork) throw new Error(`${this.label} was already started`);
    const began = performance.now();
    const fail = async (reason: ManagedProcessError["reason"], message: string): Promise<never> => {
      // Let buffered output drain so the tail shows why it exited.
      if (reason === "exited" && this.exited) await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, 150))]);
      await this.close();
      throw new ManagedProcessError(reason, message, this.log.toString("utf8"));
    };
    const aborted = () => fail("aborted", `${this.label} startup was cancelled`);
    this.home = await realpath(await mkdtemp(path.join(os.tmpdir(), this.options.tempPrefix ?? "casper-process-")));
    if (signal.aborted) return aborted();
    if (this.stopWork) return fail("closed", `${this.label} was closed during startup`);
    const { cwd, command } = this.options;
    const child = this.child = spawn(command, { cwd, shell: true, detached: osSupportsProcessGroups, stdio: ["ignore", "pipe", "pipe"], env: isolatedEnvironment(this.home, {
      PATH: `${path.join(cwd, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      // Never let a started project fetch or install packages on its own.
      BUN_INSTALL_AUTO: "disable", npm_config_offline: "true",
      ...this.options.env,
    }) });
    const alive = () => child.exitCode === null && child.signalCode === null;
    if (this.options.platform && child.pid) { this.owner = new OwnedProcesses(child.pid, alive, this.options.platform); void this.owner.capture(); }
    else this.owner = ownSpawnedTree(child.pid, alive);
    const ready = this.options.ready;
    const retain = (bytes: Buffer) => {
      const previous = this.log.subarray(-1024).toString("utf8");
      this.totalBytes += bytes.length;
      this.log = Buffer.concat([this.log, bytes]).subarray(-this.logBytes);
      // Match across chunk boundaries without depending on the ring still holding the line.
      if ("log" in ready && !this.logMatched) {
        const window = previous + bytes.toString("utf8");
        this.logMatched = typeof ready.log === "string" ? window.includes(ready.log) : new RegExp(ready.log.source, ready.log.flags.replace("g", "")).test(window);
      }
    };
    child.stdout!.on("data", retain); child.stderr!.on("data", retain);
    let failed = false;
    child.on("error", () => { failed = true; });
    child.once("exit", (code, exitSignal) => {
      if (this.current === "starting" || this.current === "ready") { this.current = "exited"; this.exitDetails = { code, signal: exitSignal }; }
    });
    this.exited = new Promise(resolve => child.once("close", () => resolve()));
    const stop = () => { void this.close().catch(() => {}); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const deadline = began + this.options.timeoutMs;
      while (performance.now() < deadline) {
        if (signal.aborted) return await aborted();
        if (failed || !alive()) return await fail("exited", `${this.label} exited before readiness${child.exitCode !== null ? ` (exit code ${child.exitCode})` : ""}`);
        if (this.current === "stopped") return await fail("closed", `${this.label} was closed during startup`);
        if ("log" in ready) {
          if (this.logMatched) { this.current = "ready"; return { readyMs: Math.round(performance.now() - began) }; }
        } else {
          try {
            const response = await fetch(ready.http, { signal: AbortSignal.any([signal, AbortSignal.timeout(300)]), redirect: "manual" });
            await response.body?.cancel();
            if (!signal.aborted && alive()) { this.current = "ready"; return { readyMs: Math.round(performance.now() - began), httpStatus: response.status }; }
          } catch { /* not listening yet */ }
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return await fail("timeout", `${this.label} readiness timed out after ${this.options.timeoutMs} ms`);
    } finally { signal.removeEventListener("abort", stop); }
  }

  /** TERM then KILL for the owned tree. Throws `ProcessCleanupError` when termination cannot be confirmed. */
  close(): Promise<void> {
    if (this.stopWork) return this.stopWork;
    if (this.current !== "exited") this.current = "stopped";
    return this.stopWork = (async () => {
      const kill = (signal: NodeJS.Signals) => terminateTree(this.owner, this.child?.pid, signal);
      const first = kill("SIGTERM");
      // Always finish tree cleanup, even if the shell exited before a descendant.
      await new Promise(resolve => setTimeout(resolve, 100));
      const last = kill("SIGKILL");
      if ((await first) === "unknown" || (await last) === "unknown") {
        this.child?.stdout?.destroy(); this.child?.stderr?.destroy(); this.child?.unref();
        throw new ProcessCleanupError();
      }
      if (this.exited) await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, 150))]);
      if (this.home) await rm(this.home, { recursive: true, force: true });
    })();
  }
}
