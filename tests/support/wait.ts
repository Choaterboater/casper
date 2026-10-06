/**
 * Waits until `ready` holds, looking every 10 ms, for up to `ms`. A child process on a busy machine (the full suite
 * runs files in parallel) can take seconds just to start, so a fixed count of short polls fails a test that would
 * have passed; a long deadline costs nothing when the wait ends early. Returns whether it held.
 */
export async function waitUntil(ready: () => boolean | Promise<boolean>, ms = 20_000): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (!await ready()) {
    if (performance.now() > deadline) return false;
    await Bun.sleep(10);
  }
  return true;
}

/** Waits for a file a child writes (see waitUntil). */
export function waitForFile(file: string, ms?: number): Promise<boolean> {
  return waitUntil(() => Bun.file(file).exists(), ms);
}

/**
 * Waits for a file a child writes holding a process number, and returns it (0 at the deadline). The writer creates the
 * file before it writes the number, so the file can exist and still be empty; `Number("")` is 0, and `process.kill(0, 0)`
 * signals the reader's own process group, so a pid read too early always looks alive.
 */
export async function waitForPid(file: string, ms?: number): Promise<number> {
  let pid = 0;
  await waitUntil(async () => {
    pid = Number(await Bun.file(file).text().catch(() => ""));
    return Number.isInteger(pid) && pid > 0;
  }, ms);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

/** Whether a process with this number is still there (it may have exited and not been reaped yet). */
function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Waits until a stopped process is gone, for up to `ms`. Right after a kill the process can still be listed for a
 * moment: on macOS and Linux an orphan whose parent was killed too waits for init to reap it, and on Windows a kill
 * only starts the exit. A process that was never stopped is still there at the deadline, so the check stays strict.
 */
export function processGone(pid: number, ms = 5_000): Promise<boolean> {
  return waitUntil(() => !exists(pid), ms);
}
