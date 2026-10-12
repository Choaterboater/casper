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

/** A test's limit when it runs `children` guarded children one after another, plus 30 s for its own work. */
export function childTestLimit(children = 1): number {
  return children * CHILD_KILL_MS + 30_000;
}

interface PipedChild { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }

/** A child's output and exit code, killed after `killMs`; a killed child's stderr ends saying so. */
export async function finished(child: PipedChild, killMs = CHILD_KILL_MS): Promise<{ stdout: string; stderr: string; exit: number; killed: boolean }> {
  let killed = false;
  const timer = setTimeout(() => { killed = true; child.kill(); }, killMs);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr: killed ? `${stderr}\n[test guard: killed after ${killMs / 1000} s without exiting]` : stderr, exit, killed };
  } finally { clearTimeout(timer); }
}
