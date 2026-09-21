import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ProcessRecord { pid: number; parent: number; group: number; stamp: string }

/** OS observations behind one seam, so non-host platform behavior stays testable. */
export interface ProcessPlatform {
  /** True when the OS signals a whole process group as a unit (POSIX). */
  readonly groups: boolean;
  /** Current process table. Throws when the OS listing cannot be trusted. */
  list(): Promise<Map<number, ProcessRecord>>;
  signalProcess(pid: number, signal: NodeJS.Signals): void;
  signalGroup(group: number, signal: NodeJS.Signals): void;
}

// /bin/ps is not present on every Linux distribution, so try known locations
// before falling back to PATH resolution.
const PS_COMMANDS = ["/bin/ps", "/usr/bin/ps", "ps"];

function parsePS(stdout: string): Map<number, ProcessRecord> {
  const all = new Map<number, ProcessRecord>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (match) all.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), stamp: match[4] });
  }
  if (!all.size) throw new Error("Process listing was empty");
  return all;
}

async function listPosix(): Promise<Map<number, ProcessRecord>> {
  let failure: unknown;
  for (const command of PS_COMMANDS) {
    try {
      const { stdout } = await exec(command, ["-axo", "pid=,ppid=,pgid=,lstart="], {
        encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" }, windowsHide: true,
      });
      return parsePS(stdout);
    } catch (error) { failure = error; }
  }
  throw failure instanceof Error ? failure : new Error("Process listing is unavailable");
}

// Creation times are compared as identity stamps; ToFileTimeUtc is locale- and
// format-stable, unlike the rendered DateTime that ConvertTo-Csv would emit.
const WINDOWS_PS_QUERY = "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1},{2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() }";

function parseWindowsRows(stdout: string, columns: (fields: string[]) => ProcessRecord | undefined): Map<number, ProcessRecord> {
  const all = new Map<number, ProcessRecord>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = columns(line.split(",").map(field => field.trim()));
    if (record && Number.isInteger(record.pid) && record.pid > 0) all.set(record.pid, record);
  }
  if (!all.size) throw new Error("Process listing was empty");
  return all;
}

async function listWindows(): Promise<Map<number, ProcessRecord>> {
  try {
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_PS_QUERY], {
      encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    return parseWindowsRows(stdout, ([pid, parent, stamp]) => {
      const record = { pid: Number(pid), parent: Number(parent), group: 0, stamp: stamp ?? "" };
      return record.pid > 0 && Number.isInteger(record.parent) && record.stamp ? record : undefined;
    });
  } catch (error) {
    // wmic is deprecated but is the only remaining source of parentage where
    // PowerShell is unavailable; CSV column order is documented and fixed.
    try {
      const { stdout } = await exec("wmic", ["path", "Win32_Process", "get", "ProcessId,ParentProcessId,CreationDate", "/format:csv"], {
        encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      });
      return parseWindowsRows(stdout, fields => {
        const [node, stamp, parent, pid] = fields;
        if (!node || !stamp || stamp === "CreationDate") return undefined;
        return { pid: Number(pid), parent: Number(parent), group: 0, stamp };
      });
    } catch { throw error instanceof Error ? error : new Error("Process listing is unavailable"); }
  }
}

/** POSIX platform: process groups are the primary ownership unit. */
export const posixProcessPlatform: ProcessPlatform = {
  groups: true,
  list: listPosix,
  signalProcess: (pid, signal) => { process.kill(pid, signal); },
  signalGroup: (group, signal) => { process.kill(-group, signal); },
};

/** Windows platform: no process groups, so verified PIDs are terminated individually. */
export const windowsProcessPlatform: ProcessPlatform = {
  groups: false,
  list: listWindows,
  signalProcess: (pid, signal) => { process.kill(pid, signal); },
  signalGroup: () => { throw new Error("Process groups are unavailable on Windows"); },
};

export const hostProcessPlatform = (): ProcessPlatform =>
  process.platform === "win32" ? windowsProcessPlatform : posixProcessPlatform;

/** Windows has no process groups; spawned trees are terminated through OS parentage. */
export const osSupportsProcessGroups = process.platform !== "win32";

/**
 * Owns one spawned root only where the OS cannot signal a whole group. POSIX
 * consumers keep their cheaper exact-group path; Windows tracks real descendants.
 */
export function ownSpawnedTree(pid: number | null | undefined, alive: () => boolean): OwnedProcesses | undefined {
  if (osSupportsProcessGroups || !pid) return undefined;
  const owner = new OwnedProcesses(pid, alive, hostProcessPlatform());
  void owner.capture();
  return owner;
}

