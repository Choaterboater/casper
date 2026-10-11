import type { Subprocess } from "bun";
import { osSupportsProcessGroups, ownSpawnedTree, terminateTree } from "../../src/platform/processes";

type Stdio = "pipe" | "ignore" | number;
export interface Owned {
  child: Subprocess<"ignore" | "pipe", "pipe" | "ignore", "pipe" | "ignore">;
  /** Stops the process and everything it started (a dev server's children too), even after the root exited. */
  stop(): Promise<void>;
}

/** Spawns a command in its own process group, never through a shell. */
export function spawnOwned(command: readonly string[], options: {
  cwd: string; env: Record<string, string | undefined>; stdin?: string; stdout: Stdio; stderr: Stdio;
}): Owned {
  const child = Bun.spawn([...command], {
    cwd: options.cwd, env: options.env, stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: options.stdout, stderr: options.stderr, detached: osSupportsProcessGroups,
  }) as Owned["child"];
  const alive = () => child.exitCode === null && child.signalCode === null;
  const owner = ownSpawnedTree(child.pid, alive);
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    await terminateTree(owner, child.pid, "SIGTERM", alive);
    await Promise.race([child.exited, Bun.sleep(5000)]);
    // The group can outlive its leader (a server the model left running), so it gets the hard stop either way.
    await Bun.sleep(500);
    await terminateTree(owner, child.pid, "SIGKILL", alive);
  })();
  return { child, stop };
}

/** Runs a command to the end or until `timeoutMs`, then stops what is left of its process group. */
export async function runOwned(command: readonly string[], options: Parameters<typeof spawnOwned>[1] & {
  timeoutMs: number; signal?: AbortSignal;
}): Promise<{ exitCode: number | null; timedOut: boolean; ms: number }> {
  const started = performance.now();
  const owned = spawnOwned(command, options);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void owned.stop(); }, options.timeoutMs);
  const abort = () => void owned.stop();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const exitCode = await owned.child.exited;
    return { exitCode: timedOut || options.signal?.aborted ? null : exitCode, timedOut, ms: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    await owned.stop();
  }
}
