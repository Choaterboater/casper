import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  OwnedProcesses, ProcessCleanupError, posixProcessPlatform,
  type CleanupProcess, type ProcessPlatform, type ProcessRecord,
} from "../src/platform/processes";

async function until(condition: () => boolean | Promise<boolean>, timeout = 10_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(25);
  }
  throw new Error("Cleanup fixture did not reach the expected condition");
}

function byPid(records: CleanupProcess[]): CleanupProcess[] {
  return records.sort((left, right) => left.pid - right.pid);
}

test("a cleanup error without an owner cannot report or claim to stop processes", async () => {
  const error = new ProcessCleanupError();
  expect(await error.running()).toEqual([]);
  expect(await error.stop()).toBe("unknown");
});

test("cleanup reports verified live identities, root-group members and optional commands", async () => {
  const records: ProcessRecord[] = [
    { pid: 1000, parent: 42, group: 1000, stamp: "root", command: "runner --suite narrow" },
    // Same owned group, but parentage was lost before the first snapshot.
    { pid: 1001, parent: 1, group: 1000, stamp: "worker", command: "worker --jobs=2" },
    { pid: 1002, parent: 1000, group: 1002, stamp: "optional-command" },
    { pid: 1003, parent: 1000, group: 1003, stamp: "old-worker", command: "old-worker" },
    { pid: 1004, parent: 1000, group: 1000, stamp: "exited", zombie: true, command: "exited-worker" },
    { pid: 2000, parent: 1, group: 2000, stamp: "unrelated", command: "unrelated-service" },
  ];
  const table = new Map(records.map(record => [record.pid, record]));
  const platform: ProcessPlatform = {
    groups: true,
    list: async () => new Map(table),
    signalProcess: () => { throw new Error("Reporting must not signal a process"); },
    signalGroup: () => { throw new Error("Reporting must not signal a group"); },
  };
  const owner = new OwnedProcesses(1000, () => true, platform);
  await owner.capture();
  table.set(1003, { pid: 1003, parent: 1, group: 3000, stamp: "reused", command: "not-owned" });

  const running = byPid(await owner.remaining());
  expect(running.map(record => record.pid)).toEqual([1000, 1001, 1002]);
  expect(running.slice(0, 2)).toEqual([
    { pid: 1000, group: 1000, command: "runner --suite narrow" },
    { pid: 1001, group: 1000, command: "worker --jobs=2" },
  ]);
  // Simulated/native platform records may omit command text; the report still needs a printable label.
  expect(running[2]!.group).toBe(1002);
  expect(typeof running[2]!.command).toBe("string");
  expect(running[2]!.command.trim().length).toBeGreaterThan(0);
  expect(byPid(await new ProcessCleanupError(owner).running())).toEqual(running);
});

