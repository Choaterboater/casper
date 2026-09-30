import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import { openNoFollow } from "../src/platform/files";
import { OwnedProcesses, posixProcessPlatform, terminateTree, type ProcessPlatform, type ProcessRecord } from "../src/platform/processes";
import { needsSymlinks, posixOnly } from "./support/platform";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function until(condition: () => boolean | Promise<boolean>, deadline = 5000): Promise<void> {
  const limit = performance.now() + deadline;
  while (performance.now() < limit) {
    if (await condition()) return;
    await Bun.sleep(20);
  }
  throw new Error("Condition was not reached before its deadline");
}

/** Simulated non-host process table: a real OS listing is impossible off Windows. */
function simulatedPlatform(records: ProcessRecord[], signals: Array<{ kind: "process" | "group"; id: number }>) {
  const table = new Map(records.map(record => [record.pid, record]));
  const platform: ProcessPlatform = {
    groups: false,
    list: async () => new Map(table),
    signalProcess: (pid) => { signals.push({ kind: "process", id: pid }); table.delete(pid); },
    signalGroup: () => { throw new Error("Process groups are unavailable on Windows"); },
  };
  return { platform, table };
}

// POSIX shell/group fixture: Windows has no /bin/sh, no sleep and no process groups.
posixOnly("POSIX ownership terminates the spawned group, its descendants and nothing else", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-platform-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "grandchild.pid");
  const unrelated = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  cleanups.push(() => { unrelated.kill("SIGKILL"); });
  const child = spawn("/bin/sh", ["-c", `sleep 30 & echo $! > ${marker}; wait`], { detached: true, stdio: "ignore" });
  cleanups.push(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } });
  const owner = new OwnedProcesses(child.pid!, () => child.exitCode === null && child.signalCode === null, posixProcessPlatform);
  await owner.capture();
  await until(async () => (await readFile(marker, "utf8").catch(() => "")).trim().length > 0);
  const grandchild = Number((await readFile(marker, "utf8")).trim());
  expect(() => process.kill(grandchild, 0)).not.toThrow();
  expect(await owner.stop()).toBe("stopped");
  await until(() => { try { process.kill(grandchild, 0); return false; } catch { return true; } });
  expect(() => process.kill(child.pid!, 0)).toThrow();
  expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
}, 30_000);

test("a platform without process groups terminates verified descendants children-first and skips a reused PID", async () => {
  const signals: Array<{ kind: "process" | "group"; id: number }> = [];
  const { platform, table } = simulatedPlatform([
    { pid: 1000, parent: 42, group: 0, stamp: "adapter" },
    { pid: 1001, parent: 1000, group: 0, stamp: "debuggee" },
    { pid: 1002, parent: 1001, group: 0, stamp: "grandchild" },
    { pid: 2000, parent: 1, group: 0, stamp: "unrelated" },
  ], signals);
  const owner = new OwnedProcesses(1000, () => true, platform);
  await owner.capture();
  // PID reuse: the identity stamp changed, so this process is no longer ours.
  table.set(1001, { pid: 1001, parent: 1, group: 0, stamp: "reused" });
  expect(await owner.stop()).toBe("stopped");
  expect(signals).toEqual([{ kind: "process", id: 1002 }, { kind: "process", id: 1000 }]);
  expect(signals.some((entry) => entry.id === 2000 || entry.id === 1001)).toBe(false);
});

test("an untrustworthy process listing fails closed instead of terminating anything", async () => {
  const signals: Array<{ kind: "process" | "group"; id: number }> = [];
  const platform: ProcessPlatform = {
    groups: false,
    list: async () => { throw new Error("Process listing is unavailable"); },
    signalProcess: (pid) => { signals.push({ kind: "process", id: pid }); },
    signalGroup: () => { throw new Error("Process groups are unavailable on Windows"); },
  };
  const owner = new OwnedProcesses(1000, () => true, platform);
  await owner.capture();
  expect(await owner.stop()).toBe("unknown");
  expect(signals).toEqual([]);
});

