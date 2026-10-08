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
 * `flakyOn("win32")(name, body, timeout)`: a test with one more try, on the named OS only, for a test known to
 * fail now and then on a busy CI runner because a real child process (Bun, a language server, git) is slow there.
 * Never for a test without a child process, and always name the OS it flakes on. Each use is listed in
 * tests/flaky-list.test.ts. Elsewhere it is a plain test.
 *
 * Only a first try that runs out of time is tried again: a slow child is what this is for. A first try that fails
 * any other way (a check that got a wrong result) fails the test at once, as it would anywhere else, so a retry can
 * never hide a wrong answer that comes only some of the time.
 *
 * Not Bun's `retry`: after a timeout Bun starts the second try while the first still runs, and the first try's
 * late failure (its child killed by its own guard) is then taken as the second try's. Here each try has the whole
 * limit, a try that times out is left to finish on its own and its result is dropped, and the test's limit is
 * both tries. afterEach runs once, after the last try. A retry prints `(retry)` and that the first try timed out.
 */
export function flakyOn(...platforms: NodeJS.Platform[]) {
  return (name: string, body: () => Promise<unknown>, timeout: number): void => {
    const run = tries(platforms, name, body, timeout);
    test(name, run.body, run.timeout);
  };
}

/** What flakyOn hands to Bun: the body and limit as written, or two tries of it on a named OS. Only flakyOn and
 * its own test in tests/flaky-list.test.ts may call it. */
export function tries(platforms: NodeJS.Platform[], name: string, body: () => Promise<unknown>, timeout: number) {
  if (!platforms.includes(process.platform)) return { body, timeout };
  return { timeout: timeout * 2 + 1_000, body: async () => {
    try { await within(body(), timeout); return; }
    catch (error) {
      if (!(error instanceof TryTimedOut)) throw error;
      console.warn(`(retry) ${name}: the first try failed, trying once more: ${String(error).split("\n")[0]}`);
    }
    await within(body(), timeout);
  } };
}

/** A try that ran out of its time: the one failure a second try is for. */
class TryTimedOut extends Error {}

/** A try's result, or a timeout; a try that runs past it can no longer fail anything. */
async function within(run: Promise<unknown>, timeout: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TryTimedOut(`timed out after ${timeout}ms`)), timeout); });
  try { await Promise.race([run, late]); } finally { clearTimeout(timer); }
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
