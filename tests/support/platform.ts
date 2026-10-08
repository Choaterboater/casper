import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { test } from "bun:test";
import os from "node:os";
import path from "node:path";

/** POSIX hosts have the PTY, `/dev/null` link and shell primitives these fixtures use. */
export const POSIX = process.platform !== "win32";

/** Probe the host instead of guessing: a missing capability must skip, not fail a fixture. */
async function hostProbe(prefix: string, check: (root: string) => boolean | Promise<boolean>): Promise<boolean> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try { return await check(root); } catch { return false; }
  finally { await rm(root, { recursive: true, force: true }); }
}

/** Windows denies symlink creation without developer mode or elevation. */
const symlinksSupported = await hostProbe("casper-symlink-probe-", async (root) => {
  await writeFile(path.join(root, "target"), "");
  await symlink(path.join(root, "target"), path.join(root, "link"));
  return true;
});

/**
 * FIFO fixtures need a `mkfifo` that makes a real FIFO. Git Bash's `mkfifo` on Windows exits 0
 * but leaves a file that Bun does not see as a FIFO, so the probe checks the result too.
 */
const fifosSupported = await hostProbe("casper-fifo-probe-", async (root) => {
  const probe = path.join(root, "probe");
  if (Bun.spawnSync(["mkfifo", probe], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) return false;
  return (await stat(probe)).isFIFO();
});

/**
 * Mode bits are a POSIX guarantee, and this probe measures both halves of it: the mode is
 * reported back and it is enforced. Windows synthesizes mode bits instead of storing them,
 * and root ignores them, so a fixture asserting `0o600` would fail there for a host reason
 * rather than a product defect.
 */
export const posixModes = await hostProbe("casper-mode-probe-", async (root) => {
  const file = path.join(root, "probe");
  await writeFile(file, "");
  await chmod(file, 0o000);
  try { await readFile(file); return false; }
  catch { return ((await stat(file)).mode & 0o777) === 0o000; }
});

export const posixOnly = test.skipIf(!POSIX);
export const needsSymlinks = test.skipIf(!symlinksSupported);
export const needsFifos = test.skipIf(!fifosSupported);
export const needsPosixModes = test.skipIf(!posixModes);

/**
 * One more try, on the named OS only, for a test known to fail now and then on a busy CI runner because a real
 * child process (Bun, a language server, Chrome, git) is slow there. Never for a test without a child process,
 * and always name the OS it flakes on. Each use is listed in tests/flaky-list.test.ts. Bun marks a pass on the
 * second try `(attempt 2)`. After a timeout Bun starts the second try while the first still runs, and whichever
 * ends first counts, pass or fail.
 */
export function flakyOn(...platforms: NodeJS.Platform[]): { retry?: number } {
  return platforms.includes(process.platform) ? { retry: 1 } : {};
}

/** Registry entries use the POSIX shell, `/dev/null` links, or both. */
export const posixSymlinks = test.skipIf(!POSIX || !symlinksSupported);
/** The real shell sandbox can run here: bubblewrap and socat that start on Linux, or sandbox-exec on macOS. */
export const sandboxAvailable = await (async () => {
  if (process.platform === "darwin") return (await stat("/usr/bin/sandbox-exec").catch(() => undefined)) !== undefined;
  if (process.platform !== "linux") return false;
  const { linuxSandboxProblem } = await import("../../src/sandbox/linux");
  return linuxSandboxProblem() === undefined;
})();
export const needsSandbox = test.skipIf(!sandboxAvailable);
