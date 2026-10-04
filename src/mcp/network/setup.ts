import { NETWORK_SETUP_CHOICES, NETWORK_UPDATE_CHOICES, numberedLines } from "../../app/safe-choices";
import { installedVersion, installLockedSpec, UV_MISSING_NETWORK, type InstallOptions, type NumberedQuestion } from "../../security/install";
import type { LockedSpec } from "../../security/tools";
import type { MCPServerDefinition } from "../config";
import { addUserServer, MCP_FILE_LABEL, ServerExistsError } from "../docs";
import { matchPreset } from "../presets";
import { NETWORK_SERVER, NETWORK_SERVER_NAME, networkServerEntry, readSetupState, writeSetupState } from "./server";

/**
 * Casper sets up its own network server after one numbered question (1 Not now · 2 Set it up). Only the
 * person answers it, on the exact-answer channel: the AI's ask tool has no way in, and a key typed before
 * the question appeared never answers it. One-shot runs never ask or install; they say what to type.
 */

export type SetupResult = "not-now" | "installed" | "updated" | "exists" | "failed" | "cant-ask";
export type UpdateResult = "not-now" | "updated" | "current" | "failed" | "cant-ask";

export interface SetupHost {
  homeDir: string;
  /** False in a one-shot run, or a terminal that can't take an exact answer. */
  canAsk(): boolean;
  /** One exact typed answer from the person (never the AI), or undefined when nobody answered. */
  chooseAnswer(preview: string, question: string, choices: readonly string[]): Promise<string | undefined>;
  write(text: string): void;
  /** The MCP server definitions Casper has loaded now. */
  configured(): Promise<readonly MCPServerDefinition[]>;
  /** Re-reads ~/.casper/mcp.json, connects `name` and remembers it (the person's 2 counts as /mcp connect + Remember). */
  connect(name: string): Promise<{ ok: boolean; message?: string }>;
  /** Restarts a connected server once its running calls finish; `whileStopped` runs while it is stopped (just runs, when
   * it isn't connected). It starts again even when `whileStopped` fails. */
  restart(name: string, whileStopped?: () => Promise<void>): Promise<void>;
  /** Test seams for the download. */
  install?: Pick<InstallOptions, "env" | "run" | "platform">;
  installer?: (spec: LockedSpec, options: InstallOptions & { uvMissing?: string }) => Promise<{ ok: boolean; message: string; entryPath?: string }>;
}

const CANT_ASK_SETUP = "This run can't ask you. Type /mcp setup network in the terminal to set up the network server.";
const CANT_ASK_UPDATE = "The network server has an update. Type /mcp setup network in the terminal to update it.";
const NOT_NOW = "Not set up. Type /mcp setup network any time.";
const READY = "Network server ready (read-only). Ask about Mist, Central or ClearPass; Casper asks for each login the first time.";

/** The question: what is installed, how big, from where; it starts read-only; logins come later, per product. */
export function networkSetupQuestion(): NumberedQuestion {
  return {
    text: `Casper can set up its network server (${NETWORK_SERVER.label} ${NETWORK_SERVER.version}, about ${NETWORK_SERVER.approxMB} MB from ${NETWORK_SERVER.hosts[0]}, installed with uv into ~/.casper/tools).\n`
      + "It starts read-only. Logins are asked per product the first time you use it.",
    choices: [...NETWORK_SETUP_CHOICES],
  };
}

function updateQuestion(from: string): NumberedQuestion {
  return {
    text: `Casper's network server has an update (${from} → ${NETWORK_SERVER.version}, about ${NETWORK_SERVER.approxMB} MB from ${NETWORK_SERVER.hosts[0]}).`,
    choices: [...NETWORK_UPDATE_CHOICES],
  };
}

/** A request that names a network product: Mist, Central, ClearPass, Aruba, Wi-Fi, a WLAN, an SSID, a switch port or an access point. */
export function namesNetworkProduct(prompt: string): boolean {
  return /\b(?:mist|central|clearpass|aruba|wi-?fi|wlans?|ssids?|switch ?ports?|access ?points?)\b/i.test(prompt);
}