test("grouped ownership signals only groups backed by a proven descendant, root last", async () => {
  const signals: Array<{ kind: "process" | "group"; id: number }> = [];
  const table = new Map<number, ProcessRecord>([
    { pid: 1000, parent: 42, group: 1000, stamp: "adapter" },
    { pid: 1001, parent: 1000, group: 1001, stamp: "debuggee" },
    { pid: 3000, parent: 1, group: 3000, stamp: "unrelated" },
  ].map(record => [record.pid, record]));
  const platform: ProcessPlatform = {
    groups: true,
    list: async () => new Map(table),
    signalProcess: (pid) => { signals.push({ kind: "process", id: pid }); table.delete(pid); },
    signalGroup: (group) => {
      signals.push({ kind: "group", id: group });
      for (const record of [...table.values()]) if (record.group === group) table.delete(record.pid);
    },
  };
  const owner = new OwnedProcesses(1000, () => table.has(1000), platform);
  await owner.capture();
  expect(await owner.stop()).toBe("stopped");
  expect(signals).toEqual([{ kind: "group", id: 1001 }, { kind: "group", id: 1000 }]);
  expect(signals.some((entry) => entry.id === 3000)).toBe(false);
});

test("the shared termination path returns unknown and drains a single owned cleanup", async () => {
  let listings = 0;
  const platform: ProcessPlatform = {
    groups: false,
    list: async () => { listings++; throw new Error("Process listing is unavailable"); },
    signalProcess: () => { throw new Error("An unverified process must not be signalled"); },
    signalGroup: () => { throw new Error("Groups unavailable"); },
  };
  const owner = new OwnedProcesses(1000, () => true, platform);
  // Use the same wrapper as browser/LSP/MCP/verifier callers, not owner.stop directly.
  const first = terminateTree(owner, undefined, "SIGTERM");
  const second = terminateTree(owner, undefined, "SIGKILL");
  expect(await first).toBe("unknown");
  expect(await second).toBe("unknown");
  expect(listings).toBe(3);
});

for (const mode of ["verifier", "app-verifier", "lsp", "mcp", "browser"]) {
  posixOnly(`${mode} caller retains and reports simulated Windows cleanup failure`, async () => {
    // Actual caller lifecycle with a failing non-group ownership adapter. Isolate
    // module substitution and use POSIX teardown for the intentionally surviving trees.
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/cleanup-failure.ts"), mode], {
      stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, TERM: "xterm-256color" },
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(stdout).toContain(`${mode}: cleanup failure propagated`);
    } finally { clearTimeout(timer); }
  }, 20_000);
}

// Real POSIX process table behind a simulated no-groups (Windows) platform; ps is POSIX-only.
posixOnly("simulated Windows MCP cleanup still signals the stdio root after the SDK clears its pid", async () => {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/simulated-windows-mcp.ts")], {
    stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, TERM: "xterm-256color" },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout).toContain("simulated windows mcp: root stopped");
  } finally { clearTimeout(timer); }
}, 20_000);

// POSIX groups: a non-leader PID has no group, so only the liveness-gated bare-PID path can reach it.
posixOnly("the bare-PID fallback signals only a child its caller still sees alive", async () => {
  const calls: string[] = [];
  const kill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => { calls.push(`${pid} ${signal}`); return kill.call(process, pid, signal); }) as typeof process.kill;
  cleanups.push(() => { process.kill = kill; });
  // Reaped non-detached child: its PID may already be reused, so nothing may target it.
  const reaped = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise(resolve => reaped.once("close", resolve));
  expect(await terminateTree(undefined, reaped.pid, "SIGKILL", () => reaped.exitCode === null && reaped.signalCode === null)).toBe("stopped");
  expect(calls).toEqual([`-${reaped.pid} SIGKILL`]);
  // An unrelated live non-leader without a caller predicate is never signalled by PID.
  const unrelated = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  cleanups.push(() => { unrelated.kill("SIGKILL"); });
  calls.length = 0;
  await terminateTree(undefined, unrelated.pid, "SIGKILL");
  expect(calls).toEqual([`-${unrelated.pid} SIGKILL`]);
  expect(unrelated.exitCode === null && unrelated.signalCode === null).toBe(true);
  // A live non-detached child (the MCP SDK spawn shape) is still terminated.
  calls.length = 0;
  const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  const closed = new Promise(resolve => live.once("close", resolve));
  await terminateTree(undefined, live.pid, "SIGKILL", () => live.exitCode === null && live.signalCode === null);
  expect(calls).toEqual([`-${live.pid} SIGKILL`, `${live.pid} SIGKILL`]);
  await closed;
  expect(live.signalCode).toBe("SIGKILL");
});

test("tree termination never throws for a root that no longer exists", () => {
  // A pid beyond any real allocation cannot name a live process or group.
  expect(() => terminateTree(undefined, 2_147_483_647, "SIGKILL")).not.toThrow();
});

