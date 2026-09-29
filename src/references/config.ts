import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isMap, parse, parseDocument } from "yaml";
import { isValidProfileName } from "../config/profile";
import { isRecord } from "../mcp/config";
import { readReferenceFile, referenceText } from "./files";

export interface ReferenceSource {
  id: string;
  configuration: string;
  root: string;
  paths: string[];
  useFor: string[];
  /** Per-source file size limit for search (1 KiB to 4 MiB); the default is 128 KiB. */
  maxFileBytes?: number;
}
export const MIN_SOURCE_FILE_BYTES = 1024;
export const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
export const PROMOTED_REFERENCE_SOURCE = "casper-promoted";

export interface ReferenceConfiguration {
  sources: ReferenceSource[];
  diagnostics: string[];
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && !value.includes("\0") && Buffer.byteLength(value) <= max;
}

function sourceDefinition(id: string, value: unknown, configuration: string, home: string): ReferenceSource {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(id) || !isRecord(value)
    || Object.keys(value).some((key) => !["path", "paths", "useFor", "maxFileBytes"].includes(key))) throw new Error("invalid source definition");
  if (!text(value.path, 4096)) throw new Error("path must be an absolute local directory or ~/ path");
  const root = value.path.startsWith("~/") ? path.join(home, value.path.slice(2)) : value.path;
  if (!path.isAbsolute(root)) throw new Error("path must be an absolute local directory or ~/ path");
  if (!Array.isArray(value.paths) || !value.paths.length || value.paths.length > 32
    || !value.paths.every((entry) => text(entry, 256) && (entry === "." || (!path.isAbsolute(entry)
      && !entry.includes("\\") && entry.split("/").every((part) => part && part !== "." && part !== ".."))))) {
    throw new Error("paths must contain 1–32 literal relative files/directories (no traversal)");
  }
  if (value.paths.some((entry: string) => /[*?\[\]]/.test(entry))) throw new Error("paths are literal, not globs");
  const useFor = value.useFor ?? [];
  if (!Array.isArray(useFor) || useFor.length > 8 || !useFor.every((entry) => text(entry, 128))) throw new Error("invalid useFor labels");
  const maxFileBytes = value.maxFileBytes;
  if (maxFileBytes !== undefined && (typeof maxFileBytes !== "number" || !Number.isInteger(maxFileBytes)
    || maxFileBytes < MIN_SOURCE_FILE_BYTES || maxFileBytes > MAX_SOURCE_FILE_BYTES)) {
    throw new Error(`maxFileBytes must be a whole number from ${MIN_SOURCE_FILE_BYTES} to ${MAX_SOURCE_FILE_BYTES}`);
  }
  return { id, configuration, root: path.resolve(root), paths: [...new Set<string>(value.paths)], useFor: [...useFor],
    ...(maxFileBytes !== undefined ? { maxFileBytes } : {}) };
}

/** User-owned configuration only. Project files cannot add external read roots.
 * Discovery reads metadata, never source repositories or their executable configuration. */
