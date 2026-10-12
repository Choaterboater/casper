import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempDir } from "./support/temp-dir";

// tools/stall-guard.sh is the watchdog on the Linux and macOS full-suite CI steps. It is bash, so these tests are for POSIX hosts.
const SCRIPT = path.join(import.meta.dir, "..", "tools", "stall-guard.sh");
const posix = process.platform !== "win32";
const hasSetsid = posix && Bun.which("setsid") !== null;

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function workdir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-stall-"));
  cleanups.push(() => removeTempDir(root));
  await mkdir(path.join(root, "tests"));
  for (const name of ["a", "b"]) await writeFile(path.join(root, "tests", `${name}.test.ts`), "");
  return root;
}

// STALL_WORKERS is a worker pattern only this run can match, so the dump never looks into the real test
// workers running these tests (or another run's) at the same time.
async function guard(root: string, stall: number, command: string[], env: Record<string, string> = {}) {
  const started = performance.now();
  const child = Bun.spawn(["bash", SCRIPT, path.join(root, "out", "run.log"), String(stall), path.join(root, "out", "dump.txt"), "--", ...command], {
    cwd: root, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, STALL_POLL: "1", STALL_GRACE: "1", STALL_WORKERS: `bun test --test-worker ${path.basename(root)}`, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, seconds: (performance.now() - started) / 1000, log: path.join(root, "out", "run.log"), dump: path.join(root, "out", "dump.txt") };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test.skipIf(!posix)("a command that finishes keeps its own exit code and its output streams to the screen and the log", async () => {
  const root = await workdir();
  const result = await guard(root, 30, ["bash", "-c", "echo tests/a.test.ts:; echo '(pass) one'; echo problem >&2; exit 7"]);
  expect(result.code).toBe(7);
  expect(result.stdout).toContain("(pass) one");
  expect(result.stdout).toContain("problem");
  expect(await readFile(result.log, "utf8")).toContain("tests/a.test.ts:");
  expect(await Bun.file(result.dump).exists()).toBe(false);
});

test.skipIf(!posix)("a command that exits 0 gives 0", async () => {
  const result = await guard(await workdir(), 30, ["bash", "-c", "echo done"]);
  expect(result.code).toBe(0);
});

test.skipIf(!posix)("output that keeps coming, even slowly, is not a stall", async () => {
  const result = await guard(await workdir(), 3, ["bash", "-c", "for i in 1 2 3 4 5; do echo tick $i; sleep 1; done"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("tick 5");
});

test.skipIf(!posix)("a stalled command is cut off with a dump that names what was printed and what was not", async () => {
  const root = await workdir();
  const pids = path.join(root, "pids");
  const command = `echo tests/a.test.ts:; sleep 300 >/dev/null 2>&1 & echo "$$ $!" > ${JSON.stringify(pids)}; sleep 300`;
  const result = await guard(root, 2, ["bash", "-c", command]);
  expect(result.code).toBe(124);
  expect(result.seconds).toBeLessThan(30);
  expect(result.stderr).toContain("cut off");
  const dump = await readFile(result.dump, "utf8");
  expect(dump).toContain("Stall dump: no output for 2s");
  expect(dump).toContain("== Processes");
  expect(dump).toMatch(/printed: 1 +not printed: 1/);
  expect(dump).toMatch(/not printed[^\n]*\n(?:[^\n]*\n)*?tests\/b\.test\.ts/);
  expect(dump).toContain("tests/a.test.ts:");
  if (hasSetsid) {
    // Everything the command started is stopped with it, not just the process the script launched.
    const [leader, background] = (await readFile(pids, "utf8")).trim().split(/\s+/).map(Number) as [number, number];
    await Bun.sleep(300);
    expect(alive(leader)).toBe(false);
    expect(alive(background)).toBe(false);
  }
}, 60_000);

test.skipIf(!posix)("a worker stuck on the CPU is shown with its children and where it is in its own code", async () => {
  const root = await workdir();
  const pids = path.join(root, "pids");
  // A stand-in test worker: its command line matches the worker pattern (it is the inner bash's $0, which
  // the guard's own command line never spells out), it has a child, and it spins on the CPU.
  const worker = 'sleep 300 & echo "$$ $!" > "$STALL_TEST_PIDS"; while :; do :; done';
  const result = await guard(root, 2, ["bash", "-c", 'bash -c "$STALL_TEST_WORKER" "$STALL_WORKERS"'], {
    STALL_TEST_WORKER: worker, STALL_TEST_PIDS: pids, STALL_STACK_LIMIT: "10",
  });
  const [workerPid, childPid] = (await readFile(pids, "utf8")).trim().split(/\s+/).map(Number) as [number, number];
  cleanups.push(() => { for (const pid of [childPid, workerPid]) try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ } });
  expect(result.code).toBe(124);
  expect(result.seconds).toBeLessThan(45);
  const dump = await readFile(result.dump, "utf8");
  expect(dump).toContain(`-- worker ${workerPid}\n`);
  const section = dump.slice(dump.indexOf(`-- worker ${workerPid}\n`)).split(/\n(?:-- worker |\n== )/)[0]!;
  // The child is listed under its worker (its pid, then the worker as parent), on macOS as well as Linux.
  expect(section).toMatch(new RegExp(`^children[^\\n]*\\n(?:[^\\n]*\\n)*?\\s*${childPid}\\s+${workerPid}\\s`, "m"));
  // A worker on the CPU gets a native stack, or a line saying this host has no tool to take one.
  expect(section).toMatch(/^native stack(?: \((?:sample|gdb|eu-stack),|: no native stack tool)/m);
  // The header is written before the tool runs, so on macOS the sample report itself must be there too:
  // "Call graph:" is only in the report file, so this also checks that the file is read back into the dump.
  if (/^native stack \(sample,/m.test(section)) expect(section).toMatch(/^\s*Call graph:/m);
}, 60_000);

// A stand-in for Bun's parallel run that goes silent: on the stop signal it prints what Bun prints, the
// files it was still running (and, when asked, one that had not started). It sleeps in short steps, so the
// trap runs whichever of it and its sleep the stop reaches first.
const STALLS = `trap 'echo "Interrupted while still running:"; echo "  tests/a.test.ts (3s)"; if [ -n "\${NOT_STARTED:-}" ]; then echo "1 file(s) had not started:"; echo "  tests/b.test.ts"; fi; exit 143' TERM; echo "tests/c.test.ts:"; echo "\${FIRST_LINE:-(pass) one}"; while :; do sleep 1; done`;

async function retryScript(root: string, body: string): Promise<string> {
  const file = path.join(root, "retry.sh");
  await writeFile(file, body);
  return `bash ${file}`;
}

test.skipIf(!posix)("after a stall, the files Bun was still running run once more, and that run's exit code is the step's", async () => {
  const root = await workdir();
  const retry = await retryScript(root, 'echo "retry got: $*"; echo "(pass) again"; exit 0\n');
  const result = await guard(root, 2, ["bash", "-c", STALLS], { STALL_RETRY_CMD: retry, NOT_STARTED: "1" });
  expect(result.code).toBe(0);
  // The file that was running and the one that had not started, nothing else.
  expect(result.stdout).toContain("retry got: tests/a.test.ts tests/b.test.ts\n");
  expect(result.stderr).toContain("stall-guard: retried tests/a.test.ts tests/b.test.ts once after a stall: passed");
  // The first run's dump is kept, and the retry has its own log next to the first one.
  expect(await readFile(result.dump, "utf8")).toContain("Stall dump: no output for 2s");
  expect(await readFile(path.join(root, "out", "run-retry.log"), "utf8")).toContain("(pass) again");
}, 60_000);

test.skipIf(!posix)("a retry that stalls again fails the step, and there is no second retry", async () => {
  const root = await workdir();
  const retry = await retryScript(root, `echo "retry got: $*"; ${STALLS}\n`);
  const result = await guard(root, 2, ["bash", "-c", STALLS], { STALL_RETRY_CMD: retry });
  expect(result.code).toBe(124);
  expect(result.stdout.match(/retry got: /g)).toHaveLength(1);
  expect(result.stderr).toContain("stall-guard: retried tests/a.test.ts once after a stall: failed (exit 124)");
  expect(await readFile(path.join(root, "out", "dump-retry.txt"), "utf8")).toContain("Stall dump");
  // The job's one retry is used: a later stall in the same job is not retried.
  const again = await guard(root, 2, ["bash", "-c", STALLS], { STALL_RETRY_CMD: retry });
  expect(again.code).toBe(124);
  expect(again.stderr).toContain("this job already used its one retry");
  expect(again.stdout).not.toContain("retry got: ");
}, 90_000);

test.skipIf(!posix)("a stall that names no file, or follows a failed test, is not retried", async () => {
  const root = await workdir();
  const retry = await retryScript(root, 'echo "retry got: $*"; exit 0\n');
  const unnamed = await guard(root, 2, ["bash", "-c", "echo tests/a.test.ts:; sleep 300"], { STALL_RETRY_CMD: retry });
  expect(unnamed.code).toBe(124);
  expect(unnamed.stderr).toContain("cut off");
  expect(unnamed.stderr).not.toContain("retr");
  expect(unnamed.stdout).not.toContain("retry got: ");
  const failed = await guard(await workdir(), 2, ["bash", "-c", STALLS], { STALL_RETRY_CMD: retry, FIRST_LINE: "(fail) one [1ms]" });
  expect(failed.code).toBe(124);
  expect(failed.stderr).toContain("a test had already failed");
  expect(failed.stdout).not.toContain("retry got: ");
}, 60_000);

test.skipIf(!posix)("an error outside a test, or a worker that crashed before the stop, is a failure and is not retried", async () => {
  const retry = await retryScript(await workdir(), 'echo "retry got: $*"; exit 0\n');
  // Bun prints this for a file that would not load or threw at its top level; it has no "(fail)" line.
  const unloaded = await guard(await workdir(), 2, ["bash", "-c", STALLS], { STALL_RETRY_CMD: retry, FIRST_LINE: "# Unhandled error between tests" });
  expect(unloaded.code).toBe(124);
  expect(unloaded.stderr).toContain("a test had already failed");
  expect(unloaded.stdout).not.toContain("retry got: ");
  // Killed (say, out of memory) long before the run went silent: not something the stop did.
  const killed = await guard(await workdir(), 2, ["bash", "-c", STALLS], { STALL_RETRY_CMD: retry, FIRST_LINE: "✗ tests/b.test.ts (worker crashed: SIGKILL)" });
  expect(killed.code).toBe(124);
  expect(killed.stderr).toContain("a test had already failed");
  expect(killed.stdout).not.toContain("retry got: ");
}, 60_000);

test.skipIf(!posix)("a file whose worker the stop itself ended is retried too (the workers got the signal before Bun)", async () => {
  const root = await workdir();
  const retry = await retryScript(root, 'echo "retry got: $*"; exit 0\n');
  const crashed = `trap 'echo "✗ tests/a.test.ts (worker crashed: SIGTERM)"; exit 143' TERM; echo "tests/c.test.ts:"; while :; do sleep 1; done`;
  const result = await guard(root, 2, ["bash", "-c", crashed], { STALL_RETRY_CMD: retry });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("retry got: tests/a.test.ts\n");
}, 60_000);
