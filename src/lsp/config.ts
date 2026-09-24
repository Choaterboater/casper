import { openFollowed } from "../platform/files";
import os from "node:os";
import path from "node:path";
import { isValidProfileName } from "../config/profile";
import { record } from "./protocol";
import type { ServerDefinitionScope } from "../mcp/config";

export interface LSPServerDefinition {
  name: string;
  source: string;
  /** Project files are repository content: connecting one needs an interactive review. */
  scope?: ServerDefinitionScope;
  /** The user/profile file whose same-named definition this project definition replaces. */
  shadows?: string;
  command: string;
  args: string[];
  languages: Record<string, string>;
}
export interface LSPConfiguration { servers: LSPServerDefinition[]; diagnostics: string[] }

/** Metadata only; reading a definition never grants permission to execute it. */
export async function discoverLSPConfiguration(options: { projectRoot: string; homeDir?: string; profileName?: string }): Promise<LSPConfiguration> {
  const home = options.homeDir ?? os.homedir();
  const files: { source: string; scope: ServerDefinitionScope }[] = [{ source: path.join(home, ".casper/lsp.json"), scope: "user" }];
  const profile = options.profileName ?? "default";
  if (isValidProfileName(profile)) files.push({ source: path.join(home, ".casper/profiles", profile, "lsp.json"), scope: "profile" });
  files.push({ source: path.join(options.projectRoot, ".casper/lsp.json"), scope: "project" });
  const servers = new Map<string, LSPServerDefinition>();
  const personal = new Map<string, string>();
  const diagnostics: string[] = [];
  for (const { source, scope } of files) {
    let value: unknown;
    try {
      const file = await openFollowed(source);
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
      const shadows = scope === "project" ? personal.get(name) : undefined;
      servers.set(name, { name, source, scope, ...(shadows ? { shadows } : {}), command: entry.command, args, languages: entry.languages as Record<string, string> });
      if (scope !== "project") personal.set(name, source);
    }
  }
  return { servers: [...servers.values()], diagnostics };
}

/** Review text for a project-scope definition: its file, what it replaces, and what it runs. */
export function projectLSPDefinitionReview(definition: LSPServerDefinition): string | undefined {
  if (definition.scope !== "project") return undefined;
  return [
    "LSP server confirmation",
    `name: ${JSON.stringify(definition.name)}`,
    `source: ${definition.source} (project file)`,
    ...(definition.shadows ? [`replaces your definition in: ${definition.shadows}`] : []),
    `command: ${JSON.stringify(definition.command)}`,
    `args: ${JSON.stringify(definition.args)}`,
    `languages: ${JSON.stringify(definition.languages)}`,
    "",
  ].join("\n");
}