export async function discoverReferenceConfiguration(options: { homeDir?: string; profileName?: string } = {}): Promise<ReferenceConfiguration> {
  const home = options.homeDir ?? os.homedir();
  const files = [path.join(home, ".casper/references.yaml")];
  const profile = options.profileName ?? "default";
  if (isValidProfileName(profile)) {
    files.push(path.join(home, ".casper/profiles", profile, "references.yaml"));
  }
  const sources = new Map<string, ReferenceSource>();
  const diagnostics: string[] = [];
  for (const configuration of files) {
    let document: unknown;
    try {
      document = parse(referenceText(await readReferenceFile(configuration, 65_536)), { maxAliasCount: 0 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(`Cannot read reference configuration: ${configuration}`);
      continue;
    }
    if (!isRecord(document) || Object.keys(document).some((key) => key !== "references") || !isRecord(document.references)) {
      diagnostics.push(`Expected a references map: ${configuration}`);
      continue;
    }
    for (const [id, value] of Object.entries(document.references)) {
      // Invalid overrides and explicit null disables never resurrect a lower-priority root.
      sources.delete(id);
      if (id === PROMOTED_REFERENCE_SOURCE) {
        diagnostics.push(`${configuration} (${id}): source ID is reserved for digest-bound human promotions`);
        continue;
      }
      if (value === null) continue;
      try {
        if (sources.size >= 32) throw new Error("at most 32 sources are supported");
        sources.set(id, sourceDefinition(id, value, configuration, home));
      } catch (error) {
        diagnostics.push(`Invalid reference ${JSON.stringify(id.slice(0, 64))} in ${configuration}: ${error instanceof Error ? error.message : "invalid definition"}`);
      }
    }
  }
  const promotedRoot = path.join(home, ".casper", "promoted-references");
  try {
    const info = await lstat(promotedRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) diagnostics.push(`Cannot use promoted references: ${promotedRoot} must be a real directory`);
    else sources.set(PROMOTED_REFERENCE_SOURCE, { id: PROMOTED_REFERENCE_SOURCE,
      configuration: "digest-bound human learning promotion", root: promotedRoot, paths: ["."], useFor: ["human-promoted reusable patterns"] });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(`Cannot inspect promoted references: ${promotedRoot}`); }
  return { sources: [...sources.values()].sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics: diagnostics.length <= 16 ? diagnostics : [...diagnostics.slice(0, 16), `${diagnostics.length - 16} further reference configuration diagnostics omitted.`] };
}

export const REFERENCES_FILE_LABEL = "~/.casper/references.yaml";
const MAX_CONFIGURATION_BYTES = 65_536;

export interface NewReferenceSource {
  path: string;
  paths: string[];
  useFor?: string[];
  maxFileBytes?: number;
}

/** Thrown when the ID is already in the file; nothing is written. */
export class ReferenceExistsError extends Error {
  constructor(readonly id: string) {
    super(`${id} is already in ${REFERENCES_FILE_LABEL}. Nothing changed.`);
    this.name = "ReferenceExistsError";
  }
}

/**
 * Add one source to ~/.casper/references.yaml, creating the file if needed.
 * Create-only: an existing ID (even a "null" disable) is refused. Comments and
 * other entries are kept. Written to a temp file first, then renamed into place.
 * Profile files are never touched.
 */
export async function addReferenceSource(home: string, id: string, definition: NewReferenceSource): Promise<string> {
  const file = path.join(home, ".casper", "references.yaml");
  if (id === PROMOTED_REFERENCE_SOURCE) throw new Error(`${id} is a reserved name.`);
  const plain: Record<string, unknown> = { path: definition.path, paths: [...definition.paths] };
  if (definition.useFor?.length) plain.useFor = [...definition.useFor];
  if (definition.maxFileBytes !== undefined) plain.maxFileBytes = definition.maxFileBytes;
  try { sourceDefinition(id, plain, file, home); }
  catch (error) { throw new Error(`Cannot add ${id}: ${error instanceof Error ? error.message : "invalid definition"}.`); }

  let text = "";
  let mode = 0o600;
  try {
    text = referenceText(await readReferenceFile(file, MAX_CONFIGURATION_BYTES));
    mode = (await stat(file)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot read ${REFERENCES_FILE_LABEL}. Nothing changed.`);
  }
  const document = parseDocument(text);
  if (document.errors.length) throw new Error(`Cannot read ${REFERENCES_FILE_LABEL}: it is not valid YAML. Nothing changed.`);
  let current: unknown;
  try { current = document.toJS({ maxAliasCount: 0 }); }
  catch { throw new Error(`Cannot read ${REFERENCES_FILE_LABEL}: aliases are not supported. Nothing changed.`); }
  if (current !== null && current !== undefined
    && (!isRecord(current) || Object.keys(current).some((key) => key !== "references")
      || (current.references !== null && current.references !== undefined && !isRecord(current.references)))) {
    throw new Error(`Expected a references map in ${REFERENCES_FILE_LABEL}. Nothing changed.`);
  }
  if (isRecord(current) && isRecord(current.references) && Object.hasOwn(current.references, id)) throw new ReferenceExistsError(id);
  if (!isMap(document.get("references"))) document.set("references", document.createNode({}));
  (document.get("references") as { set(key: unknown, value: unknown): void }).set(id, document.createNode(plain));
  const next = document.toString();
  if (Buffer.byteLength(next) > MAX_CONFIGURATION_BYTES) throw new Error(`${REFERENCES_FILE_LABEL} would be too large. Nothing changed.`);

  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, next, { flag: "wx", mode });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return file;
}