for (const groups of [false, true]) {
  test(`explicit user Stop retries an unknown cleanup and rechecks verified ownership (groups=${groups})`, async () => {
    const records: ProcessRecord[] = [
      { pid: 1000, parent: 42, group: groups ? 1000 : 0, stamp: "root", command: "runner" },
      { pid: 1001, parent: 1000, group: groups ? 1001 : 0, stamp: "worker", command: "worker --watch" },
      { pid: 1002, parent: 1000, group: groups ? 1002 : 0, stamp: "old-worker", command: "old-worker" },
      { pid: 1003, parent: 1000, group: groups ? 1003 : 0, stamp: "displayed-worker", command: "displayed-worker" },
      { pid: 2000, parent: 1, group: groups ? 2000 : 0, stamp: "unrelated", command: "unrelated-service" },
    ];
    const table = new Map(records.map(record => [record.pid, record]));
    const events: string[] = [];
    let permitted = false;
    const signal = (kind: "process" | "group", id: number) => {
      events.push(`${kind}:${id}`);
      if (!permitted) throw Object.assign(new Error("Stop denied"), { code: "EPERM" });
      for (const item of table.values()) {
        if ((kind === "group" ? item.group : item.pid) === id) table.delete(item.pid);
      }
    };
    const platform: ProcessPlatform = {
      groups,
      list: async () => { events.push("list"); return new Map(table); },
      signalProcess: pid => signal("process", pid),
      signalGroup: group => signal("group", group),
    };
    const owner = new OwnedProcesses(1000, () => table.has(1000), platform);
    await owner.capture();
    expect(await owner.stop()).toBe("unknown");
    const previousEvents = events.length;
    expect(await owner.stop()).toBe("unknown");
    expect(events.length).toBe(previousEvents); // Automatic cleanup stays drained; only explicit Stop retries.

    // Already-reused PIDs must not appear in the report.
    table.set(1002, { pid: 1002, parent: 1, group: groups ? 3000 : 0, stamp: "reused", command: "not-owned" });
    const error = new ProcessCleanupError(owner);
    expect(byPid(await error.running()).map(record => record.pid)).toEqual([1000, 1001, 1003]);
    // Reuse after display, while the user is choosing Stop. Keep the same group ID too:
    // neither a cached PID nor a cached group may target this replacement identity.
    const replacement: ProcessRecord = {
      pid: 1003, parent: 1, group: groups ? 1003 : 0, stamp: "reused-after-display", command: "not-owned-either",
    };
    table.set(1003, replacement);
    permitted = true;
    events.length = 0;
    expect(await error.stop()).toBe("stopped");
    expect(events.filter(event => event !== "list")).toEqual([
      `${groups ? "group" : "process"}:1001`, `${groups ? "group" : "process"}:1000`,
    ]);
    expect(events.at(-1)).toBe("list");
    expect(events).not.toContain("process:1003");
    expect(events).not.toContain("group:1003");
    expect(table.get(1003)).toEqual(replacement);
    expect([...table.keys()].sort()).toEqual([1002, 1003, 2000]);
    expect(await error.running()).toEqual([]);
    expect(await owner.retryStop()).toBe("stopped");
  });

  test(`explicit user Stop stays unknown when successful signals leave a verified survivor (groups=${groups})`, async () => {
    const survivor: ProcessRecord = {
      pid: 1001, parent: 1000, group: groups ? 1001 : 0, stamp: "survivor", command: "worker --still-running",
    };
    const root: ProcessRecord = { pid: 1000, parent: 42, group: groups ? 1000 : 0, stamp: "root", command: "runner" };
    const table = new Map([root, survivor].map(record => [record.pid, record]));
    const signals: string[] = [];
    const platform: ProcessPlatform = {
      groups,
      list: async () => new Map(table),
      // Success acknowledges delivery, not exit: only the root exits; its worker survives.
      signalProcess: pid => { signals.push(`process:${pid}`); if (pid === root.pid) table.delete(root.pid); },
      signalGroup: group => { signals.push(`group:${group}`); if (group === root.group) table.delete(root.pid); },
    };
    const owner = new OwnedProcesses(root.pid, () => table.has(root.pid), platform);
    await owner.capture();
    expect(await owner.stop()).toBe("unknown");
    const error = new ProcessCleanupError(owner);
    const expected = [{ pid: survivor.pid, group: survivor.group, command: "worker --still-running" }];
    expect(await error.running()).toEqual(expected);

    signals.length = 0;
    expect(await error.stop()).toBe("unknown");
    expect(signals).toContain(`${groups ? "group" : "process"}:${survivor.pid}`);
    expect(table.has(root.pid)).toBe(false);
    expect(table.get(survivor.pid)).toEqual(survivor);
    expect(await error.running()).toEqual(expected);
  }, 15_000);
}

for (const capturedRoot of [false, true]) test(`a root exiting during an initial in-flight snapshot retains authority (root captured=${capturedRoot})`, async () => {
  let alive = true, calls = 0;
  let finish!: (table: Map<number, ProcessRecord>) => void;
  const initial = new Promise<Map<number, ProcessRecord>>(resolve => { finish = resolve; });
  const table = new Map<number, ProcessRecord>();
  const signals: number[] = [];
  const owner = new OwnedProcesses(1000, () => alive, {
    groups: true, list: async () => ++calls === 1 ? initial : new Map(table),
    signalProcess: pid => { signals.push(pid); table.delete(pid); },
    signalGroup: group => { signals.push(group); for (const item of table.values()) if (item.group === group) table.delete(item.pid); },
  });
  const pending = owner.capture(); // Snapshot begins before the newly spawned root is visible.
  alive = false; // Root exits before that old observation completes.
  finish(capturedRoot ? new Map([[1000, { pid: 1000, parent: 42, group: 1000, stamp: "root", command: "runner" }]]) : new Map());
  await pending;
  const orphan: ProcessRecord = { pid: 1001, parent: 1, group: 1000, stamp: "orphan", command: "surviving worker" };
  table.set(orphan.pid, orphan);
  const error = new ProcessCleanupError(owner);
  expect(await error.running()).toEqual([{ pid: orphan.pid, group: 1000, command: "surviving worker" }]);
  expect(await error.stop()).toBe("stopped");
  expect(signals).toContain(1000);
  expect(table.size).toBe(0);
});

test("an observed extinct root group is never reacquired through a reused orphan group", async () => {
  const root: ProcessRecord = { pid: 1000, parent: 42, group: 1000, stamp: "root", command: "runner" };
  const table = new Map([[root.pid, root]]);
  const signals: number[] = [];
  const owner = new OwnedProcesses(root.pid, () => table.get(root.pid)?.stamp === root.stamp, {
    groups: true, list: async () => new Map(table),
    signalProcess: pid => { signals.push(pid); }, signalGroup: group => { signals.push(group); },
  });
  await owner.capture();
  table.clear();
  await owner.capture(); // Original group is now definitively extinct.
  const unrelated: ProcessRecord = { pid: 2001, parent: 1, group: root.group, stamp: "unrelated", command: "unrelated worker" };
  table.set(unrelated.pid, unrelated); // A reused leader already exited between snapshots.
  const error = new ProcessCleanupError(owner);
  expect(await error.running()).toEqual([]);
  expect(await error.stop()).toBe("stopped");
  expect(signals).toEqual([]);
  expect(table.get(unrelated.pid)).toEqual(unrelated);
});

