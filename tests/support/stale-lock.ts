import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { hostId } from "../../src/platform/state-lock";

/** A pid no test machine hands out. */
export const GONE_PID = 999_999_991;

/** A state lock folder another Casper holds (or held): its owner file, `ageMs` old, on this computer unless `host`. */
export async function heldLock(lock: string, owner: { pid: number; boot: number; host?: string }, ageMs = 10_000): Promise<string> {
  await mkdir(lock, { mode: 0o700 });
  const host = owner.host ?? hostId();
  const file = path.join(lock, `owner.${owner.pid}.${owner.boot}.${host}.0123456789abcdef`);
  await writeFile(file, `${JSON.stringify({ ...owner, host, id: "0123456789abcdef" })}\n`, { mode: 0o600 });
  const then = new Date(Date.now() - ageMs);
  await utimes(file, then, then);
  return file;
}
