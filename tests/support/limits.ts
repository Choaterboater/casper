/**
 * Time limits for tests that start a real child: the Casper CLI, a Bun child with a Pi runtime, a language server or
 * an MCP server. One of those takes 1-10 s on macOS and Linux and 2-4x that on a busy Windows CI runner, where Bun's
 * 30 s default and tests' own 15-25 s kill timers have failed passing tests (exit 143, a "timeout" status).
 *
 * CHILD_KILL_MS is a test's own guard on one child: kill it and fail with what it printed. childTestLimit is the
 * test's limit, kept above all its children's guards, so a real hang still fails on the guard with a clear message
 * instead of on Bun's limit with "killed 1 dangling process".
 */
export const CHILD_KILL_MS = 60_000;

/**
 * How long `finished` waits for a child's first byte on its first start. Seen on busy Windows CI runners: a Bun
 * child that hangs from the start and prints nothing at all, even one that should print "passed", until the guard
 * kills it; more time does not help, a fresh start does. The signature is not Windows-only, so this runs on every OS.
 */
export const SILENT_START_MS = 45_000;

/** How long a killed child gets to end and close its pipes before the guard stops waiting for it. */
const KILLED_EXIT_MS = 10_000;

/**
 * A test's limit when it runs `children` guarded children one after another (each may be killed and waited for),
 * plus one silent first start that `finished` killed and started again, plus 30 s for its own work.
 */
export function childTestLimit(children = 1): number {
  return children * (CHILD_KILL_MS + KILLED_EXIT_MS) + SILENT_START_MS + KILLED_EXIT_MS + 30_000;
}

export interface PipedChild { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(signal?: number | NodeJS.Signals): void }
export interface Finished { stdout: string; stderr: string; exit: number; killed: boolean; startedAgain: boolean }

interface Attempt { stdout: string; stderr: string; exit: number; killed: boolean; silentWhenKilled: boolean }

/** One guarded start: killed after `killMs`, or after `silentMs` if it has not printed a byte by then. */
async function attempt(child: PipedChild, killMs: number, silentMs: number): Promise<Attempt> {
  const out = { stdout: "", stderr: "" };
  let printed = false;
  let killed = false;
  let gaveUp!: () => void;
  const abandoned = new Promise<"abandoned">((resolve) => { gaveUp = () => resolve("abandoned"); });
  let silentWhenKilled = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  let waitAfterKill: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    if (killed) return;
    killed = true;
    // Only silence before the kill counts: a CLI's SIGTERM handler may still print while it closes.
    silentWhenKilled = !printed;
    child.kill();
    // A child spinning in JavaScript never runs its SIGTERM handler; Windows already ends the process outright.
    forceKill = setTimeout(() => child.kill("SIGKILL"), KILLED_EXIT_MS / 2);
    waitAfterKill = setTimeout(gaveUp, KILLED_EXIT_MS);
  };
  const guard = setTimeout(kill, killMs);
  const quiet = setTimeout(() => { if (!printed) kill(); }, silentMs);
  const read = async (stream: ReadableStream<Uint8Array>, key: "stdout" | "stderr") => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      if (chunk.byteLength > 0 && !printed) { printed = true; clearTimeout(quiet); }
      out[key] += decoder.decode(chunk, { stream: true });
    }
    out[key] += decoder.decode();
  };
  try {
    const ended = await Promise.race([Promise.all([read(child.stdout, "stdout"), read(child.stderr, "stderr"), child.exited]), abandoned]);
    const exit = ended === "abandoned" ? -1 : ended[2];
    return { ...out, exit, killed, silentWhenKilled };
  } finally { clearTimeout(guard); clearTimeout(quiet); clearTimeout(forceKill); clearTimeout(waitAfterKill); }
}

/**
 * A child's output and exit code, killed after `killMs`; a killed child's stderr ends saying so. `start` starts the
 * child, so a first start that had printed nothing at all (no stdout or stderr byte) when it had to be killed, by the
 * silent-start wait or the guard, is started once more with a fresh guard. A child that printed anything, or exited
 * by itself with any code, is never started again. `silentMs` is the wait for that first byte (tests of this helper
 * shorten it); a restart that passes leaves stderr clean and prints its note to the test output.
 */
export async function finished(start: () => PipedChild, killMs = CHILD_KILL_MS, silentMs = Math.min(SILENT_START_MS, killMs)): Promise<Finished> {
  const first = await attempt(start(), killMs, silentMs);
  if (!first.silentWhenKilled) return result(first, false, "");
  const note = `[test guard: child printed nothing for ${silentMs / 1000} s; started again once]`;
  console.warn(note);
  const second = await attempt(start(), killMs, killMs);
  return result(second, true, note);

  function result(run: Attempt, startedAgain: boolean, restarted: string): Finished {
    // A restart that then passes leaves stderr clean (its note is in the test output above); one killed again names both.
    const notes = run.killed ? [restarted, `[test guard: killed after ${killMs / 1000} s without exiting]`].filter(Boolean) : [];
    return { stdout: run.stdout, stderr: notes.length ? `${run.stderr}\n${notes.join("\n")}` : run.stderr, exit: run.exit, killed: run.killed, startedAgain };
  }
}
