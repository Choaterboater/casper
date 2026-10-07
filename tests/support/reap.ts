import { readFile } from "node:fs/promises";

/**
 * Kill the helper a test fixture recorded in a marker file (tests/fixtures/service-server.ts SPAWN_CHILD writes its
 * grandchild's PID there). A test that fails or times out before it checks the process is gone would leave that
 * helper running for the rest of the suite; this is the last resort in afterEach, after the manager closed.
 */
export async function reapMarker(marker: string): Promise<void> {
  const pid = Number((await readFile(marker, "utf8").catch(() => "")).trim());
  if (!Number.isInteger(pid) || pid <= 1) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}
