/**
 * Removing a server and changing what it runs, in the file that defines it: `/mcp remove <name>` and
 * `/mcp update <name> <command…|url>` (typed by the person), and for the AI `casper_mcp_remove` and
 * `casper_mcp_add` with `replace` (each after the person's yes in Casper's box; decision 71). A server from another
 * tool's file (Claude Code, VS Code) is never changed here: Casper says where it is and how to remove it there.
 *
 * Only the entry's name, where it is, and what it runs are shown. Its settings (env, headers) are named, never their
 * values, and stay as they are when what it runs changes.
 */

import type { RuntimeTool } from "../runtime/types";
import { scrubText } from "../secrets/scrub";
import { redactPreview, terminalText } from "../tui/format";
import { entryText, homeShown, MCP_ADD_EXAMPLE, mcpAddProblem, type McpAdd, type McpAddEntry, type McpAddHost } from "./add";
import { IMPORT_LABELS, isRecord, type MCPServerDefinition } from "./config";
import { editServerFile } from "./docs";
import { runnerPin, versionLine } from "./presets";
import { forgetServerKey } from "./server-secrets";

export const MCP_REMOVE_TOOL = "casper_mcp_remove";

export interface McpEditHost extends McpAddHost {
  /** Re-reads the files, so a removed server stops and a changed one is replaced (as /mcp reload does). */
  reload(): Promise<void>;
  /** Forgets the remembered consent to start `name`, so a server of that name added later asks again. */
  forgetConsent(name: string): Promise<void>;
}

/** Where a server is defined: one of Casper's own files or a project's (changed here), or another tool's file. */
export type ServerPlace = { kind: "file"; file: string; label: string; own: boolean }
  | { kind: "other"; label: string; how: string };

export function serverPlace(definition: MCPServerDefinition, home: string): ServerPlace {
  const from = definition.importedFrom;
  if (from === "claude" || from === "claude-project") {
    return { kind: "other", label: `${IMPORT_LABELS.claude} (Claude Code${from === "claude-project" ? ", this project" : ""})`, how: `claude mcp remove ${definition.name}` };
  }
  if (from === "vscode") return { kind: "other", label: "VS Code's settings", how: "in VS Code, MCP: List Servers" };
  if (from === "vscode-project") return { kind: "other", label: ".vscode/mcp.json (VS Code)", how: "edit .vscode/mcp.json" };
  if (from === "mcp.json") return { kind: "other", label: "~/.mcp.json", how: "edit ~/.mcp.json" };
  return { kind: "file", file: definition.source, label: homeShown(definition.source, home), own: definition.scope === "user" || definition.scope === "profile" };
}

/** What a server runs, as typed, with anything that looks like a secret hidden. */
export function runsText(entry: McpAddEntry): string {
  return scrubText(redactPreview(entryText(entry))).text;
}

/** What a loaded definition runs. */
export function definitionEntry(definition: MCPServerDefinition): McpAddEntry {
  return definition.transport.type === "http" ? { url: definition.transport.url } : { command: definition.transport.command, args: [...definition.transport.args] };
}

/** The names of a definition's own settings (env or headers), never their values. */
export function settingNames(definition: MCPServerDefinition): string[] {
  return Object.keys(definition.transport.type === "http" ? definition.transport.headers : definition.transport.env).sort();
}

async function find(host: McpAddHost, name: string): Promise<MCPServerDefinition | undefined> {
  return (await host.configured()).find((definition) => definition?.name === name);
}

export type McpEditResult = "done" | "none" | "elsewhere" | "failed";

/** Takes `name` out of the file that defines it, stops it and forgets its consent and key. Says what happened. */
export async function runMcpRemove(host: McpEditHost, name: string): Promise<McpEditResult> {
  const say = (text: string) => host.write(`[mcp] ${text}\n`);
  const definition = await find(host, name);
  if (!definition) { say(`There is no server named ${terminalText(name)}. /mcp lists them.`); return "none"; }
  const place = serverPlace(definition, host.homeDir);
  if (place.kind === "other") {
    say(`${name} is in ${place.label}, not one of Casper's files, so Casper didn't change it. Remove it there: ${place.how}.`);
    return "elsewhere";
  }
  let removed: boolean;
  try {
    removed = await editServerFile(place.file, place.label, (servers) => {
      if (!Object.hasOwn(servers, name)) return false;
      delete servers[name];
      return true;
    });
  } catch (error) { say(terminalText(error instanceof Error ? error.message : String(error))); return "failed"; }
  if (!removed) { say(`${name} isn't in ${place.label} any more. Nothing changed.`); await host.reload(); return "none"; }
  if (place.own) await forgetServerKey(host.homeDir, name).catch(() => {});
  await host.forgetConsent(name).catch(() => {});
  await host.reload();
  // A server of the same name in a file read earlier is the one used now.
  const next = await find(host, name);
  const nextPlace = next && serverPlace(next, host.homeDir);
  say(`Removed ${name} from ${place.label} and stopped it.${nextPlace ? ` The ${name} in ${nextPlace.label} is used now.` : ""}`);
  return "done";
}

