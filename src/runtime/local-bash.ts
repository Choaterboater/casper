import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:os";
import { getShellConfig, type BashOperations } from "@earendil-works/pi-coding-agent";
import { withoutProviderKeys } from "../platform/environment";
import { osSupportsProcessGroups, ownSpawnedTree, ProcessCleanupError, terminateTree } from "../platform/processes";

/** Pi's shell transport, with Casper-owned cleanup: Bun's parallel workers lead separate process groups. */
export function createOwnedBashOperations(): BashOperations {
  return { async exec(command, cwd, { onData, signal, timeout, env }) {
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3600)) {
      throw new Error("Invalid timeout: must be between 0 and 3600 seconds");
    }
    if (signal?.aborted) throw new Error("aborted");
    await access(cwd).catch(() => { throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`); });
    if (signal?.aborted) throw new Error("aborted");
    const config = getShellConfig();
    const stdin = config.commandTransport === "stdin";
    const child = spawn(config.shell, stdin ? config.args : [...config.args, command], {
      cwd, detached: osSupportsProcessGroups, windowsHide: true,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"], env: env ?? withoutProviderKeys(process.env),
    });
    const alive = () => child.exitCode === null && child.signalCode === null;
    const owner = ownSpawnedTree(child.pid, alive, { trackGroups: true });
    const onExit = () => {
      owner?.stopOnExit();
      // Preserve the exact-group fallback if process inspection is unavailable at shutdown.
      if (osSupportsProcessGroups && child.pid && alive()) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    };
    process.once("exit", onExit);
    const shutdowns = new Map<NodeJS.Signals, () => void>();
    for (const name of ["SIGHUP", "SIGTERM"] as const) {
      const shutdown = () => {
        onExit();
        process.removeListener(name, shutdown);
        // Keep other owners' shutdown handlers, or restore the signal's default ending.
        if (process.listenerCount(name) === 0) {
          try { process.kill(process.pid, name); } catch { process.exit(128 + constants.signals[name]); }
        }
      };
      shutdowns.set(name, shutdown);
      process.on(name, shutdown);
    }
    let closed = false;
    let drain: (() => void) | undefined;
    child.once("close", () => { closed = true; drain?.(); });
    let stopping: Promise<void> | undefined;
    let failExit: ((error: unknown) => void) | undefined;
    const cleanup = () => stopping ??= (async () => {
      const first = await terminateTree(owner, child.pid, "SIGTERM", alive);
      if (!owner) await Bun.sleep(100);
      const last = await terminateTree(owner, child.pid, "SIGKILL", alive);
      if (first === "unknown" || last === "unknown") throw new ProcessCleanupError(owner);
    })();
    let timedOut = false;
    const abort = () => { void cleanup().catch(error => failExit?.(error)); };
    const timer = timeout === undefined ? undefined : setTimeout(() => { timedOut = true; abort(); }, timeout * 1000);
    signal?.addEventListener("abort", abort, { once: true });
    // Observe exit rather than close: an inherited pipe can outlive the shell.
    const exited = new Promise<number | null>((resolve, reject) => {
      failExit = reject;
      child.once("error", reject);
      child.once("exit", resolve);
    });
    let outputError: unknown;
    const data = (chunk: Buffer) => { try { onData(chunk); } catch (error) { outputError = error; abort(); } };
    child.stdout?.on("data", data); child.stderr?.on("data", data);
    if (stdin) { child.stdin?.on("error", () => {}); child.stdin?.end(command); }
    if (signal?.aborted) abort();
    try {
      const code = await exited;
      await cleanup();
      if (!closed) {
        await new Promise<void>(resolve => {
          const wait = setTimeout(resolve, 250);
          drain = () => { clearTimeout(wait); resolve(); };
          if (closed) drain();
        });
      }
      if (!closed) throw new ProcessCleanupError(owner);
      if (outputError) throw outputError;
      if (signal?.aborted) throw new Error("aborted");
      if (timedOut) throw new Error(`timeout:${timeout}`);
      return { exitCode: code ?? (child.signalCode ? 128 + (constants.signals[child.signalCode] ?? 0) : 1) };
    } finally {
      clearTimeout(timer);
      process.removeListener("exit", onExit);
      for (const [name, shutdown] of shutdowns) process.removeListener(name, shutdown);
      signal?.removeEventListener("abort", abort);
      try { await cleanup(); }
      finally { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
    }
  } };
}
