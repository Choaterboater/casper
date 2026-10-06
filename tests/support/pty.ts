import path from "node:path";

/**
 * How long one Python PTY fixture (tests/fixtures/*-pty.py) may run. Each fixture starts Casper several times and
 * every step inside it already waits for what it needs on the screen, so the whole run only needs an outer limit.
 * On a busy machine (the full suite runs files in parallel) a run that takes 15 s alone took over 80 s, so the limit
 * is long; it costs nothing when the fixture ends early.
 */
export const PTY_DEADLINE_MS = 180_000;
/** The bun:test limit for a test that runs one PTY fixture: the deadline plus room to clean up. */
export const PTY_TEST_MS = PTY_DEADLINE_MS + 20_000;

/** Runs `python3 tests/fixtures/<script> <bun> ...args` to its end (or the deadline) and returns what it printed. */
export async function runPtyFixture(script: string, args: string[], options: { cwd?: string } = {}) {
  const child = Bun.spawn(["python3", path.join(import.meta.dir, "../fixtures", script), process.execPath, ...args],
    { cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), PTY_DEADLINE_MS);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit, stdout, stderr };
  } finally { clearTimeout(timer); child.kill(); }
}