/** Changes what `name` runs in the file that defines it, keeping its settings, and starts it again. */
export async function runMcpUpdate(host: McpEditHost, update: McpAdd): Promise<McpEditResult> {
  const { name, entry } = update;
  const say = (text: string) => host.write(`[mcp] ${text}\n`);
  const definition = await find(host, name);
  if (!definition) { say(`There is no server named ${terminalText(name)}. To add one: /mcp add ${name} <command> [args…].`); return "none"; }
  const place = serverPlace(definition, host.homeDir);
  if (place.kind === "other") {
    say(`${name} is in ${place.label}, not one of Casper's files, so Casper didn't change it. Change it there (${place.how}).`);
    return "elsewhere";
  }
  try {
    await editServerFile(place.file, place.label, (servers) => {
      const old = servers[name];
      const kept = isRecord(old) ? old : {};
      if ("url" in entry) {
        const { command: _command, args: _args, env: _env, cwd: _cwd, ...rest } = kept;
        servers[name] = { ...rest, type: "http", url: entry.url };
      } else {
        const { url: _url, headers: _headers, type: _type, ...rest } = kept;
        servers[name] = { ...rest, command: entry.command, args: [...entry.args], env: isRecord(kept.env) ? kept.env : {} };
      }
      return true;
    });
  } catch (error) { say(terminalText(error instanceof Error ? error.message : String(error))); return "failed"; }
  // The new program gets none of an address's settings, and the reverse: only settings of the same kind are kept.
  const sameKind = ("url" in entry) === (definition.transport.type === "http");
  const kept = sameKind ? settingNames(definition) : [];
  say(`Changed ${name} in ${place.label}: it now runs ${terminalText(runsText(entry))} (it ran ${terminalText(runsText(definitionEntry(definition)))}).`
    + `${kept.length ? ` Its settings (${kept.join(", ")}) are kept.` : ""} Starting it…`);
  let connected: { ok: boolean; message?: string };
  try { connected = await host.connect(name); }
  catch (error) { connected = { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  if (!connected.ok) {
    say(`${name} didn't start${connected.message ? `: ${terminalText(connected.message)}` : ""}. Fix that, then type /mcp connect ${name}.`);
    return "failed";
  }
  return "done";
}

// ---- For the AI --------------------------------------------------------------------------------

export interface McpEditToolHost extends McpEditHost {
  canAsk(): boolean;
  /** The box: true only for a yes the person picked (or their "Yes, for this session" earlier in this session). */
  approveEdit(preview: string, question: string, signal?: AbortSignal): Promise<boolean>;
  /** A line for the person when this run can't ask. */
  tell(text: string): void;
  describe(name: string): string | undefined;
}

/** The lines every edit box shows about the server as it is now. */
function currentLines(definition: MCPServerDefinition, place: Extract<ServerPlace, { kind: "file" }>): string[] {
  const settings = settingNames(definition);
  return [
    `  name     ${definition.name}`,
    `  from     ${place.label}`,
    ...settings.length ? [`  settings ${settings.join(", ")} (values hidden)`] : [],
  ];
}

/** Why the AI can't change this server with its tools, or the server and its file. */
async function editable(host: McpEditToolHost, name: string, verb: string): Promise<{ text: string } | { definition: MCPServerDefinition; place: Extract<ServerPlace, { kind: "file" }> }> {
  const definition = await find(host, name);
  if (!definition) return { text: `Not ${verb}: there is no server named ${name}.` };
  const place = serverPlace(definition, host.homeDir);
  if (place.kind === "other") return { text: `Not ${verb}: ${name} is in ${place.label}, not one of Casper's files. Tell the user to change it there (${place.how}).` };
  if (!place.own) return { text: `Not ${verb}: ${name} is in the project's ${place.label}. Tell the user to type /mcp ${verb === "removed" ? "remove" : "update"} ${name}, or edit that file.` };
  return { definition, place };
}

/** casper_mcp_add with replace: the AI changes what a server in Casper's own file runs, after the box. */
export async function replaceForAI(host: McpEditToolHost, update: McpAdd, signal?: AbortSignal): Promise<{ text: string; isError?: boolean }> {
  const problem = mcpAddProblem(update);
  if (problem) return { text: `Not changed: ${problem}. Example: ${MCP_ADD_EXAMPLE}`, isError: true };
  if (update.key) return { text: "Not changed: a key can't be changed this way. Tell the user to type /mcp add with the key flag for a new server.", isError: true };
  const found = await editable(host, update.name, "changed");
  if ("text" in found) return { text: found.text, isError: true };
  const { definition, place } = found;
  if (!host.canAsk()) {
    host.tell(`[mcp] The AI wanted to change what ${update.name} runs, and this run can't ask you, so nothing changed. To change it, type this in a Casper session:\n  /mcp update ${update.name} ${entryText(update.entry)}\n`);
    return { text: `Not changed: this run can't ask the user. Tell them to type this in a Casper session: /mcp update ${update.name} ${runsText(update.entry)}`, isError: true };
  }
  const next: MCPServerDefinition = { ...definition, transport: "url" in update.entry ? { type: "http", url: update.entry.url, headers: {} } : { type: "stdio", command: update.entry.command, args: update.entry.args, env: {} } };
  const preview = [
    "The AI wants to change what an MCP server runs:",
    ...currentLines(definition, place),
    `  was      ${runsText(definitionEntry(definition))}`,
    `  now      ${runsText(update.entry)}`,
    `  version  ${versionLine(next)}`,
    "url" in update.entry ? `It is changed in ${place.label} and connects again now.` : `It is changed in ${place.label} and starts again now, outside the sandbox, with your permissions.`,
    "",
  ].join("\n");
  if (!await host.approveEdit(preview, `Change ${update.name}?`, signal)) return { text: "Not changed: the user said no. Nothing changed.", isError: true };
  const said: string[] = [];
  const result = await runMcpUpdate({ ...host, write: (text) => { said.push(text); host.write(text); } }, update);
  if (result !== "done") return { text: `Not ready: ${said.join("").replace(/\[mcp\] /g, "").trim()}`, isError: true };
  return { text: `Changed ${update.name} in ${place.label} and started it (${host.describe(update.name) ?? "connected"}).` };
}

export function mcpRemoveTool(host: McpEditToolHost): RuntimeTool {
  return {
    name: MCP_REMOVE_TOOL,
    description: "Remove an MCP server from the user's ~/.casper/mcp.json and stop it. Casper shows the user the server and asks first. "
      + "To change what a server runs (a new version), use casper_mcp_add with replace: true instead of adding a second one.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" } } },
    sequential: true,
    async execute(args, signal) {
      if (typeof args.name !== "string" || !args.name) return { text: "Not removed: name must be a server's name.", isError: true };
      const found = await editable(host, args.name, "removed");
      if ("text" in found) return { text: found.text, isError: true };
      const { definition, place } = found;
      if (!host.canAsk()) {
        host.tell(`[mcp] The AI wanted to remove ${args.name}, and this run can't ask you, so nothing changed. To remove it, type this in a Casper session:\n  /mcp remove ${args.name}\n`);
        return { text: `Not removed: this run can't ask the user. Tell them to type this in a Casper session: /mcp remove ${args.name}`, isError: true };
      }
      const preview = [
        "The AI wants to remove an MCP server:",
        ...currentLines(definition, place).slice(0, 2),
        `  runs     ${runsText(definitionEntry(definition))}`,
        ...currentLines(definition, place).slice(2),
        `It is taken out of ${place.label} and stopped.`,
        "",
      ].join("\n");
      if (!await host.approveEdit(preview, `Remove ${args.name}?`, signal)) return { text: "Not removed: the user said no. Nothing changed.", isError: true };
      const said: string[] = [];
      const result = await runMcpRemove({ ...host, write: (text) => { said.push(text); host.write(text); } }, args.name);
      const text = said.join("").replace(/\[mcp\] /g, "").trim();
      return result === "done" ? { text } : { text: `Not removed: ${text}`, isError: true };
    },
  };
}

