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
