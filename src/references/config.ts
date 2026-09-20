import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { isRecord } from "../mcp/config";
import { readReferenceFile, referenceText } from "./files";

export interface ReferenceSource {
  id: string;
  configuration: string;
  root: string;
  paths: string[];
  useFor: string[];
}
export interface ReferenceConfiguration {
  sources: ReferenceSource[];
  diagnostics: string[];
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && !value.includes("\0") && Buffer.byteLength(value) <= max;
}

function sourceDefinition(id: string, value: unknown, configuration: string, home: string): ReferenceSource {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(id) || !isRecord(value)
    || Object.keys(value).some((key) => !["path", "paths", "useFor"].includes(key))) throw new Error("invalid source definition");
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
  return { id, configuration, root: path.resolve(root), paths: [...new Set<string>(value.paths)], useFor: [...useFor] };
}

/** User-owned configuration only. Project files cannot add external read roots.
 * Discovery reads metadata, never source repositories or their executable configuration. */
export async function discoverReferenceConfiguration(options: { homeDir?: string; profileName?: string } = {}): Promise<ReferenceConfiguration> {
  const home = options.homeDir ?? os.homedir();
  const files = [path.join(home, ".casper/references.yaml")];
  const profile = options.profileName ?? "default";
  if (/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(profile) && profile.length <= 64) {
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
      if (value === null) continue;
      try {
        if (sources.size >= 32) throw new Error("at most 32 sources are supported");
        sources.set(id, sourceDefinition(id, value, configuration, home));
      } catch (error) {
        diagnostics.push(`Invalid reference ${JSON.stringify(id.slice(0, 64))} in ${configuration}: ${error instanceof Error ? error.message : "invalid definition"}`);
      }
    }
  }
  return { sources: [...sources.values()].sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics: diagnostics.length <= 16 ? diagnostics : [...diagnostics.slice(0, 16), `${diagnostics.length - 16} further reference configuration diagnostics omitted.`] };
}