// ---- A newer npm version --------------------------------------------------------------------------

/** The npm package and version a server's command pins (npx -y rea-agents@6.7.0 mcp), or undefined. */
export function npmPin(definition: MCPServerDefinition): { name: string; version: string } | undefined {
  const pin = runnerPin(definition);
  if (pin?.kind !== "npm" || !pin.pinned || !pin.spec) return undefined;
  const match = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/i.exec(pin.spec);
  return match ? { name: match[1]!, version: match[2]! } : undefined;
}

/** The newest version npm's registry lists for a package, in a few seconds at most; undefined when it can't tell. */
export async function npmLatest(name: string, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const response = await fetcher(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, { signal: AbortSignal.timeout(3000), redirect: "error" });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const version = isRecord(body) ? body.version : undefined;
    return typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ? version : undefined;
  } catch { return undefined; }
}

function newer(a: string, b: string): boolean {
  const parts = (version: string) => version.split(/[-+]/)[0]!.split(".").map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) if (x[index]! !== y[index]!) return x[index]! > y[index]!;
  return false;
}

/** "rea: rea-agents 6.8.0 is out (it runs 6.7.0). To use it: /mcp update rea …", or undefined when it runs the newest. */
export function newerNpmLine(definition: MCPServerDefinition, latest: string | undefined): string | undefined {
  const pin = npmPin(definition);
  if (!pin || !latest || !newer(latest, pin.version) || definition.transport.type !== "stdio") return undefined;
  const entry = { command: definition.transport.command, args: definition.transport.args.map((arg) => arg === `${pin.name}@${pin.version}` ? `${pin.name}@${latest}` : arg) };
  return `${definition.name}: ${pin.name} ${latest} is out (it runs ${pin.version}). To use it: /mcp update ${definition.name} ${runsText(entry)}`;
}
