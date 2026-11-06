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
import { formatDuration, redactPreview, terminalText } from "../tui/format";
import { entryText, homeShown, MCP_ADD_EXAMPLE, mcpAddProblem, type McpAddEntry, type McpAddHost } from "./add";
import { IMPORT_LABELS, isRecord, MAX_CALL_SECONDS, type MCPServerDefinition } from "./config";
import { editServerFile } from "./docs";
import { runnerPin, versionLine } from "./presets";
import { forgetServerKey, saveServerKey } from "./server-secrets";
import { isSecretKey as isSecretName } from "../secrets/scrub";

export const MCP_REMOVE_TOOL = "casper_mcp_remove";

export interface McpEditHost extends McpAddHost {
  /** Re-reads the files, so a removed server stops and a changed one is replaced (as /mcp reload does). */
  reload(): Promise<void>;
  /** Starts a running server again once its calls finish, so it lists its tools again. */
  restart(name: string): Promise<void>;
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
  // The app that started casper acp handed it over for this session: no file holds it (decision 77).
  if (definition.scope === "client") return { kind: "other", label: "the app that started Casper", how: "change it in the app" };
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

/** A change to one server: what it runs, its call time limit, and environment variables (values the AI may see). */
export interface McpUpdate {
  name: string;
  /** What it runs now; unset keeps it. */
  entry?: McpAddEntry;
  /** The longest a call may go without an answer, in seconds ("callTimeout" in the file). */
  timeoutS?: number;
  /** Environment variables to set; other variables stay. Never a secret: those are the person's hidden key. */
  env?: Record<string, string>;
  /** A secret variable the person typed hidden after the box: the server starts again to read it. */
  keySaved?: string;
}

/** "300", "300s", "5m", "1h": seconds, from 1 to MAX_CALL_SECONDS; or why it can't be used. */
export function parseTimeout(text: string): number | { error: string } {
  const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)?$/i.exec(text.trim());
  const unit = match?.[2]?.[0]?.toLowerCase() ?? "s";
  const seconds = match ? Math.round(Number(match[1]) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1)) : NaN;
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > MAX_CALL_SECONDS) {
    return { error: `A timeout is a length from 1s to ${formatDuration(MAX_CALL_SECONDS * 1000)}, such as 300s or 5m.` };
  }
  return seconds;
}

/** "/mcp update <name> --timeout 5m [<command> [args…]|<url>]": the timeout taken out of the words, wherever it is. */
export function splitTimeoutFlag(text: string): { rest: string; timeout?: string } | { error: string } {
  const match = /(?:^|\s)--timeout(?:=|\s+)(\S+)(?=\s|$)/.exec(text);
  if (!match) return /(?:^|\s)--timeout(?:\s|$)/.test(text) ? { error: "--timeout needs a length, such as --timeout 5m." } : { rest: text };
  return { rest: `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`.replace(/\s+/g, " ").trim(), timeout: match[1]! };
}

function sameRun(definition: MCPServerDefinition, entry: McpAddEntry): boolean {
  return entryText(entry) === entryText(definitionEntry(definition));
}

/** Changes what `name` runs, its call time limit or its environment, in the file that defines it, keeping its other
 * settings. A change to what it runs or its environment starts it again, also when what it runs is the same, so its
 * tools are listed again; a new time limit applies to the next call. */