test("an isolated environment forwards only allowlisted variables and the temporary home", async () => {
  process.env.CASPER_TEST_CREDENTIAL = "secret-value";
  cleanups.push(() => { delete process.env.CASPER_TEST_CREDENTIAL; });
  const env = isolatedEnvironment("/tmp/casper-isolated-home", { PORT: "3000" });
  const allowed = ["PATH", "HOME", "TMPDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PORT",
    "SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
    "OS", "ProgramData", "ProgramFiles", "ProgramFiles(x86)"];
  expect(Object.keys(env).every((name) => allowed.includes(name))).toBe(true);
  expect(Object.values(env)).not.toContain("secret-value");
  expect(env.PORT).toBe("3000");
  expect(process.platform === "win32" ? env.USERPROFILE : env.HOME).toBe("/tmp/casper-isolated-home");
});

needsSymlinks("a final symlink is never read as configuration or state", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-platform-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const real = path.join(root, "real.json");
  const linked = path.join(root, "linked.json");
  await writeFile(real, "{}");
  await symlink(real, linked);
  const handle = await openNoFollow(real);
  try { expect((await handle.stat()).isFile()).toBe(true); } finally { await handle.close(); }
  // POSIX reports ELOOP from the flag itself; the fallback platform rejects by name.
  await expect(openNoFollow(linked)).rejects.toThrow(/symlink|ELOOP/i);
});
test("a group whose processes have all exited but are not reaped yet counts as stopped (macOS answers EPERM)", async () => {
  const table = new Map<number, ProcessRecord>([
    { pid: 1000, parent: 42, group: 1000, stamp: "adapter" },
    { pid: 3000, parent: 1, group: 3000, stamp: "unrelated" },
  ].map(record => [record.pid, record]));
  let alive = true;
  const signals: number[] = [];
  const platform: ProcessPlatform = {
    groups: true,
    list: async () => new Map(table),
    signalProcess: () => { throw new Error("not used with groups"); },
    signalGroup: (group) => {
      signals.push(group);
      const members = [...table.values()].filter((record) => record.group === group);
      // Like Darwin: a group of only zombies can't be signalled.
      if (members.length && members.every((record) => record.zombie)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      // The adapter exits on TERM but its parent has not reaped it yet.
      for (const record of members) table.set(record.pid, { ...record, zombie: true });
      alive = false;
    },
  };
  const owner = new OwnedProcesses(1000, () => alive, platform);
  await owner.capture();
  expect(await owner.stop()).toBe("stopped");
  expect(signals).toEqual([1000, 1000]);

  // A live member left in that group still makes the outcome unknown.
  table.set(1000, { pid: 1000, parent: 42, group: 1000, stamp: "adapter" });
  table.set(1002, { pid: 1002, parent: 1000, group: 1000, stamp: "child" });
  const stubborn: ProcessPlatform = { ...platform, signalGroup: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); } };
  const second = new OwnedProcesses(1000, () => true, stubborn);
  await second.capture();
  expect(await second.stop()).toBe("unknown");
});

test("a group whose leader has exited but a TERM-resistant member still runs is killed, and stopped only once that member is gone", async () => {
  // Linux: signalling a group with a zombie leader succeeds and reaches the live member.
  const table = new Map<number, ProcessRecord>([
    { pid: 1000, parent: 42, group: 1000, stamp: "shell" },
    { pid: 1001, parent: 1000, group: 1000, stamp: "stubborn" },
  ].map(record => [record.pid, record]));
  const signals: string[] = [];
  let ignoresKill = false;
  const platform: ProcessPlatform = {
    groups: true,
    list: async () => new Map(table),
    signalProcess: () => { throw new Error("not used with groups"); },
    signalGroup: (group, signal) => {
      signals.push(`${group}:${signal}`);
      // The shell exits on TERM and stays unreaped; its descendant ignores TERM and only KILL stops it.
      table.set(1000, { ...table.get(1000)!, zombie: true });
      if (signal === "SIGKILL" && !ignoresKill) table.delete(1001);
    },
  };
  const owner = new OwnedProcesses(1000, () => !table.get(1000)?.zombie, platform);
  await owner.capture();
  expect(await owner.stop()).toBe("stopped");
  expect(signals).toEqual(["1000:SIGTERM", "1000:SIGKILL"]);

  // If that member is still running after KILL, the group is not stopped: a zombie leader is not enough.
  table.set(1000, { pid: 1000, parent: 42, group: 1000, stamp: "shell" });
  table.set(1001, { pid: 1001, parent: 1000, group: 1000, stamp: "stubborn" });
  ignoresKill = true;
  const second = new OwnedProcesses(1000, () => !table.get(1000)?.zombie, platform);
  await second.capture();
  expect(await second.stop()).toBe("unknown");
});
