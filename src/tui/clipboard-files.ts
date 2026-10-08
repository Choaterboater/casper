/**
 * Files copied in Finder, Explorer or a Linux file manager: their paths, read with the system's own clipboard
 * tool. Each tool runs with fixed arguments and no shell, by full path where the system has one (so a program
 * of the same name in the project folder never runs), for a short time and a capped amount of output.
 * Nothing is read from the files here; the prompt's picture paths do that when the request is sent.
 */
import { spawn } from "node:child_process";
import { hasLineControls } from "./format";

/** A clipboard tool that is slower than this, or prints more than this, is dropped: the paste goes on without it. */
export const CLIPBOARD_FILES_TIMEOUT_MS = 2_500;
export const CLIPBOARD_FILES_BYTES = 256 * 1024;

export interface ClipboardFilesCommand {
  file: string;
  args: string[];
  /** One path a line (Windows), or a text/uri-list of file:// addresses (macOS, Linux). */
  output: "paths" | "uris";
}

/** macOS: the pasteboard's file addresses, one a line. Finder copies file reference addresses
 * (file:///.file/id=…), so each is turned into its path form first. */
const MAC_SCRIPT = [
  'use framework "AppKit"',
  "set board to current application's NSPasteboard's generalPasteboard()",
  "set fileOnly to current application's NSDictionary's dictionaryWithObject:true forKey:(current application's NSPasteboardURLReadingFileURLsOnlyKey)",
  "set addresses to board's readObjectsForClasses:{current application's NSURL} options:fileOnly",
  'set listed to ""',
  "if addresses is not missing value then",
  "repeat with i from 1 to (addresses's |count|())",
  "set fileAddress to (addresses's objectAtIndex:(i - 1))",
  "set fileAddress to fileAddress's filePathURL()",
  "if fileAddress is not missing value then set listed to listed & ((fileAddress's absoluteString()) as text) & linefeed",
  "end repeat",
  "end if",
  "return listed",
];

/** Windows: Windows PowerShell's Get-Clipboard (PowerShell 7 dropped -Format), printing UTF-8 so any name comes through. */
const WINDOWS_SCRIPT = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }";

/** The tools to try, in order; the next one is tried only when one is not installed. */
export function clipboardFilesCommands(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): ClipboardFilesCommand[] {
  if (platform === "darwin") return [{ file: "/usr/bin/osascript", args: MAC_SCRIPT.flatMap((line) => ["-e", line]), output: "uris" }];
  if (platform === "win32") {
    const powershell = `${env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    return [{ file: powershell, args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], output: "paths" }];
  }
  const commands: ClipboardFilesCommand[] = [];
  if (env.WAYLAND_DISPLAY) commands.push({ file: "wl-paste", args: ["--no-newline", "--type", "text/uri-list"], output: "uris" });
  if (env.DISPLAY) commands.push({ file: "xclip", args: ["-selection", "clipboard", "-t", "text/uri-list", "-o"], output: "uris" });
  return commands;
}

/** The local path a file:// address names; undefined for another scheme, another computer, a query or fragment,
 * a bad %-escape, or a path with a control or bidi character in it. */
export function fileUriPath(uri: string): string | undefined {
  // Spaces and controls must be %-escaped in an address; raw ones mean it is not one.
  if (/[\s\x00-\x1f\x7f-\x9f]/.test(uri)) return undefined;
  const match = /^file:\/\/([^/?#]*)(\/[^?#]*)$/i.exec(uri);
  if (!match) return undefined;
  if (match[1] !== "" && match[1]!.toLowerCase() !== "localhost") return undefined;
  // An escaped slash would put a / inside a name.
  if (/%2f/i.test(match[2]!)) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(match[2]!); } catch { return undefined; }
  return hasLineControls(decoded) ? undefined : decoded;
}

/** The absolute paths in a tool's output; anything else in it is left out. */
export function clipboardFilesFromOutput(output: string, format: ClipboardFilesCommand["output"]): string[] {
  const lines = output.split(/\r?\n/).filter(Boolean);
  // A drive path (C:\…) or a network one (\\host\share\…); the share question comes when the request is sent.
  if (format === "paths") return lines.filter((line) => /^(?:[A-Za-z]:\\|\\\\)/.test(line) && !hasLineControls(line));
  // text/uri-list: one address a line; a line starting with # is a comment.
  return lines.filter((line) => !line.startsWith("#")).map(fileUriPath).filter((file): file is string => file !== undefined);
}

/** One tool's output; null when it ran and had nothing (or failed, or took too long); undefined when it is not installed. */
export function runClipboardTool(command: ClipboardFilesCommand, timeoutMs = CLIPBOARD_FILES_TIMEOUT_MS): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command.file, command.args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch { resolve(undefined); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: string | null | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > CLIPBOARD_FILES_BYTES) { child.kill("SIGKILL"); finish(null); return; }
      chunks.push(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? undefined : null));
    child.on("close", (code) => finish(code === 0 ? Buffer.concat(chunks).toString("utf8") : null));
  });
}

export interface ClipboardFilesOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Runs one tool (tests stand in for the system's). */
  run?: (command: ClipboardFilesCommand) => Promise<string | null | undefined>;
}

/** The copied files' paths. Undefined: no clipboard tool here; null: no files on the clipboard. */
export async function readClipboardFiles(options: ClipboardFilesOptions = {}): Promise<string[] | null | undefined> {
  const run = options.run ?? runClipboardTool;
  for (const command of clipboardFilesCommands(options.platform, options.env)) {
    const output = await run(command);
    // A Wayland clipboard with no files must not fall through to an old X11 one.
    if (output === undefined) continue;
    const files = output === null ? [] : clipboardFilesFromOutput(output, command.output);
    return files.length ? files : null;
  }
  return undefined;
}