test("an owned descendant group retains an unobserved orphan after its leader exits", async () => {
  const root: ProcessRecord = { pid: 1000, parent: 42, group: 1000, stamp: "root", command: "runner" };
  const leader: ProcessRecord = { pid: 1100, parent: root.pid, group: 1100, stamp: "leader", command: "worker leader" };
  const table = new Map([root, leader].map(record => [record.pid, record]));
  const signals: number[] = [];
  const owner = new OwnedProcesses(root.pid, () => table.has(root.pid), {
    groups: true, list: async () => new Map(table),
    signalProcess: pid => { signals.push(pid); table.delete(pid); },
    signalGroup: group => { signals.push(group); for (const item of table.values()) if (item.group === group) table.delete(item.pid); },
  });
  await owner.capture();
  table.clear();
  const orphan: ProcessRecord = { pid: 1101, parent: 1, group: leader.group, stamp: "orphan", command: "surviving worker" };
  table.set(orphan.pid, orphan);
  const error = new ProcessCleanupError(owner);
  expect(await error.running()).toEqual([{ pid: orphan.pid, group: leader.group, command: "surviving worker" }]);
  expect(await error.stop()).toBe("stopped");
  expect(signals).toContain(leader.group);
  expect(table.size).toBe(0);
});

test("explicit retry stays unknown while the OS cannot verify identities", async () => {
  let listingAvailable = true;
  let signals = 0;
  const platform: ProcessPlatform = {
    groups: false,
    list: async () => {
      if (!listingAvailable) throw new Error("Process listing is unavailable");
      return new Map([[1000, { pid: 1000, parent: 42, group: 0, stamp: "root", command: "runner" }]]);
    },
    signalProcess: () => { signals++; },
    signalGroup: () => { throw new Error("Groups unavailable"); },
  };
  const owner = new OwnedProcesses(1000, () => true, platform);
  await owner.capture();
  listingAvailable = false;
  expect(await owner.stop()).toBe("unknown");
  const error = new ProcessCleanupError(owner);
  expect(await error.running()).toEqual([]); // No stale PIDs presented as verified live processes.
  expect(await error.stop()).toBe("unknown");
  expect(await owner.retryStop()).toBe("unknown");
  expect(signals).toBe(0);
});

// Real POSIX ps commands/group signalling; Windows has neither /bin/sh nor POSIX groups.
test.skipIf(process.platform === "win32")("a real owned tree reports PID and command, then user Stop kills and rechecks it", async () => {
  const child = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 30 & printf '%s\\n' \"$!\"; wait", "casper-cleanup-root"], {
    detached: true, stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", chunk => { output += chunk; });
  let permitted = false;
  const platform: ProcessPlatform = {
    ...posixProcessPlatform,
    signalGroup: (group, signal) => {
      if (!permitted) throw Object.assign(new Error("Simulated first-stop denial"), { code: "EPERM" });
      posixProcessPlatform.signalGroup(group, signal);
    },
  };
  const owner = new OwnedProcesses(child.pid!, () => child.exitCode === null && child.signalCode === null, platform);
  let identities: ProcessRecord[] = [];
  const cleanup = async () => {
    // Always stop this fixture's detached group, even if an API/assertion fails midway.
    try { process.kill(-child.pid!, "SIGKILL"); } catch (error) {
      if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    await until(() => child.exitCode !== null || child.signalCode !== null);
    await until(async () => {
      const all = await posixProcessPlatform.list();
      return ![...all.values()].some(record => record.group === child.pid! && !record.zombie);
    });
  };
  try {
    await until(() => /^\d+\n/.test(output));
    const worker = Number(output.trim());
    const snapshot = await owner.captureCurrent();
    identities = [snapshot.get(child.pid!)!, snapshot.get(worker)!];
    expect(identities.every(Boolean)).toBe(true);
    expect(await owner.stop()).toBe("unknown");
    const error = new ProcessCleanupError(owner);
    let running: CleanupProcess[] = [];
    await until(async () => {
      running = await error.running();
      return [child.pid!, worker].every(pid => running.some(record => record.pid === pid));
    });
    expect(running.find(record => record.pid === child.pid!)!.command).toContain("casper-cleanup-root");
    expect(running.find(record => record.pid === worker)!.command).toMatch(/\bsleep\s+30\b/);
    expect(running.every(record => record.group === child.pid!)).toBe(true);

    permitted = true;
    expect(await error.stop()).toBe("stopped");
    await until(async () => (await error.running()).length === 0);
    // Independently recheck the OS table, not just the owner's cached cleanup result.
    await until(async () => {
      const all = await posixProcessPlatform.list();
      return identities.every(record => {
        const current = all.get(record.pid);
        return !current || current.stamp !== record.stamp || current.zombie;
      });
    });
  } finally { await cleanup(); }
}, 30_000);
