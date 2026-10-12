/**
 * Stalled commands: a bash command the model ran without its own timeout that prints nothing new for a while and whose
 * process tree uses (almost) no CPU over that time is waiting on nothing, such as a download that hung or a test run
 * that finished but kept a server open. Casper ends its whole tree and says why, instead of waiting out the limit.
 * Where the CPU can't be read (Windows, or no ps), nothing is ended: silence alone would end a quiet build.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Silence (with no CPU) that ends a command. */
export const STALL_SECONDS = 45;
/** CPU under this share of the silence counts as none. */
const IDLE_SHARE = 0.01;
/** The exit code a stalled command reports, as `timeout` does. */
export const STALLED_EXIT_CODE = 124;

/** Cumulative CPU seconds of each process in a command's tree, and the bytes they moved, so a slow download counts
 * as alive: on Linux file and pipe reads and writes plus TCP bytes, on macOS network bytes. "unknown" when the tree
 * holds a network socket whose bytes can't be counted: then it counts as busy. */
export interface TreeSample { cpu: Map<number, number>; io?: number | "unknown" }

/** `[[dd-]hh:]mm:ss[.cc]`, as ps prints CPU time on macOS and Linux. */
export function cpuSeconds(text: string): number | undefined {
  const [days, rest] = text.includes("-") ? text.split("-", 2) as [string, string] : ["0", text];
  const parts = rest.split(":").map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part)) || !Number.isFinite(Number(days))) return undefined;
  return Number(days) * 86_400 + parts.reduce((total, part) => total * 60 + part, 0);
}

/** The CPU of every process in the tree of `root`: its process group (the shell is started as a group leader) and
 * anything below it by parent, so a child that made its own group still counts. */
export function treeSample(root: number): Promise<TreeSample | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,pgid=,time="], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(undefined); return; }
      const rows: { pid: number; ppid: number; pgid: number; cpu: number }[] = [];
      for (const line of stdout.split("\n")) {
        const [pid, ppid, pgid, time] = line.trim().split(/\s+/);
        const cpu = time === undefined ? undefined : cpuSeconds(time);
        if (cpu !== undefined) rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), cpu });
      }
      const inside = new Set(rows.filter((row) => row.pid === root || row.pgid === root).map((row) => row.pid));
      for (let grew = true; grew;) {
        grew = false;
        for (const row of rows) if (!inside.has(row.pid) && inside.has(row.ppid)) { inside.add(row.pid); grew = true; }
      }
      const cpu = new Map(rows.filter((row) => inside.has(row.pid)).map((row) => [row.pid, process.platform === "linux" ? linuxCpu(row.pid) ?? row.cpu : row.cpu]));
      if (process.platform === "linux") { void linuxIo([...cpu.keys()]).then((io) => { resolve({ cpu, io }); }); return; }
      if (process.platform !== "darwin") { resolve({ cpu }); return; }
      void networkBytes([...cpu.keys()]).then((io) => { resolve({ cpu, ...(io === undefined ? {} : { io }) }); });
    });
  });
}

/** Linux ps prints CPU in whole seconds, coarser than the idle share: /proc/<pid>/stat has it in ticks. */
function linuxCpu(pid: number): number | undefined {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
    const ticks = Number(fields[11]) + Number(fields[12]);
    return Number.isFinite(ticks) ? ticks / 100 : undefined;
  } catch { return undefined; }
}

/** Network bytes in and out so far of these processes (macOS: nettop, no admin rights), so a quiet `git clone` or
 * `curl -s` that is still downloading is not ended. Undefined when nettop can't be read. */
function networkBytes(pids: number[]): Promise<number | undefined> {
  const wanted = new Set(pids);
  return new Promise((resolve) => {
    execFile("/usr/bin/nettop", ["-P", "-L", "1", "-n", "-x", "-J", "bytes_in,bytes_out"], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(undefined); return; }
      let total = 0;
      for (const line of stdout.split("\n")) {
        const match = /\.(\d+),(\d+),(\d+),?\s*$/.exec(line);
        if (match && wanted.has(Number(match[1]))) total += Number(match[2]) + Number(match[3]);
      }
      resolve(total);
    });
  });
}

