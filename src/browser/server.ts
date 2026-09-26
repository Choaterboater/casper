import { ManagedProcess, ManagedProcessError, portInUse } from "../platform/managed-process";

/** Owns only the process group spawned for this exact development command. */
export class BrowserServer {
  private process?: ManagedProcess;
  private stopped = false;
  diagnostics() {
    const { text, truncated } = this.process?.logs() ?? { text: "", truncated: false };
    const state = this.process?.state();
    return { output: text, truncated, running: state === "starting" || state === "ready" };
  }

  async start(command: string, projectRoot: string, source: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.process || this.stopped) throw new Error("Only one managed development server is allowed per browser session");
    const url = new URL(source);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || Number(url.port) < 1024) throw new Error("Development server needs a loopback HTTP URL with an explicit unprivileged port");
    signal.throwIfAborted();
    const held = await portInUse(url.hostname, Number(url.port)).catch(() => { throw new Error("Cannot establish that browser server port is unused"); });
    if (held) throw new Error("Browser server port is already in use; existing processes are never replaced");
    signal.throwIfAborted();
    const managed = this.process = new ManagedProcess({ command, cwd: projectRoot, ready: { http: url }, timeoutMs: 10_000, logBytes: 8192,
      label: "Development server", tempPrefix: "casper-browser-server-",
      env: { PORT: url.port, HOST: url.hostname.replace(/^\[|\]$/g, ""), NODE_ENV: "development" } });
    try {
      const { httpStatus } = await managed.start(signal);
      return { ready: true, url: url.href, httpStatus, guidance: "HTTP readiness only, not verification. Only the spawned process group is owned; existing processes are untouched." };
    } catch (error) {
      signal.throwIfAborted();
      // The log tail stays out of the model-facing error; browser diagnostics expose it bounded.
      if (error instanceof ManagedProcessError) throw new Error(error.reason === "exited" ? "Development server exited before readiness; inspect browser diagnostics"
        : error.reason === "timeout" ? "Development server readiness timed out" : "Development server was closed during startup");
      throw error;
    }
  }

  close(): Promise<void> {
    this.stopped = true;
    return this.process?.close() ?? Promise.resolve();
  }
}
