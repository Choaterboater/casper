import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isolatedEnvironment } from "../platform/environment";
import { osSupportsProcessGroups, ownSpawnedTree, OwnedProcesses, ProcessCleanupError, terminateTree } from "../platform/processes";

async function unusedPort(url: URL): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); reject(new Error("Browser server port is already in use; existing processes are never replaced")); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("Cannot establish that browser server port is unused")); });
    socket.once("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve() : reject(new Error("Cannot inspect browser server port")));
  });
}

/** Owns only the process group spawned for this exact development command. */
export class BrowserServer {
  private child?: ChildProcess;
  private owner?: OwnedProcesses;
  private exited?: Promise<void>;
  private stopWork?: Promise<void>;
  private home?: string;
  private log = "";
  private totalBytes = 0;
  private stopped = false;
  diagnostics() { return { output: this.log, truncated: this.totalBytes > 8192, running: Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null) }; }

  async start(command: string, projectRoot: string, source: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.child || this.stopped) throw new Error("Only one managed development server is allowed per browser session");
    const url = new URL(source);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || Number(url.port) < 1024) throw new Error("Development server needs a loopback HTTP URL with an explicit unprivileged port");
    signal.throwIfAborted(); await unusedPort(url); signal.throwIfAborted();
    this.home = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-browser-server-")));
    if (this.stopped || signal.aborted) {
      await rm(this.home, { recursive: true, force: true });
      signal.throwIfAborted();
      throw new Error("Development server was closed during startup");
    }
    const child = this.child = spawn(command, { cwd: projectRoot, shell: true, detached: osSupportsProcessGroups, stdio: ["ignore", "pipe", "pipe"], env: isolatedEnvironment(this.home, {
      PATH: `${path.join(projectRoot, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      PORT: url.port, HOST: url.hostname.replace(/^\[|\]$/g, ""),
      NODE_ENV: "development", BUN_INSTALL_AUTO: "disable", npm_config_offline: "true",
    }) });
    this.owner = ownSpawnedTree(child.pid, () => child.exitCode === null && child.signalCode === null);
    const retain = (bytes: Buffer) => { this.totalBytes += bytes.length; this.log = Buffer.from(this.log + bytes.toString("utf8")).subarray(-8192).toString("utf8"); };
    this.child.stdout!.on("data", retain); this.child.stderr!.on("data", retain);
    let failed = false;
    this.child.on("error", () => { failed = true; });
    this.exited = new Promise(resolve => this.child!.once("close", () => resolve()));
    const stop = () => { void this.close().catch(() => {}); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const deadline = performance.now() + 10_000;
      while (performance.now() < deadline) {
        signal.throwIfAborted();
        if (failed || this.child.exitCode !== null || this.child.signalCode !== null) throw new Error("Development server exited before readiness; inspect browser diagnostics");
        try {
          const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(300)]), redirect: "manual" });
          await response.body?.cancel();
          signal.throwIfAborted();
          return { ready: true, url: url.href, httpStatus: response.status, guidance: "HTTP readiness only, not verification. Only the spawned process group is owned; existing processes are untouched." };
        } catch { signal.throwIfAborted(); }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("Development server readiness timed out");
    } catch (error) { await this.close(); throw error; }
    finally { signal.removeEventListener("abort", stop); }
  }

  close(): Promise<void> {
    if (this.stopWork) return this.stopWork;
    this.stopped = true;
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