/** Bytes these processes moved so far (Linux). /proc/<pid>/io counts read() and write() but not recv() and send(),
 * which is how curl, git and most programs use a socket, so TCP bytes come from `ss` by socket inode. A network
 * socket `ss` can't count (no `ss`, UDP, another network namespace) makes it "unknown". */
async function linuxIo(pids: number[]): Promise<number | "unknown"> {
  let total = 0;
  const sockets = new Set<string>();
  const network = new Set<string>();
  for (const pid of pids) {
    try {
      const text = readFileSync(`/proc/${pid}/io`, "utf8");
      total += Number(/^rchar:\s*(\d+)/m.exec(text)?.[1] ?? 0) + Number(/^wchar:\s*(\d+)/m.exec(text)?.[1] ?? 0);
    } catch { /* it ended, or can't be read */ }
    const mine = socketInodes(pid);
    if (!mine.length) continue;
    for (const inode of mine) sockets.add(inode);
    for (const table of ["tcp", "tcp6", "udp", "udp6", "raw", "raw6"]) {
      try {
        for (const line of readFileSync(`/proc/${pid}/net/${table}`, "utf8").split("\n").slice(1)) {
          const inode = line.trim().split(/\s+/)[9];
          if (inode && inode !== "0" && sockets.has(inode)) network.add(inode);
        }
      } catch { /* no such table */ }
    }
  }
  if (!network.size) return total;
  const counted = await tcpBytes();
  if (!counted) return "unknown";
  for (const inode of network) {
    const bytes = counted.get(inode);
    if (bytes === undefined) return "unknown";
    total += bytes;
  }
  return total;
}