function stdioWords(definition: MCPServerDefinition): string[] {
  if (definition.transport.type !== "stdio") return [];
  return [definition.transport.command, ...definition.transport.args].map((word) => word.toLowerCase());
}

/** The entry Casper wrote: exactly its installed program. Only this one is ever updated. */
function isCaspersEntry(definition: MCPServerDefinition, homeDir: string): boolean {
  return definition.transport.type === "stdio" && definition.transport.command === networkServerEntry(homeDir).command;
}

/** Any casper-network-mcp (however it runs) or hpe-networking-mcp server: a network server is already there. */
function isNetworkServer(definition: MCPServerDefinition): boolean {
  return stdioWords(definition).some((word) => /casper[-_]network[-_]mcp/.test(word)) || matchPreset(definition)?.preset.id === "hpe-networking-mcp";
}

/** Offer setup only when no network server is there, the name is free, and the person hasn't said Not now. */
export async function shouldOfferNetworkSetup(homeDir: string, configured: readonly MCPServerDefinition[]): Promise<boolean> {
  if (configured.some((definition) => definition.name === NETWORK_SERVER_NAME || isNetworkServer(definition))) return false;
  return (await readSetupState(homeDir)).answer !== "not-now";
}

/** The installed version when Casper's own entry runs an older (or newer) pin than this Casper's. */
async function availableUpdate(homeDir: string, configured: readonly MCPServerDefinition[]): Promise<{ name: string; from: string; to: string } | undefined> {
  const ours = configured.find((definition) => isCaspersEntry(definition, homeDir));
  if (!ours) return undefined;
  const installed = await installedVersion(homeDir, NETWORK_SERVER);
  return installed && installed !== NETWORK_SERVER.version ? { name: ours.name, from: installed, to: NETWORK_SERVER.version } : undefined;
}

/** An update to ask about at start: there is one, and the person hasn't said Not now to this version. */
export async function shouldOfferNetworkUpdate(homeDir: string, configured: readonly MCPServerDefinition[]): Promise<{ from: string; to: string } | undefined> {
  const update = await availableUpdate(homeDir, configured);
  if (!update || (await readSetupState(homeDir)).updateNotNow === update.to) return undefined;
  return { from: update.from, to: update.to };
}

/** The one /mcp line about Casper's network server, or undefined when there's nothing to say. */
export async function networkSetupLine(homeDir: string, configured: readonly MCPServerDefinition[]): Promise<string | undefined> {
  const update = await availableUpdate(homeDir, configured);
  if (update) return `${update.name}: update ready (${update.from} → ${update.to}) — /mcp setup network`;
  const ours = configured.find((definition) => isCaspersEntry(definition, homeDir));
  if (ours) return await installedVersion(homeDir, NETWORK_SERVER) ? undefined : `${ours.name}: not installed — /mcp setup network`;
  if (configured.some((definition) => definition.name === NETWORK_SERVER_NAME || isNetworkServer(definition))) return undefined;
  return `${NETWORK_SERVER_NAME}: not set up — /mcp setup network`;
}

async function ask(host: SetupHost, question: NumberedQuestion): Promise<string | undefined> {
  return host.chooseAnswer(`${question.text}\n${numberedLines(question.choices)}`, "Type 1 or 2: ", ["1", "2"]);
}

function install(host: SetupHost, swap?: (renames: () => Promise<void>) => Promise<void>) {
  return (host.installer ?? installLockedSpec)(NETWORK_SERVER, {
    homeDir: host.homeDir, write: (text) => host.write(text), uvMissing: UV_MISSING_NETWORK, ...host.install, ...(swap ? { swap } : {}),
  });
}

/**
 * The setup question and flow. `explicit` is /mcp setup network; otherwise the host offers it before the AI's
 * first turn that names a network product. On 2: install (hash-locked), add `network` to ~/.casper/mcp.json
 * (never over an entry already there), connect it remembered with writes off.
 */
