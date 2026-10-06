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
