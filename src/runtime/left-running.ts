/**
 * What a shell command left running on its own: every command the AI runs carries a marker in its environment
 * (COMMAND_MARK), which its children inherit. Casper ends the call's process tree when the call returns, but a child that
 * detached itself (setsid, a detached spawn whose launcher exited at once) is out of reach of that and of the tree
 * Casper watches. After the call, the processes still carrying the call's marker are found here and become Casper's
 * background jobs (/tasks, the receipt's "◐ Still running", a note when they end) instead of running unseen.
 *
 * Linux reads /proc/<pid>/environ (your own processes). macOS reads `ps -E`, which shows the environment of your own
 * processes except Apple's system programs (sh, sleep): the node, python or bun a runner starts is found, and the root
 * of what is found is the job. Windows: nothing is found (its jobs stop with their call's tree).
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";

export const COMMAND_MARK = "CASPER_COMMAND_ID";
const run = promisify(execFile);

export interface LeftProcess { pid: number; ppid: number; group: number; command: string }

/** Processes carrying `marker`, other than this one. Empty when they can't be read. */
export async function leftRunning(marker: string, platform: NodeJS.Platform = process.platform): Promise<LeftProcess[]> {
  const tag = `${COMMAND_MARK}=${marker}`;
  try {
    if (platform === "linux") return await linux(tag);
    if (platform === "darwin") return await darwin(tag);
  } catch { /* nothing found */ }
  return [];
}

async function linux(tag: string): Promise<LeftProcess[]> {
  const found: LeftProcess[] = [];
  for (const entry of await readdir("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      const environ = await readFile(`/proc/${pid}/environ`, "utf8");
      if (!environ.split("\0").includes(tag)) continue;
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      // "pid (comm) state ppid pgrp ...": the name may hold spaces and parentheses.
      const [state, ppid, group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (state === "Z") continue;
      const command = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean).join(" ");
      found.push({ pid, ppid: Number(ppid), group: Number(group), command });
    } catch { /* gone, or not ours */ }
  }
  return found;
}

async function darwin(tag: string): Promise<LeftProcess[]> {
  const options = { encoding: "utf8" as const, timeout: 5_000, maxBuffer: 16 * 1024 * 1024, env: { PATH: "/bin:/usr/bin", LC_ALL: "C" } };
  const { stdout } = await run("ps", ["-E", "-ww", "-x", "-o", "pid=,ppid=,pgid=,stat=,command="], options);
  const pids = stdout.split("\n").flatMap((line) => {
    const [pid, ppid, group, stat] = line.trim().split(/\s+/);
    return line.includes(tag) && !stat?.startsWith("Z") && Number(pid) !== process.pid ? [{ pid: Number(pid), ppid: Number(ppid), group: Number(group) }] : [];
  });
  if (!pids.length) return [];
  // The commands again without their environment, which ps -E writes after them.
  const { stdout: plain } = await run("ps", ["-ww", "-o", "pid=,command=", "-p", pids.map((entry) => entry.pid).join(",")], options);
  const commands = new Map(plain.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match ? [[Number(match[1]), match[2]!] as const] : [];
  }));
  return pids.filter((entry) => commands.has(entry.pid)).map((entry) => ({ ...entry, command: commands.get(entry.pid)! }));
}

/** The jobs: each found process whose parent was not found too (a runner, not each of its children). */
export function jobRoots(found: readonly LeftProcess[]): LeftProcess[] {
  const pids = new Set(found.map((entry) => entry.pid));
  return found.filter((entry) => !pids.has(entry.ppid));
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
