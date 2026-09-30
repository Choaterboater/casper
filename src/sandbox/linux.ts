import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { SandboxPolicy } from "./policy";
import { within } from "../platform/project-paths";

/**
 * Casper's own bubblewrap line for the two cases the sandbox runtime's shared network setup can't serve:
 * `host` (dev servers and services, which the host must reach on localhost, and lab checks, which reach
 * your lab) and `none` (tools that need no network at all). Files are held the same way as everywhere
 * else: the whole machine read-only, the project, temp and package caches writable, git's own files and
 * your settings read-only, private places hidden. `none` also cuts the network entirely.
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
  args.push("--chdir", options.cwd, "--", "/bin/sh", "-c", options.prefix ? `${options.prefix}\n${command}` : command);
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

/** Why bubblewrap can't hold commands on this machine, or undefined when it can. Tried once per process. */
let probed: string | undefined | null = null;
export function linuxSandboxProblem(envPath = process.env.PATH ?? ""): string | undefined {
  if (probed !== null) return probed;
  const bwrap = which("bwrap", envPath);
  const socat = which("socat", envPath);
  if (!bwrap || !socat) {
    const missing = [!bwrap ? "bubblewrap" : "", !socat ? "socat" : ""].filter(Boolean).join(" and ");
    return probed = `${missing} ${!bwrap && !socat ? "are" : "is"} missing: sudo apt install bubblewrap socat`;
  }
  const result = spawnSync(bwrap, ["--die-with-parent", "--unshare-pid", "--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "/bin/true"],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 5000 });
  if (result.status === 0) return probed = undefined;
  const why = (result.stderr?.toString("utf8") ?? "").split("\n").find((line) => line.trim())?.replace(/^bwrap:\s*/, "").trim() ?? "it did not start";
  return probed = `bubblewrap can't start here (${why}); on Ubuntu 24.04 see docs/SECURITY.md`;
}

/** Tests only: probe again. */
export function resetLinuxProbe(): void { probed = null; }
