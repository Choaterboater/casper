import { dlopen, FFIType, ptr } from "bun:ffi";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** `zombie`: the process has exited and only waits to be reaped; it can't run again or be signalled (macOS
 * answers a signal to a group of only such processes with EPERM). */
export interface ProcessRecord { pid: number; parent: number; group: number; stamp: string; zombie?: boolean }
export type CleanupOutcome = "stopped" | "unknown";

export class ProcessCleanupError extends Error {
  constructor() { super("Owned process cleanup is unconfirmed. Inspect the owned processes before starting more work; restarting does not prove cleanup."); }
}

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
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (match) all.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), stamp: match[5]!, ...(match[4]!.startsWith("Z") ? { zombie: true } : {}) });
  }
  if (!all.size) throw new Error("Process listing was empty");
  return all;
}

async function listPosix(): Promise<Map<number, ProcessRecord>> {
  let failure: unknown;
  for (const command of PS_COMMANDS) {
    try {
      const { stdout } = await exec(command, ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
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

/** One raw Windows process row: `created` is the creation time in 100 ns units (a FILETIME). */
export interface WindowsProcessRow { pid: number; parent: number; created: bigint }

/**
 * Windows keeps a child's parent PID after the parent exits, and that PID can then name a new
 * process. A parent that started after its child can't be the real parent, so that link is cut
 * (parent 0) and the newer process never inherits the old child.
 */
export function windowsProcessTable(rows: Iterable<WindowsProcessRow>): Map<number, ProcessRecord> {
  const valid = [...rows].filter(row => Number.isInteger(row.pid) && row.pid > 0);
  const created = new Map(valid.map(row => [row.pid, row.created]));
  const all = new Map<number, ProcessRecord>();
  for (const row of valid) {
    const parentCreated = created.get(row.parent);
    const real = row.parent !== row.pid && parentCreated !== undefined && parentCreated <= row.created;
    all.set(row.pid, { pid: row.pid, parent: real ? row.parent : 0, group: 0, stamp: String(row.created) });
  }
  if (!all.size) throw new Error("Process listing was empty");
  return all;
}

const SYSTEM_PROCESS_INFORMATION = 5;
const STATUS_INFO_LENGTH_MISMATCH = 0xC0000004;
type NativeQuery = (buffer: Uint8Array) => { status: number; needed: number };
let nativeQuery: NativeQuery | null | undefined;
let nativeBuffer = new Uint8Array(0);

/**
 * The kernel's own process list, read in one call: PID, parent PID and creation time come from
 * the same instant, so a PID reused between two calls can't be paired with another process's
 * data. It takes a few milliseconds; a PowerShell CIM query takes 0.3 to 2 s. Both 64-bit
 * Windows targets (x64, arm64) share this layout; anything else uses PowerShell.
 */
function loadNativeQuery(): NativeQuery | null {
  if (nativeQuery !== undefined) return nativeQuery;
  nativeQuery = null;
  if (process.platform !== "win32" || (process.arch !== "x64" && process.arch !== "arm64")) return nativeQuery;
  try {
    const { symbols } = dlopen("ntdll.dll", {
      NtQuerySystemInformation: { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    });
    const needed = new Uint32Array(1);
    nativeQuery = (buffer) => {
      needed[0] = 0;
      const status = symbols.NtQuerySystemInformation(SYSTEM_PROCESS_INFORMATION, ptr(buffer), buffer.byteLength, ptr(needed)) >>> 0;
      return { status, needed: needed[0]! };
    };
  } catch { nativeQuery = null; }
  return nativeQuery;
}

/** Undefined when the native list can't be loaded at all; throws when it loaded but failed. */
function nativeProcessRows(): WindowsProcessRow[] | undefined {
  const query = loadNativeQuery();
  if (!query) return undefined;
  if (!nativeBuffer.byteLength) nativeBuffer = new Uint8Array(1 << 20);
  for (let attempt = 0; attempt < 6; attempt++) {
    const { status, needed } = query(nativeBuffer);
    if (status === STATUS_INFO_LENGTH_MISMATCH) {
      const size = Math.max(nativeBuffer.byteLength * 2, needed + (1 << 16));
      if (size > 64 << 20) break;
      nativeBuffer = new Uint8Array(size);
      continue;
    }
    if (status !== 0) throw new Error(`Process listing failed (status 0x${status.toString(16)})`);
    const view = new DataView(nativeBuffer.buffer, nativeBuffer.byteOffset, nativeBuffer.byteLength);
    const rows: WindowsProcessRow[] = [];
    // SYSTEM_PROCESS_INFORMATION (64-bit): NextEntryOffset at 0, CreateTime at 0x20,
    // UniqueProcessId at 0x50, InheritedFromUniqueProcessId (the parent) at 0x58.
    for (let offset = 0; ;) {
      if (offset + 0x60 > view.byteLength) throw new Error("Process listing was malformed");
      rows.push({
        pid: Number(view.getBigUint64(offset + 0x50, true)),
        parent: Number(view.getBigUint64(offset + 0x58, true)),
        created: view.getBigUint64(offset + 0x20, true),
      });
      const next = view.getUint32(offset, true);
      if (!next) return rows;
      if (rows.length > 1 << 20) throw new Error("Process listing was malformed");
      offset += next;
    }
  }
  throw new Error("Process listing kept growing");
}

async function listWindows(): Promise<Map<number, ProcessRecord>> {
  // Once the native list loads it is the only source, so stamps never mix two formats.
  const native = nativeProcessRows();
  if (native) return windowsProcessTable(native);
  try {
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_PS_QUERY], {
      encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    const rows: WindowsProcessRow[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const [pid, parent, stamp] = line.split(",").map(field => field.trim());
      if (!pid || !parent || !stamp || !/^\d+$/.test(pid) || !/^\d+$/.test(parent) || !/^\d+$/.test(stamp)) continue;
      rows.push({ pid: Number(pid), parent: Number(parent), created: BigInt(stamp) });
    }
    return windowsProcessTable(rows);
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
 * `alive` is the caller's own view of the root (exitCode/signalCode). Only a root
 * that is not a group leader (the MCP SDK spawns without `detached`) needs the
 * bare-PID fallback, and only while it provably has not been reaped: a reaped
 * PID may already belong to an unrelated process.
 */
export function terminateTree(owner: OwnedProcesses | undefined, group: number | null | undefined, signal: NodeJS.Signals,
  alive?: () => boolean): Promise<CleanupOutcome> {
  // The owner decides the platform. This is also the simulated-Windows test seam.
  if (owner) return owner.stop();
  if (group === null || group === undefined) return Promise.resolve("stopped");
  if (osSupportsProcessGroups) {
    try { process.kill(-group, signal); }
    catch (error) {
      // A root that is not a group leader has no group to signal; target it directly while alive.
      if ((error as NodeJS.ErrnoException).code === "ESRCH" && alive?.()) { try { process.kill(group, signal); } catch { /* already exited */ } }
    }
    // POSIX retains its existing best-effort exact-group signal policy. This is
    // not an OS-parentage verification of every descendant's exit.
    return Promise.resolve("stopped");
  }
  return Promise.resolve("unknown");
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
  private stopping?: Promise<CleanupOutcome>;
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

  stop(): Promise<CleanupOutcome> {
    // TERM, escalation and close callbacks all drain the same cleanup, including
    // its unknown result. Repeated calls must not launch competing OS scans.
    return this.stopping ??= this.finishStop();
  }

  private async finishStop(): Promise<CleanupOutcome> {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (this.platform.groups) {
        const all = await this.capture();
        for (const group of [...this.groups].sort((a, b) => Number(a === this.root) - Number(b === this.root))) {
          const verified = [...this.owned.values()].some(item => item.group === group && all.get(item.pid)?.stamp === item.stamp && all.get(item.pid)?.group === group);
          if (!verified && !(group === this.root && this.rootAlive())) continue;
          try { this.platform.signalGroup(group, signal); } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // macOS refuses a signal to a group whose members have all exited but are not reaped yet (EPERM).
            const now = code === "EPERM" ? await this.platform.list().catch(() => undefined) : undefined;
            const onlyExited = now !== undefined && ![...now.values()].some(item => item.group === group && !item.zombie);
            if (code !== "ESRCH" && !onlyExited) this.uncertain = true;
          }
        }
      } else await this.terminateRecords(signal);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const all = await this.capture();
    // An exited process waiting to be reaped is not running: it counts as stopped.
    const remaining = [...this.owned.values()].some(item => all.get(item.pid)?.stamp === item.stamp && !all.get(item.pid)?.zombie);
    return remaining || this.uncertain ? "unknown" : "stopped";
  }
}