export async function runMcpUpdate(host: McpEditHost, update: McpUpdate): Promise<McpEditResult> {
  const { name, entry, timeoutS, env } = update;
  const say = (text: string) => host.write(`[mcp] ${text}\n`);
  const definition = await find(host, name);
  if (!definition) { say(`There is no server named ${terminalText(name)}. To add one: /mcp add ${name} <command> [args…].`); return "none"; }
  const place = serverPlace(definition, host.homeDir);
  if (place.kind === "other") {
    say(`${name} is in ${place.label}, not one of Casper's files, so Casper didn't change it. Change it there (${place.how}).`);
    return "elsewhere";
  }
  const atAddress = entry ? "url" in entry : definition.transport.type === "http";
  if (atAddress && env && Object.keys(env).length) { say(`${name} is a server at an address: it has no environment. Nothing changed.`); return "failed"; }
  try {
    await editServerFile(place.file, place.label, (servers) => {
      const old = servers[name];
      let next: Record<string, unknown> = isRecord(old) ? { ...old } : {};
      if (entry && "url" in entry) {
        const { command: _command, args: _args, env: _env, cwd: _cwd, ...rest } = next;
        next = { ...rest, type: "http", url: entry.url };
      } else if (entry) {
        const { url: _url, headers: _headers, type: _type, ...rest } = next;
        next = { ...rest, command: entry.command, args: [...entry.args], env: isRecord(next.env) ? next.env : {} };
      }
      if (env && Object.keys(env).length) next.env = { ...isRecord(next.env) ? next.env : {}, ...env };
      if (timeoutS !== undefined) next.callTimeout = timeoutS;
      servers[name] = next;
      return true;
    });
  } catch (error) { say(terminalText(error instanceof Error ? error.message : String(error))); return "failed"; }
  const parts: string[] = [];
  if (entry && !sameRun(definition, entry)) {
    // The new program gets none of an address's settings, and the reverse: only settings of the same kind are kept.
    const sameKind = ("url" in entry) === (definition.transport.type === "http");
    const kept = sameKind ? settingNames(definition).filter((key) => !env || !Object.hasOwn(env, key)) : [];
    parts.push(`it now runs ${terminalText(runsText(entry))} (it ran ${terminalText(runsText(definitionEntry(definition)))}).${kept.length ? ` Its settings (${kept.join(", ")}) are kept.` : ""}`);
  }
  if (env && Object.keys(env).length) parts.push(`it now sets ${Object.keys(env).sort().join(", ")}.`);
  if (update.keySaved) parts.push(`it now gets ${update.keySaved}, which you typed (kept in Casper's private key file).`);
  if (timeoutS !== undefined) {
    const was = definition.limits?.callMs;
    parts.push(`it waits up to ${formatDuration(timeoutS * 1000)} for each call${was ? ` (it waited ${formatDuration(was)})` : ""}.`);
  }
  const restart = Boolean(entry || (env && Object.keys(env).length) || update.keySaved);
  const sentences = parts.map((part, index) => index ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part).join(" ");
  if (!restart) {
    say(`Changed ${name} in ${place.label}: ${sentences}`);
    await host.reload();
    return "done";
  }
  const unchanged = !parts.length;
  say(unchanged ? `${name} runs ${terminalText(runsText(definitionEntry(definition)))}, as before, in ${place.label}. Starting it again, so its tools are listed again…`
    : `Changed ${name} in ${place.label}: ${sentences} Starting it…`);
  let connected: { ok: boolean; message?: string };
  try {
    connected = await host.connect(name);
    // The same program and environment: re-reading the file keeps the running server, so it starts again here.
    const now = await find(host, name);
    if (connected.ok && now && JSON.stringify(now.transport) === JSON.stringify(definition.transport)) {
      await host.restart(name);
      connected = await host.connect(name);
    }
  } catch (error) { connected = { ok: false, message: error instanceof Error ? error.message : String(error) }; }
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

/** What the AI asks to change with casper_mcp_add and replace: true. Every part is optional but the name. */
export interface McpReplace {
  name: string;
  entry?: McpAddEntry;
  timeoutS?: number;
  /** Variables to set. A secret-looking name takes no value from the AI: the person types it hidden after the box. */
  env?: Record<string, string>;
}

/** casper_mcp_add with replace: the AI changes a server in Casper's own file (what it runs, its environment, its call
 * time limit), after the box. The same command again restarts it, so a server whose code changed lists its tools again. */
export async function replaceForAI(host: McpEditToolHost, change: McpReplace, signal?: AbortSignal): Promise<{ text: string; isError?: boolean }> {
  const { name } = change;
  if (change.entry) {
    const problem = mcpAddProblem({ name, entry: change.entry });
    if (problem) return { text: `Not changed: ${problem}. Example: ${MCP_ADD_EXAMPLE}`, isError: true };
  }
  const env = change.env ?? {};
  const badName = Object.keys(env).find((key) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key));
  if (badName !== undefined) return { text: `Not changed: ${badName.slice(0, 64)} is not an environment variable name.`, isError: true };
  const secrets = Object.keys(env).filter((key) => isSecretName(key));
  const given = secrets.filter((key) => env[key] !== "");
  if (given.length) return { text: `Not changed: ${given.join(", ")} looks like a secret, so the AI never sets its value. Give it as "" and the user types it hidden after their yes.`, isError: true };
  if (secrets.length > 1) return { text: "Not changed: one secret variable at a time (the user types it hidden).", isError: true };
  const plain = Object.fromEntries(Object.entries(env).filter(([key]) => !secrets.includes(key)));
  const badValue = Object.entries(plain).find(([, value]) => value.length > 1024 || /[\x00-\x1f\x7f]/.test(value));
  if (badValue) return { text: `Not changed: ${badValue[0]}'s value must be one line, up to 1024 characters.`, isError: true };
  const found = await editable(host, name, "changed");
  if ("text" in found) return { text: found.text, isError: true };
  const { definition, place } = found;
  if (!change.entry && change.timeoutS === undefined && !Object.keys(env).length) {
    return { text: `Not changed: say what to change: command (with args) or url, env, or timeout. The same command again restarts ${name}.`, isError: true };
  }
  const atAddress = change.entry ? "url" in change.entry : definition.transport.type === "http";
  if (atAddress && Object.keys(env).length) return { text: `Not changed: ${name} is a server at an address, so it has no environment.`, isError: true };
  const line = `/mcp update ${name}${change.timeoutS !== undefined ? ` --timeout ${change.timeoutS}s` : ""}${change.entry ? ` ${runsText(change.entry)}` : ""}`;
  if (!host.canAsk()) {
    host.tell(`[mcp] The AI wanted to change ${name}, and this run can't ask you, so nothing changed.${!Object.keys(env).length ? ` To change it, type this in a Casper session:\n  ${line}` : ""}\n`);
    return { text: `Not changed: this run can't ask the user.${!Object.keys(env).length ? ` Tell them to type this in a Casper session: ${line}` : ""}`, isError: true };
  }
  const current = definition.transport.type === "stdio" ? definition.transport.env : {};
  const shownValue = (key: string, value: string | undefined) => value === undefined ? "not set"
    : isSecretName(key) || runsText({ url: value }) !== value ? "set (hidden)" : value;
  const runsChanged = change.entry && !sameRun(definition, change.entry);
  const next: MCPServerDefinition | undefined = change.entry ? { ...definition, transport: "url" in change.entry ? { type: "http", url: change.entry.url, headers: {} } : { type: "stdio", command: change.entry.command, args: change.entry.args, env: {} } } : undefined;
  const preview = [
    runsChanged ? "The AI wants to change what an MCP server runs:" : "The AI wants to change an MCP server:",
    ...currentLines(definition, place),
    ...runsChanged ? [`  was      ${runsText(definitionEntry(definition))}`, `  now      ${runsText(change.entry!)}`, `  version  ${versionLine(next!)}`]
      : [`  runs     ${runsText(definitionEntry(definition))}${change.entry ? " (the same: it starts again and lists its tools again)" : ""}`],
    ...Object.entries(plain).sort().map(([key, value]) => `  env      ${key}: ${shownValue(key, current[key])} → ${terminalText(scrubText(value).text)}`),
    ...secrets.map((key) => `  env      ${key}: you type it next, hidden; the AI never sees it`),
    ...change.timeoutS !== undefined ? [`  timeout  ${formatDuration(definition.limits?.callMs ?? 90_000)} → ${formatDuration(change.timeoutS * 1000)} for each call`] : [],
    change.entry || Object.keys(env).length
      ? atAddress ? `It is changed in ${place.label} and connects again now.` : `It is changed in ${place.label} and starts again now, outside the sandbox, with your permissions.`
      : `It is changed in ${place.label}; the next call has the new limit.`,
    "",
  ].join("\n");
  if (!await host.approveEdit(preview, `Change ${name}?`, signal)) return { text: "Not changed: the user said no. Nothing changed.", isError: true };
  let keySaved: string | undefined;
  if (secrets.length) {
    const key = secrets[0]!;
    const typed = (await host.privateInput?.(`${key} for ${name}`))?.trim();
    if (!typed) return { text: `Not changed: the user typed no value for ${key}. Nothing changed.`, isError: true };
    try { await saveServerKey(host.homeDir, name, { kind: "env", name: key }, typed); }
    catch (error) { return { text: `Not changed: ${error instanceof Error ? error.message : String(error)}`, isError: true }; }
    keySaved = key;
  }
  const said: string[] = [];
  const result = await runMcpUpdate({ ...host, write: (text) => { said.push(text); host.write(text); } },
    { name, ...change.entry ? { entry: change.entry } : {}, ...change.timeoutS !== undefined ? { timeoutS: change.timeoutS } : {},
      ...Object.keys(plain).length ? { env: plain } : {}, ...keySaved ? { keySaved } : {} });
  if (result !== "done") return { text: `Not ready: ${said.join("").replace(/\[mcp\] /g, "").trim()}`, isError: true };
  if (!change.entry && !Object.keys(env).length) return { text: `Changed ${name} in ${place.label}: each call may take up to ${formatDuration(change.timeoutS! * 1000)}.` };
  return { text: `${runsChanged || Object.keys(env).length ? "Changed" : "Restarted"} ${name} in ${place.label} and started it (${host.describe(name) ?? "connected"}).` };
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