export async function runNetworkSetup(host: SetupHost, _options: { explicit: boolean }): Promise<SetupResult> {
  if (!host.canAsk()) { host.write(`${CANT_ASK_SETUP}\n`); return "cant-ask"; }
  const configured = await host.configured();
  const ours = configured.find((definition) => isCaspersEntry(definition, host.homeDir));
  if (ours) {
    const installed = await installedVersion(host.homeDir, NETWORK_SERVER);
    if (installed && installed !== NETWORK_SERVER.version) {
      const updated = await runNetworkUpdate(host, { explicit: true });
      return updated === "current" ? "exists" : updated;
    }
    if (installed) {
      host.write(`The network server is already set up (${NETWORK_SERVER.label} ${installed}). /mcp connect ${ours.name} connects it.\n`);
      return "exists";
    }
  } else if (configured.some((definition) => definition.name === NETWORK_SERVER_NAME)) {
    host.write(`${NETWORK_SERVER_NAME} is already in ${MCP_FILE_LABEL}. Nothing changed.\n`);
    return "exists";
  }
  const answer = await ask(host, networkSetupQuestion());
  if (answer !== "2") {
    // Only the person's 1 is kept; nobody answering (closed, cancelled) keeps nothing.
    if (answer === "1") await writeSetupState(host.homeDir, { answer: "not-now" });
    if (answer !== undefined) host.write(`${NOT_NOW}\n`);
    return "not-now";
  }
  const installed = await install(host);
  if (!installed.ok) { host.write(`${installed.message}\n`); return "failed"; }
  const name = ours?.name ?? NETWORK_SERVER_NAME;
  if (!ours) {
    try {
      await addUserServer(host.homeDir, name, networkServerEntry(host.homeDir));
    } catch (error) {
      host.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return error instanceof ServerExistsError ? "exists" : "failed";
    }
  }
  let connected: { ok: boolean; message?: string };
  try { connected = await host.connect(name); }
  catch (error) { connected = { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  if (!connected.ok) {
    host.write(`The network server is installed but didn't start${connected.message ? `: ${connected.message}` : ""}. /mcp connect ${name} tries again.\n`);
    return "failed";
  }
  host.write(`${READY}\n`);
  return "installed";
}

/**
 * When this Casper pins a different version than the one installed: 1 Not now · 2 Update it. On 2 the new version is
 * built beside the old one while it runs; then, once its running calls finish, the server stops, the folders are
 * swapped (the command in ~/.casper/mcp.json, its hash and its remembered approval stay) and it starts again. A swap
 * that fails (Windows keeps a running program's folder locked) puts the old folder back and starts that. Not now is
 * kept per version.
 */
export async function runNetworkUpdate(host: SetupHost, options: { explicit: boolean }): Promise<UpdateResult> {
  const update = await availableUpdate(host.homeDir, await host.configured());
  if (!update) return "current";
  if (!options.explicit && (await readSetupState(host.homeDir)).updateNotNow === update.to) return "not-now";
  if (!host.canAsk()) { host.write(`${CANT_ASK_UPDATE}\n`); return "cant-ask"; }
  const answer = await ask(host, updateQuestion(update.from));
  if (answer !== "2") {
    if (answer === "1") await writeSetupState(host.homeDir, { updateNotNow: update.to });
    if (answer !== undefined) host.write(`Not updated. The network server keeps ${update.from}. Type /mcp setup network to update.\n`);
    return "not-now";
  }
  let swapFailed = false;
  const installed = await install(host, (renames) => host.restart(update.name, async () => {
    try { await renames(); } catch (error) { swapFailed = true; throw error; }
  }));
  if (!installed.ok) {
    host.write(swapFailed
      ? `Casper couldn't swap in the new version (its files are in use). The network server keeps ${update.from} and is running again. Close any other Casper window, then type /mcp setup network.\n`
      : `${installed.message}\nThe network server keeps ${update.from}.\n`);
    return "failed";
  }
  host.write(`Network server updated to ${update.to}.\n`);
  return "updated";
}
