import { constants } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isValidProfileName } from "../config/profile";
import { record } from "./protocol";

export interface LSPServerDefinition {
  name: string;
  source: string;
  command: string;
  args: string[];
  languages: Record<string, string>;
}
export interface LSPConfiguration { servers: LSPServerDefinition[]; diagnostics: string[] }

/** Metadata only; reading a definition never grants permission to execute it. */
export async function discoverLSPConfiguration(options: { projectRoot: string; homeDir?: string; profileName?: string }): Promise<LSPConfiguration> {
  const home = options.homeDir ?? os.homedir();
  const files = [path.join(home, ".casper/lsp.json")];
  const profile = options.profileName ?? "default";
  if (isValidProfileName(profile)) files.push(path.join(home, ".casper/profiles", profile, "lsp.json"));
  files.push(path.join(options.projectRoot, ".casper/lsp.json"));
  const servers = new Map<string, LSPServerDefinition>();
  const diagnostics: string[] = [];
  for (const source of files) {
    let value: unknown;
    try {
      const file = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        if (!(await file.stat()).isFile()) throw new Error("configuration must be a regular file");
        const bytes = Buffer.alloc(65_537);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 65_536) throw new Error("oversized");
        value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(`Cannot read LSP configuration: ${source}`);
      continue;
    }
    if (!record(value) || !record(value.lspServers)) { diagnostics.push(`Expected lspServers map: ${source}`); continue; }
    for (const [name, entry] of Object.entries(value.lspServers)) {
      servers.delete(name); // Invalid or disabled overrides must not restore an earlier definition.
      if (record(entry) && entry.disabled === true) continue;
      const args = record(entry) ? entry.args ?? [] : [];
      if (!/^[\w.-]{1,64}$/.test(name) || !record(entry) || typeof entry.command !== "string" || !entry.command.trim()
        || !Array.isArray(args) || args.some((v: unknown) => typeof v !== "string")
        || !record(entry.languages) || !Object.keys(entry.languages).length || Object.keys(entry.languages).length > 32
        || Object.entries(entry.languages).some(([ext, language]) => !/^\.[a-zA-Z0-9]+$/.test(ext) || typeof language !== "string" || !/^[\w+-]{1,64}$/.test(language))
        || servers.size >= 16) {
        diagnostics.push(`Invalid LSP entry ${JSON.stringify(name.slice(0, 64))}: ${source}`);
        continue;
      }
      servers.set(name, { name, source, command: entry.command, args, languages: entry.languages as Record<string, string> });
    }
  }
  return { servers: [...servers.values()], diagnostics };
}
