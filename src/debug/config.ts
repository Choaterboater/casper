import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { openNoFollow } from "../platform/files";
import path from "node:path";
import { createHash } from "node:crypto";

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 && value.every(item => item === "" || text(item));
}
export function lines(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 128 && value.every(line => Number.isInteger(line) && line > 0 && line < 2 ** 31) && new Set(value).size === value.length;
}
export async function projectFile(root: string, input: string, directory = false): Promise<string> {
  if (!text(input) || path.isAbsolute(input)) throw new Error("Debugger paths must be project-relative");
  const resolved = await realpath(path.resolve(root, input));
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Debugger path leaves the project");
  const info = await stat(resolved);
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error("Debugger path has an unsupported file type");
  return resolved;
}

export interface DebugTarget {
  name: string;
  command: string;
  args: string[];
  adapterID: string;
  program: string;
  cwd: string;
  programArgs: string[];
  breakpoints: Record<string, number[]>;
  identity: string;
}

/** No startup discovery, executable config, inheritance, fallback or automatic installation. */
export async function readTargets(root: string): Promise<{ targets: Record<string, unknown>; digest: string }> {
  let file;
  try { file = await openNoFollow(path.join(root, ".casper/debug.json")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { targets: {}, digest: "" };
    throw new Error("Cannot read debugger configuration");
  }
  try {
    if (!(await file.stat()).isFile()) throw new Error("Not a regular file");
    const bytes = Buffer.alloc(65_537);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65_536) throw new Error("Too large");
    const source = bytes.subarray(0, bytesRead);
    const value: unknown = JSON.parse(source.toString("utf8"));
    if (!record(value) || Object.keys(value).some(key => key !== "targets") || !record(value.targets) || Object.keys(value.targets).length > 16 ||
      Object.keys(value.targets).some(key => !/^[a-zA-Z0-9_-]{1,64}$/.test(key))) throw new Error("Invalid targets");
    return { targets: value.targets, digest: createHash("sha256").update(source).digest("hex") };
  } catch { throw new Error("Invalid debugger configuration (regular JSON file, targets map, 64 KiB maximum)"); }
  finally { await file.close(); }
}

export async function resolveTarget(root: string, name: string): Promise<DebugTarget> {
  const { targets, digest } = await readTargets(root);
  const entry = Object.hasOwn(targets, name) ? targets[name] : undefined;
  if (!record(entry) || Object.keys(entry).some(key => !["command", "args", "adapterID", "program", "cwd", "programArgs", "breakpoints"].includes(key)) ||
    !text(entry.command) || !path.isAbsolute(entry.command) || !strings(entry.args ?? []) ||
    !text(entry.adapterID) || !/^[\w.-]{1,64}$/.test(entry.adapterID) || !text(entry.program) ||
    !text(entry.cwd ?? ".") || !strings(entry.programArgs ?? []) ||
    (entry.breakpoints !== undefined && !record(entry.breakpoints))) throw new Error("Invalid or unknown debugger target");
  const command = await realpath(entry.command);
  if (!(await stat(command)).isFile()) throw new Error("Adapter must be a regular executable file");
  await access(command, constants.X_OK);
  const program = await projectFile(root, entry.program);
  const cwd = await projectFile(root, String(entry.cwd ?? "."), true);
  const breakpoints: Record<string, number[]> = {};
  const sources = Object.entries(entry.breakpoints ?? {});
  if (sources.length > 32 || sources.reduce((n, [, value]) => n + (Array.isArray(value) ? value.length : 0), 0) > 128) throw new Error("Debugger breakpoint budget exceeded");
  for (const [source, value] of sources) {
    if (!lines(value)) throw new Error("Invalid debugger breakpoints");
    breakpoints[await projectFile(root, source)] = value;
  }
  const identities = await Promise.all([command, program, ...Object.keys(breakpoints)].map(async file => {
    const info = await stat(file); return [file, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
  }));
  return { name, command, args: (entry.args ?? []) as string[], adapterID: entry.adapterID, program, cwd,
    programArgs: (entry.programArgs ?? []) as string[], breakpoints,
    identity: createHash("sha256").update(JSON.stringify([digest, identities])).digest("hex") };
}
