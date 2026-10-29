/**
 * The person's Desktop, Documents and Downloads folders, for words like "save it to the desktop". macOS: the folders
 * in the home folder. Linux: the XDG user folders (~/.config/user-dirs.dirs), else the home folder's. Windows: the
 * known folder, which may have moved (OneDrive), asked of Windows PowerShell by its full path. WSL: the Windows
 * folder, asked the same way and turned into its WSL path by wslpath, else the Linux one. Programs run with fixed
 * arguments and no shell, for a short time. Any failure falls back to the plain folder.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isWsl } from "../browser/discovery";

export type KnownFolderName = "desktop" | "documents" | "downloads";

const PLAIN: Record<KnownFolderName, string> = { desktop: "Desktop", documents: "Documents", downloads: "Downloads" };
const XDG: Record<KnownFolderName, string> = { desktop: "XDG_DESKTOP_DIR", documents: "XDG_DOCUMENTS_DIR", downloads: "XDG_DOWNLOAD_DIR" };
// The Shell's names for the known folders: they follow a folder moved to OneDrive or another drive.
const SHELL: Record<KnownFolderName, string> = { desktop: "Desktop", documents: "Personal", downloads: "Downloads" };
const TIMEOUT_MS = 5_000;

/** The PowerShell that prints a known folder's path, in UTF-8 so any name comes through. */
export function knownFolderScript(name: KnownFolderName): string {
  return `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); (New-Object -ComObject Shell.Application).NameSpace('shell:${SHELL[name]}').Self.Path`;
}

/** One program's output, trimmed; undefined when it isn't there, fails or takes too long. */
export function runTool(file: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(file, [...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { resolve(undefined); return; }
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: string | undefined) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(undefined); }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    child.on("error", () => finish(undefined));
    child.on("close", (code) => finish(code === 0 ? Buffer.concat(chunks).toString("utf8").trim() || undefined : undefined));
  });
}

export interface KnownFolderOptions {
  home: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Runs one program (tests stand in for the system's). */
  run?: (file: string, args: readonly string[]) => Promise<string | undefined>;
  /** Reads a text file, undefined when it can't (tests pass their own). */
  read?: (file: string) => Promise<string | undefined>;
  /** The kernel's version text, for telling WSL (tests pass their own; else /proc/version). */
  kernel?: string;
}

const readText = (file: string) => readFile(file, "utf8").catch(() => undefined);
/** One absolute path on one line. */
const onePath = (text: string | undefined, absolute: (value: string) => boolean) => text && !/[\r\n]/.test(text) && absolute(text) ? text : undefined;

/** The XDG user folder (`XDG_DESKTOP_DIR="$HOME/Desktop"`), when one other than home itself is set. */
async function xdgFolder(name: KnownFolderName, home: string, env: NodeJS.ProcessEnv, read: (file: string) => Promise<string | undefined>): Promise<string | undefined> {
  const config = env.XDG_CONFIG_HOME && path.posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.posix.join(home, ".config");
  const text = await read(path.posix.join(config, "user-dirs.dirs"));
  const value = text ? new RegExp(`^\\s*${XDG[name]}\\s*=\\s*"([^"\\n]*)"`, "m").exec(text)?.[1] : undefined;
  if (!value) return undefined;
  const folder = value.replace(/^\$HOME(?=\/|$)/, home);
  // Set to home itself: there is no folder of its own, so the plain one.
  return path.posix.isAbsolute(folder) && path.posix.resolve(folder) !== path.posix.resolve(home) ? path.posix.resolve(folder) : undefined;
}

/** Where one of the person's known folders is, whether or not it exists (the export says so when it doesn't). */
export async function knownFolder(name: KnownFolderName, options: KnownFolderOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runTool;
  const read = options.read ?? readText;
  const { home } = options;
  const script = ["-NoProfile", "-NonInteractive", "-Command", knownFolderScript(name)];
  if (platform === "win32") {
    const powershell = path.win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return onePath(await run(powershell, script), path.win32.isAbsolute) ?? path.win32.join(env.USERPROFILE ?? home, PLAIN[name]);
  }
  // macOS, Linux and WSL paths are POSIX ones, whatever runs this.
  if (platform === "darwin") return path.posix.join(home, PLAIN[name]);
  if (isWsl(platform, env, options.kernel)) {
    // Windows' own PowerShell on the C: drive WSL mounts, never one found on PATH.
    const windows = onePath(await run("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", script), (value) => /^[A-Za-z]:\\/.test(value));
    const found = windows ? onePath(await run("/usr/bin/wslpath", ["-u", windows]), path.posix.isAbsolute) : undefined;
    if (found) return found;
  }
  return await xdgFolder(name, home, env, read) ?? path.posix.join(home, PLAIN[name]);
}
