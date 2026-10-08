import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { SandboxPolicy } from "./policy";
import { within } from "../platform/project-paths";
import { pinnedRipgrepPath } from "../security/ripgrep-pin";

/**
 * Casper's own bubblewrap line for the two cases the sandbox runtime's shared network setup can't serve:
 * `host` (dev servers and services, which the host must reach on localhost, and lab checks, which reach
 * your lab) and `none` (tools that need no network at all). Files are held the same way as everywhere
 * else: the whole machine read-only, the project, temp and package caches writable, git's own files and
 * your settings read-only, private places hidden, and no Unix sockets (seccomp). `none` also cuts the network entirely.
 */

/** A shell-quoted word. */
export function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

const isDirectory = (file: string) => { try { return statSync(file).isDirectory(); } catch { return false; } };

export interface LinuxWrapOptions {
  policy: SandboxPolicy;
  network: "host" | "none";
  cwd: string;
  /** The bwrap program (tests pass a fake). */
  bwrap?: string;
  /** Lines run before the command inside the sandbox (TMPDIR). */
  prefix?: string;
  /** The apply-seccomp helper: the command can't open a Unix socket, so it can't ask a program outside the
   * sandbox (Docker, the desktop's session bus, an SSH agent) to act for it. */
  seccomp?: string;
}

/** The argument list for bwrap. Paths that don't exist are skipped, except git's hooks folder, which git itself
 * would make: it is created first so a command can't add a hook there. */
export function bwrapArgs(options: LinuxWrapOptions, command: string): string[] {
  const { policy } = options;
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", ...(options.network === "none" ? ["--unshare-net"] : []),
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  const writable = [...policy.allowWrite].filter((entry) => existsSync(entry)).sort((a, b) => a.length - b.length);
  for (const entry of writable) args.push("--bind", entry, entry);
  const insideWritable = (entry: string) => writable.some((allowed) => within(allowed, entry));
  // A git folder is bound onto itself, so a command can't move it aside and put another in its place (the
  // read-only files below would go with it).
  const gitFolders = new Set(policy.denyWrite.filter((entry) => ["config", "commondir"].includes(path.basename(entry))).map((entry) => path.dirname(entry)));
  // A worktree's folder sits in `<common>/worktrees`: that folder is bound too, or it could be renamed with the
  // read-only files inside it and another put in its place.
  for (const entry of policy.denyWrite) if (path.basename(entry) === "commondir" && path.basename(path.dirname(path.dirname(entry))) === "worktrees") gitFolders.add(path.dirname(path.dirname(entry)));
  for (const dir of gitFolders) if (insideWritable(dir) && isDirectory(dir)) args.push("--bind", dir, dir);
  for (const entry of policy.denyWrite) {
    if (!insideWritable(entry)) continue;
    if (!existsSync(entry) && path.basename(entry) === "hooks" && isDirectory(path.dirname(entry))) {
      try { mkdirSync(entry, { recursive: false }); } catch { /* made meanwhile, or not ours to make */ }
    }
    if (existsSync(entry)) args.push("--ro-bind", entry, entry);
  }
  for (const entry of policy.denyRead) {
    if (!existsSync(entry)) continue;
    if (isDirectory(entry)) args.push("--tmpfs", entry, "--remount-ro", entry);
    else args.push("--ro-bind", "/dev/null", entry);
  }
  args.push("--chdir", options.cwd, "--", ...(options.seccomp ? [options.seccomp] : []), "/bin/sh", "-c", options.prefix ? `${options.prefix}\n${command}` : command);
  return args;
}

/** One shell line that runs `command` in the sandbox. */
export function bwrapCommand(options: LinuxWrapOptions, command: string): string {
  return [options.bwrap ?? "bwrap", ...bwrapArgs(options, command)].map(quote).join(" ");
}

/** Where a program is on PATH, or undefined. */
export function which(program: string, envPath = process.env.PATH ?? ""): string | undefined {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, program);
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
  }
  return undefined;
}

/** The ripgrep the sandbox runtime scans the project with (it looks for nested git and settings files to keep
 * read-only): the one on PATH, the copy Pi downloaded into its own folder (`<agentDir>/bin/rg`), or the pinned copy
 * Casper fetched into `<homeDir>/.casper/tools`. */
export function ripgrepPath(envPath = process.env.PATH ?? "", agentDir?: string, homeDir?: string): string | undefined {
  const found = which("rg", envPath);
  if (found) return found;
  for (const managed of [agentDir ? path.join(agentDir, "bin", "rg") : undefined, homeDir ? pinnedRipgrepPath(homeDir) : undefined]) {
    try { if (managed && statSync(managed).isFile()) return managed; } catch { /* not downloaded */ }
  }
  return undefined;
}

/** Where Ubuntu (23.10 and later) says whether AppArmor keeps unprivileged programs from making user namespaces. */
export const APPARMOR_USERNS = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/** Why bubblewrap did not start, in plain words: `stderr` is its own first line, `apparmorBlocks` whether
 * AppArmor restricts user namespaces here (the usual cause on Ubuntu 24.04). */
export function bwrapFailure(stderr: string, apparmorBlocks: boolean): string {
  const why = stderr.split("\n").find((line) => line.trim())?.replace(/^bwrap:\s*/, "").trim() || "it did not start";
  if (apparmorBlocks) return `Ubuntu blocks it (AppArmor restricts user namespaces: ${why}); to allow it: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0, see docs/SECURITY.md`;
  return `bubblewrap can't start here (${why}); see docs/SECURITY.md`;
}

function apparmorRestricts(file = APPARMOR_USERNS): boolean {
  try { return readFileSync(file, "utf8").trim() === "1"; } catch { return false; }
}

/** Why bubblewrap can't hold commands on this machine, or undefined when it can. Tried once per process. */
let probed: string | undefined | null = null;
export function linuxSandboxProblem(envPath = process.env.PATH ?? "", options: { agentDir?: string; homeDir?: string; apparmorFile?: string } = {}): string | undefined {
  if (probed !== null) return probed;
  const bwrap = which("bwrap", envPath);
  const socat = which("socat", envPath);
  const rg = ripgrepPath(envPath, options.agentDir, options.homeDir);
  const missing = [!bwrap ? "bubblewrap" : "", !socat ? "socat" : "", !rg ? "ripgrep" : ""].filter(Boolean);
  if (missing.length > 0) {
    const named = missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`;
    return probed = `${named} ${missing.length > 1 ? "are" : "is"} missing: sudo apt install ${missing.join(" ")}`;
  }
  const result = spawnSync(bwrap!, ["--die-with-parent", "--unshare-pid", "--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "/bin/true"],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 5000 });
  if (result.status === 0) return probed = undefined;
  return probed = bwrapFailure(result.stderr?.toString("utf8") ?? "", apparmorRestricts(options.apparmorFile));
}

/** Tests only: probe again. */
export function resetLinuxProbe(): void { probed = null; }