/** The socket inodes a process has open. */
function socketInodes(pid: number): string[] {
  const inodes: string[] = [];
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try { const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`)); if (match) inodes.push(match[1]!); } catch { /* closed */ }
    }
  } catch { /* it ended, or can't be read */ }
  return inodes;
}

/** Bytes sent and received so far by each TCP socket, by inode (`ss` from iproute2). Undefined without `ss`. */
function tcpBytes(): Promise<Map<string, number> | undefined> {
  return new Promise((resolve) => {
    execFile("ss", ["-tanieH"], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(undefined); return; }
      const bytes = new Map<string, number>();
      // One socket is a line and the indented lines after it.
      for (const socket of stdout.split(/\n(?=\S)/)) {
        const inode = /\bino:(\d+)/.exec(socket)?.[1];
        if (!inode || inode === "0") continue;
        bytes.set(inode, Number(/\bbytes_received:(\d+)/.exec(socket)?.[1] ?? 0) + Number(/\bbytes_sent:(\d+)/.exec(socket)?.[1] ?? 0));
      }
      resolve(bytes);
    });
  });
}

/** Whether the tree did anything between two samples: CPU over the idle share, bytes moved (or bytes that can't be
 * counted), or a process started or ended. */
export function busyBetween(before: TreeSample, after: TreeSample, seconds: number): boolean {
  let used = 0;
  for (const [pid, cpu] of after.cpu) {
    const earlier = before.cpu.get(pid);
    if (earlier === undefined) return true;
    used += Math.max(0, cpu - earlier);
  }
  for (const pid of before.cpu.keys()) if (!after.cpu.has(pid)) return true;
  if (before.io === "unknown" || after.io === "unknown") return true;
  if (before.io !== undefined && after.io !== undefined && after.io !== before.io) return true;
  return used > seconds * IDLE_SHARE;
}

/** The last line it printed, short. */
export function lastLine(output: string): string {
  const line = output.split(/\r?\n|\r/).map((part) => part.trim()).filter(Boolean).at(-1) ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** The words the AI reads: what happened, and a hint when the output or the command says why. */
export function stalledMessage(command: string, output: string, seconds: number): string {
  const last = lastLine(output);
  const tail = output.split(/\r?\n/).slice(-12).join("\n");
  const lines = [`[stalled: no output and no CPU for ${seconds} s ${last ? `after: ${last}` : "(it printed nothing)"}. Casper ended it and what it started; to wait on purpose, give it a timeout.`];
  if (/^\s*(?:ℹ\s*|#\s*)?(?:tests?|pass|fail)\s+\d+\s*$|\b\d+\s+(?:passed|failed|passing|failing)\b|^Tests?:\s+\d+|\bRan \d+ tests?\b|^ok\b/im.test(tail)) {
    lines.push("The tests finished but something is still open (a server, timer or connection): close it in the test teardown.");
  }
  if (/\bplaywright(?:@\S*)?\s+install\b|\bbrowsers\s+install\b/.test(command)) {
    lines.push("Casper already has a browser: use the browser tool instead of installing one.");
  }
  return `\n${lines.join(" ")}]\n`;
}

/** Where the command's shell writes its process id: a line run first, before any sandbox wrap, by the shell Pi
 * starts as a process group leader. Nothing on Windows, where CPU is not read and nothing is ended. */
export function pidFile(dir: string | undefined): { prefix: string; root(): Promise<number | undefined>; remove(): void } {
  if (process.platform === "win32") return { prefix: "", root: async () => undefined, remove: () => {} };
  const file = path.join(dir ?? os.tmpdir(), `casper-pid-${randomBytes(8).toString("hex")}`);
  let known: number | undefined;
  return {
    prefix: `{ printf %s $$ > '${file.replaceAll("'", "'\\''")}'; } 2>/dev/null; `,
    root: async () => {
      if (known === undefined) { const pid = Number((await readFile(file, "utf8").catch(() => "")).trim()); if (pid > 0) known = pid; }
      return known;
    },
    remove: () => { void rm(file, { force: true }).catch(() => {}); },
  };
}

export interface StallWatchOptions {
  /** Silence, with no CPU, that ends it. Where CPU can't be read it is never ended. */
  seconds: number;
  /** The process group leader of the command (its shell), once known. */
  root(): Promise<number | undefined>;
  /** Called once when it stalled. */
  onStall(): void;
  /** For tests: how CPU is read. */
  sample?(root: number): Promise<TreeSample | undefined>;
}

/** Watches one running command. `output()` on every chunk it prints; `stop()` when it ended. */
export function watchStall(options: StallWatchOptions): { output(): void; stop(): void } {
  const windowMs = options.seconds * 1000;
  const canSample = process.platform !== "win32";
  const sample = options.sample ?? treeSample;
  const samples: { at: number; tree: TreeSample }[] = [];
  const started = Date.now();
  let lastOutput = started, done = !canSample, busy = false, misses = 0;
  const tick = async () => {
    if (done || busy) return;
    busy = true;
    try {
      const now = Date.now();
      const silent = now - lastOutput;
      const root = await options.root();
      const tree = root === undefined ? undefined : await sample(root);
      if (done) return;
      // Silence alone is not enough (a quiet build is busy): when the tree can't be read, it is left alone. One slow
      // read on a busy machine is not "can't".
      if (!tree) { if (root === undefined ? now - started >= windowMs : ++misses >= 3) done = true; return; }
      misses = 0;
      // When the tick began, not when the sample came back: a slow read must not push the end a whole tick later.
      const at = now;
      samples.push({ at, tree });
      // Keep the newest sample at least a window old, and the ones after it.
      while (samples.length > 1 && samples[1]!.at <= at - windowMs) samples.shift();
      const first = samples[0]!;
      if (silent < windowMs || at - first.at < windowMs) return;
      if (busyBetween(first.tree, tree, (at - first.at) / 1000)) return;
      done = true;
      options.onStall();
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, Math.max(200, Math.min(15_000, windowMs / 4)));
  timer.unref?.();
  return {
    output: () => { lastOutput = Date.now(); },
    stop: () => { done = true; clearInterval(timer); },
  };
}
