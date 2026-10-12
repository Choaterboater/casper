import { ManagedProcess, ManagedProcessError, portInUse } from "../platform/managed-process";
import { ProcessCleanupError } from "../platform/processes";
import type { ServiceManager } from "../services/manager";

const LOG_BYTES = 8192;
const READY_MS = 10_000;

/** The URL a development server listens on: loopback HTTP with an explicit unprivileged port. */
function loopback(source: string): URL {
  const url = new URL(source);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || Number(url.port) < 1024) throw new Error("Development server needs a loopback HTTP URL with an explicit unprivileged port");
  return url;
}

/** Refuses a port something else listens on: existing processes are never replaced. */
async function assertFree(url: URL): Promise<void> {
  const held = await portInUse(url.hostname, Number(url.port)).catch(() => { throw new Error("Cannot establish that browser server port is unused"); });
  if (held) throw new Error("Browser server port is already in use; existing processes are never replaced");
}

/** A start failure for the model: the log tail stays out of it (browser diagnostics expose it bounded). */
function startError(error: unknown, signal: AbortSignal): unknown {
  // Unconfirmed cleanup outranks the abort that caused it: it must reach the session.
  if (error instanceof ProcessCleanupError) return error;
  signal.throwIfAborted();
  if (error instanceof ManagedProcessError) return new Error(error.reason === "exited" ? "Development server exited before readiness; inspect browser diagnostics"
    : error.reason === "timeout" ? "Development server readiness timed out" : "Development server was closed during startup");
  return error;
}

/** Owns only the process group spawned for this exact development command. */
export class BrowserServer {
  private process?: ManagedProcess;
  private stopped = false;
  private url?: URL;
  /** Where it answers while it runs. */
  origin(): string | undefined { return this.process?.state() === "ready" ? this.url?.origin : undefined; }
  diagnostics() {
    const { text, truncated } = this.process?.logs() ?? { text: "", truncated: false };
    const state = this.process?.state();
    return { output: text, truncated, running: state === "starting" || state === "ready" };
  }

  async start(command: string, projectRoot: string, source: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.process || this.stopped) throw new Error("A browser server starts once; serve again makes a new one");
    const url = this.url = loopback(source);
    signal.throwIfAborted();
    await assertFree(url);
    signal.throwIfAborted();
    // close() may have run during the probe; nothing would close a process spawned after it.
    if (this.stopped) throw new Error("Development server was closed during startup");
    const managed = this.process = new ManagedProcess({ command, cwd: projectRoot, ready: { http: url }, timeoutMs: READY_MS, logBytes: LOG_BYTES,
      label: "Development server", tempPrefix: "casper-browser-server-",
      env: { PORT: url.port, HOST: url.hostname.replace(/^\[|\]$/g, ""), NODE_ENV: "development" } });
    try {
      const { httpStatus } = await managed.start(signal);
      return { ready: true, url: url.href, httpStatus, guidance: "HTTP readiness only, not verification. Only the spawned process group is owned; existing processes are untouched." };
    } catch (error) { throw startError(error, signal); }
  }

  close(): Promise<void> {
    this.stopped = true;
    return this.process?.close() ?? Promise.resolve();
  }
}

/**
 * The AI's development server run in the session's ServiceManager slot that Casper's page checks use, so one
 * owner starts, restarts and stops it: a page check after the task reuses or restarts this same server instead
 * of starting a second copy beside it (an app that allows one running copy refuses that). The same isolated
 * process runner as BrowserServer; closing it (the browser session ends) stops the slot.
 */
export class SlotServer {
  constructor(private readonly manager: ServiceManager, private readonly name: string) {}
  origin(): string | undefined { return this.manager.closed ? undefined : this.manager.origin(this.name); }

  diagnostics() {
    let text = "", truncated = false;
    try { ({ text, truncated } = this.manager.logs(this.name)); } catch { /* the slot is gone */ }
    const state = this.manager.status().find(entry => entry.name === this.name)?.state;
    return { output: text.slice(-LOG_BYTES), truncated: truncated || text.length > LOG_BYTES, running: state === "starting" || state === "ready" };
  }

  async start(command: string, source: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const url = loopback(source);
    signal.throwIfAborted();
    // The slot's own running server (a page check's, on this port) is replaced below; anything else is never.
    const own = this.manager.origin(this.name);
    if (!own || new URL(own).port !== url.port) await assertFree(url);
    signal.throwIfAborted();
    this.manager.ensureSlot(this.name, { command, port: Number(url.port), ready: { http: /^\/(?!\/)[^\s\\]*$/.test(url.pathname) ? url.pathname : "/" },
      timeoutMs: READY_MS, env: { NODE_ENV: "development" } });
    try { await this.manager.restart(this.name, signal); }
    catch (error) { throw startError(error, signal); }
    const origin = this.manager.origin(this.name);
    if (!origin) throw new Error("Development server was closed during startup");
    return { ready: true, url: new URL(`${url.pathname}${url.search}`, origin).href,
      guidance: "HTTP readiness only, not verification. Casper's page checks use this same server; serve again restarts it." };
  }

  async close(): Promise<void> {
    if (this.manager.closed) return;
    try { await this.manager.stop(this.name); }
    catch (error) { if (error instanceof ProcessCleanupError) throw error; }
  }
}