/**
 * One termination policy for every spawned tree: the POSIX process group when
 * the OS has groups, otherwise verified OS descendants (never reported PIDs).
 */
export function terminateTree(owner: OwnedProcesses | undefined, group: number | null | undefined, signal: NodeJS.Signals): void {
  if (osSupportsProcessGroups) {
    if (group === null || group === undefined) return;
    try { process.kill(-group, signal); }
    catch (error) {
      // A root that is not a group leader has no group to signal; target it directly.
      if ((error as NodeJS.ErrnoException).code === "ESRCH") { try { process.kill(group, signal); } catch { /* already exited */ } }
    }
    return;
  }
  void owner?.stop();
}

/**
 * Best-effort, non-atomic ownership of one spawned root and its descendants.
 * Records are keyed by PID and re-verified against an OS identity stamp, so a
 * reused PID is never mistaken for an owned process. Termination never trusts
 * adapter-reported PIDs: only OS parentage observed from the spawned root.
 */
export class OwnedProcesses {
  private readonly owned = new Map<number, ProcessRecord>();
  private readonly groups = new Set<number>();
  private scanning?: Promise<Map<number, ProcessRecord>>;
  private uncertain = false;
  constructor(
    private readonly root: number,
    private readonly rootAlive: () => boolean,
    private readonly platform: ProcessPlatform = hostProcessPlatform(),
  ) {
    if (this.platform.groups) this.groups.add(root);
  }

  capture(): Promise<Map<number, ProcessRecord>> {
    if (this.scanning) return this.scanning;
    this.scanning = this.scan().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  async captureCurrent(): Promise<Map<number, ProcessRecord>> {
    // An in-flight scan may have taken its snapshot before the debuggee was spawned.
    // Drain it, then take a new snapshot while the adapter still retains parentage.
    await this.scanning;
    return this.capture();
  }

  private async scan(): Promise<Map<number, ProcessRecord>> {
    try {
      const all = await this.platform.list();
      const live = new Set<number>();
      for (const [pid, previous] of this.owned) if (all.get(pid)?.stamp === previous.stamp) live.add(pid);
      const root = all.get(this.root);
      if (root && this.rootAlive() && (!this.owned.has(this.root) || this.owned.get(this.root)!.stamp === root.stamp)) live.add(this.root);
      for (let depth = 0; depth < 64; depth++) {
        const size = live.size;
        for (const item of all.values()) if (live.has(item.parent)) live.add(item.pid);
        if (live.size > 1024) throw new Error("Process budget");
        if (live.size === size) break;
      }
      for (const pid of live) {
        const item = all.get(pid)!;
        if (!this.owned.has(pid) && this.owned.size >= 4096) throw new Error("Process identity budget");
        this.owned.set(pid, item);
        // Only own a group if its leader is also a proven descendant.
        if (this.platform.groups && live.has(item.group)) this.groups.add(item.group);
      }
      return all;
    } catch { this.uncertain = true; return new Map(); }
  }

  /** Distance from the owned root along OS parentage; unreachable records sort first. */
  private depth(pid: number, all: Map<number, ProcessRecord>): number {
    let depth = 0;
    let current = all.get(pid);
    for (let steps = 0; steps < 64 && current; steps++) {
      if (current.pid === this.root) return depth;
      depth++;
      current = all.get(current.parent);
    }
    return Number.MAX_SAFE_INTEGER;
  }

  /** Platforms without process groups terminate verified records children-first. */
  private async terminateRecords(signal: NodeJS.Signals): Promise<void> {
    const all = await this.capture();
    const live = [...this.owned.values()]
      .filter(item => all.get(item.pid)?.stamp === item.stamp)
      .sort((left, right) => this.depth(right.pid, all) - this.depth(left.pid, all));
    for (const item of live) {
      if (item.pid === this.root && !this.rootAlive()) continue;
      try { this.platform.signalProcess(item.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.uncertain = true; }
    }
  }

  async stop(): Promise<"stopped" | "unknown"> {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (this.platform.groups) {
        const all = await this.capture();
        for (const group of [...this.groups].sort((a, b) => Number(a === this.root) - Number(b === this.root))) {
          const verified = [...this.owned.values()].some(item => item.group === group && all.get(item.pid)?.stamp === item.stamp && all.get(item.pid)?.group === group);
          if (!verified && !(group === this.root && this.rootAlive())) continue;
          try { this.platform.signalGroup(group, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.uncertain = true; }
        }
      } else await this.terminateRecords(signal);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const all = await this.capture();
    const remaining = [...this.owned.values()].some(item => all.get(item.pid)?.stamp === item.stamp);
    return remaining || this.uncertain ? "unknown" : "stopped";
  }
}