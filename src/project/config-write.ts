import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMap, isNode, parseDocument, stringify } from "yaml";
import { openNoFollow } from "../platform/files";
import { CHECK_NAMES } from "../verify/evidence";
import type { ProjectCommand } from "./model";
import { namedCheckNameError, parseNetworkChecks } from "../network/spec";
import type { NamedCheckSpec } from "../verify/named";

/** The same bound the configuration loader applies to .casper/project.yaml. */
const MAX_PROJECT_YAML_BYTES = 256 * 1024;
export const PROJECT_YAML = ".casper/project.yaml";

export interface ProjectCommandWrite {
  /** Absolute path of the file written. */
  file: string;
  /** The exact setting written, as shown to the user before saving: `verify.test: uv run pytest`. */
  line: string;
  /** The file's text before the write, or null when Casper created it. Lets the write be undone. */
  before: string | null;
  /** The file's text after the write. */
  after: string;
}

function checkCommand(name: ProjectCommand, command: string): void {
  if (!CHECK_NAMES.includes(name)) throw new Error(`${name} is not a check name (${CHECK_NAMES.join(", ")})`);
  if (!command.trim() || command.length > 500 || /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/.test(command)) {
    throw new Error("the command must be one plain line");
  }
}

/** The setting exactly as it will be written, quoting included: what the user sees before saying yes. */
export function projectCommandLine(name: ProjectCommand, command: string): string {
  checkCommand(name, command);
  return `verify.${name}: ${stringify(command.trim()).trimEnd()}`;
}

/** The project's .casper folder, which must be a real folder inside the project, never a link. */
async function casperFolder(root: string): Promise<string> {
  const realRoot = await realpath(root);
  const folder = path.join(realRoot, ".casper");
  const stats = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stats) {
    await mkdir(folder);
    return folder;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(".casper is a link or not a folder; refusing to write through it");
  return folder;
}

async function readExisting(file: string): Promise<{ text: string; mode: number } | null> {
  const stats = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stats) return null;
  // The same rule the loader applies to repository files: a link could point anywhere, and a special
  // file could block the read.
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${PROJECT_YAML} is a link or not a regular file; refusing to change it`);
  if (stats.size > MAX_PROJECT_YAML_BYTES) throw new Error(`${PROJECT_YAML} is larger than 256 KiB; refusing to change it`);
  const handle = await openNoFollow(file);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${PROJECT_YAML} is not a regular file; refusing to change it`);
    return { text: await handle.readFile("utf8"), mode: info.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

/**
 * Set `verify.<name>` in the project's .casper/project.yaml, keeping comments, order and every other
 * setting. The write replaces the file in one step (a temporary file, then rename), so a reader never
 * sees half a file. It refuses a linked or special file, a file that does not parse, and a different
 * command already saved under that name: the user changes that one by hand.
 */
export async function saveProjectCommand(root: string, name: ProjectCommand, command: string): Promise<ProjectCommandWrite> {
  checkCommand(name, command);
  const value = command.trim();
  const line = projectCommandLine(name, value);
  return setProjectSetting(root, ["verify", name], value, line, (current) => current === value, `verify.${name} is already set in ${PROJECT_YAML}; change it there yourself`);
}

/** A named check as it is saved: the defaults (an ordinary check that runs after each change) left out. */
export function savedNamedCheck(spec: NamedCheckSpec): Record<string, unknown> {
  const saved: Record<string, unknown> = {};
  if (spec.kind !== "offline" && !spec.preset) saved.kind = spec.kind;
  for (const key of ["run", "preset", "playbooks", "files", "inventory", "platform", "running", "intended", "models", "modules", "timeout"] as const) {
    if (spec[key] !== undefined) saved[key] = structuredClone(spec[key]);
  }
  if (spec.after === "ask") saved.after = "ask";
  return saved;
}

/** The setting exactly as it will be written, on one line: `verify.checks.aruba-syntax: {preset: ansible-syntax, playbooks: [site.yml]}`. */
export function namedCheckLine(name: string, spec: NamedCheckSpec): string {
  const error = namedCheckNameError("verify.checks", name);
  if (error) throw new Error(error);
  return `verify.checks.${name}: ${stringify(savedNamedCheck(spec), { collectionStyle: "flow" }).trim()}`;
}

/**
 * Save a ready-made check under `verify.checks.<name>` in .casper/project.yaml, the same careful way as
 * saveProjectCommand. Only the user's own choice calls this (/verify add <name>, or a suggestion they picked).
 */
export async function saveNamedCheck(root: string, name: string, spec: NamedCheckSpec): Promise<ProjectCommandWrite> {
  const line = namedCheckLine(name, spec);
  const value = savedNamedCheck(spec);
  // What is saved must read back as the same check.
  parseNetworkChecks({ [name]: value });
  return setProjectSetting(root, ["verify", "checks", name], value, line,
    (current) => JSON.stringify(current) === JSON.stringify(value), `verify.checks.${name} is already set in ${PROJECT_YAML}; change it there yourself`);
}

async function setProjectSetting(root: string, keys: string[], value: unknown, line: string, same: (current: unknown) => boolean, taken: string): Promise<ProjectCommandWrite> {
  const folder = await casperFolder(root);
  const file = path.join(folder, "project.yaml");
  const existing = await readExisting(file);
  const document = parseDocument(existing?.text ?? "");
  if (document.errors.length) throw new Error(`${PROJECT_YAML} does not parse (${document.errors[0]!.message.split("\n")[0]}); fix it first`);
  if (document.contents !== null && !isMap(document.contents)) throw new Error(`${PROJECT_YAML} is not a mapping; refusing to change it`);
  for (let depth = 1; depth < keys.length; depth++) {
    const parent = document.getIn(keys.slice(0, depth));
    if (parent !== undefined && parent !== null && !isMap(parent)) throw new Error(`${keys.slice(0, depth).join(".")} in ${PROJECT_YAML} is not a mapping; refusing to change it`);
  }
  const node = document.getIn(keys, true);
  const current = node === undefined || node === null ? undefined : (isNode(node) ? node.toJSON() : node);
  if (current !== undefined && current !== null) {
    if (same(current)) return { file, line, before: existing?.text ?? null, after: existing?.text ?? "" };
    throw new Error(taken);
  }
  document.setIn(keys, document.createNode(value));
  const after = document.toString();
  const temporary = path.join(folder, `.project.yaml.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, after, { mode: existing?.mode ?? 0o644, flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { file, line, before: existing?.text ?? null, after };
}
