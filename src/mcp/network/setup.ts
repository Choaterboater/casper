import { NETWORK_SETUP_CHOICES, NETWORK_SETUP_UV_CHOICES, NETWORK_UPDATE_CHOICES, numberedLines } from "../../app/safe-choices";
import { installEnv } from "../../security/env";
import { findUv, installedVersion, installLockedSpec, UV_MISSING_NETWORK, type InstallOptions, type NumberedQuestion } from "../../security/install";
import type { LockedSpec } from "../../security/tools";
import type { MCPServerDefinition } from "../config";
import { addUserServer, MCP_FILE_LABEL, ServerExistsError } from "../docs";
import { matchPreset } from "../presets";
import { normaliseWords } from "../../skills/bundled";
import { fetchReleaseLock, NETWORK_RELEASE_HOSTS, networkReleasesOff, newerNetworkRelease, releaseSpec, type NetworkReleaseOptions } from "./releases";
import { NETWORK_SERVER, NETWORK_SERVER_NAME, networkServerEntry, readSetupState, writeSetupState } from "./server";
import { runUvInstaller, uvInstaller } from "./uv";

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
  /** Runs uv's official installer (test seam). */
  uvInstaller?: () => Promise<{ ok: boolean; message?: string }>;
  /** Network server releases newer than the bundled pin: whether they are off, and test seams. Unset: off only with CASPER_OFFLINE=1. */
  releases?: NetworkReleaseOptions;
}

function releaseOptions(releases: NetworkReleaseOptions | undefined): NetworkReleaseOptions {
  if (releases) return releases;
  const off = networkReleasesOff(process.env, {});
  return off ? { off } : {};
}

/** The version to install: the newest release Casper knows of that is newer than both the installed version and the
 * bundled pin, or else the bundled pin (the floor, and the one used offline). */
export async function networkUpdateTarget(homeDir: string, installed: string | undefined, releases?: NetworkReleaseOptions): Promise<string> {
  return await newerNetworkRelease(homeDir, installed, releaseOptions(releases)) ?? NETWORK_SERVER.version;
}

const CANT_ASK_SETUP = "This run can't ask you. Type /mcp setup network in the terminal to set up the network server.";
const CANT_ASK_UPDATE = "The network server has an update. Type /mcp setup network in the terminal to update it.";
const NOT_NOW = "Not set up. Type /mcp setup network any time.";
const READY = "Network server ready (read-only). Ask about Mist, Central or ClearPass; Casper asks for each login the first time.";

/** The question: what is installed, how big, from where; it starts read-only; logins come later, per product. */
export function networkSetupQuestion(version = NETWORK_SERVER.version): NumberedQuestion {
  return {
    text: `Casper can set up its network server (${NETWORK_SERVER.label} ${version}, about ${NETWORK_SERVER.approxMB} MB from ${NETWORK_SERVER.hosts[0]}, installed with uv into ~/.casper/tools).\n`
      + "It starts read-only. Logins are asked per product the first time you use it.",
    choices: [...NETWORK_SETUP_CHOICES],
  };
}

/** The same question when uv isn't installed: it says so and shows uv's official installer, which 2 runs first. */
export function networkSetupUvQuestion(platform: NodeJS.Platform = process.platform, version = NETWORK_SERVER.version): NumberedQuestion {
  return {
    text: `${networkSetupQuestion(version).text}\nIt needs uv, which isn't installed. Casper installs it first with uv's official installer:\n  ${uvInstaller(platform).shown}`,
    choices: [...NETWORK_SETUP_UV_CHOICES],
  };
}

function hasUv(host: SetupHost): Promise<boolean> {
  return findUv(installEnv(host.install?.env ?? process.env), host.homeDir, host.install?.platform ?? process.platform).then(Boolean);
}

/** Said first when `version` is a release newer than the one this Casper ships with (the question's own words stay
 * last, so its one-line record reads as before). */
function fromReleaseNote(version: string): string {
  return version === NETWORK_SERVER.version ? ""
    : `${version} is newer than the one this Casper ships with (${NETWORK_SERVER.version}); its hash lock comes from that release on ${NETWORK_RELEASE_HOSTS[1]} and is checked first.\n`;
}

function updateQuestion(from: string, to: string): NumberedQuestion {
  return {
    text: `${fromReleaseNote(to)}Casper's network server has an update (${from} → ${to}, about ${NETWORK_SERVER.approxMB} MB from ${NETWORK_SERVER.hosts[0]}).`,
    choices: [...NETWORK_UPDATE_CHOICES],
  };
}

/** Words that name a network product or thing on their own (the network skills' strong triggers, plus a few more). */
const STRONG_NETWORK_WORDS = [
  "mist api", "juniper mist", "mistapi", "mist org", "mist site", "mist sites", "marvis", "clearpass", "cppm", "pyclearpass",
  "aruba central", "aruba networking central", "new central", "classic central", "central classic", "central api", "pycentral",
  "greenlake", "glp", "wlan", "wlans", "ssid", "ssids", "switch port", "switch ports", "switchport", "switchports",
  "access point", "access points",
];
/** Words that are also everyday web and code words ("central store", "mist effect", "wifi icon"): they count only
 * next to a network word. */
const LOOSE_NETWORK_WORDS = ["mist", "central", "aruba", "wifi", "wi fi", "wireless"];
/** The network words a loose word needs in the same request. */
const NETWORK_NOUNS = new Set([
  "ap", "aps", "site", "sites", "switch", "switches", "gateway", "gateways", "clients", "device", "devices", "org", "vlan", "vlans",
  "radio", "radios", "rf", "roaming", "controller", "controllers", "inventory", "firmware", "network", "networks", "sitegroup",
]);

/** A request that names a network product: Mist, Marvis, Central, GreenLake, ClearPass, Aruba, Wi-Fi, a WLAN, an SSID,
 * a switch port or an access point. Strong words count on their own (as in the network skills' matcher); loose ones
 * only next to a network word, so "central logging" or "a wifi icon" in a web app never brings up the offer. */
export function namesNetworkProduct(prompt: string): boolean {
  const words = normaliseWords(prompt);
  const text = ` ${words.join(" ")} `;
  const has = (phrase: string) => text.includes(` ${phrase} `);
  if (STRONG_NETWORK_WORDS.some(has)) return true;
  return LOOSE_NETWORK_WORDS.some(has) && words.some((word) => NETWORK_NOUNS.has(word));
}

function stdioWords(definition: MCPServerDefinition): string[] {
  if (definition.transport.type !== "stdio") return [];
  return [definition.transport.command, ...definition.transport.args].map((word) => word.toLowerCase());
}

/** The entry Casper wrote: exactly its installed program. Only this one is ever updated. */
export function isCaspersEntry(definition: MCPServerDefinition, homeDir: string): boolean {
  return definition.transport.type === "stdio" && definition.transport.command === networkServerEntry(homeDir).command;
}

/** Any casper-network-mcp (however it runs) or hpe-networking-mcp server: a network server is already there. */
export function isNetworkServer(definition: MCPServerDefinition): boolean {
  return stdioWords(definition).some((word) => /casper[-_]network[-_]mcp/.test(word)) || matchPreset(definition)?.preset.id === "hpe-networking-mcp";
}

/** Offer setup only when no network server is there, the name is free, and the person hasn't said Not now. */
export async function shouldOfferNetworkSetup(homeDir: string, configured: readonly MCPServerDefinition[]): Promise<boolean> {
  if (configured.some((definition) => definition.name === NETWORK_SERVER_NAME || isNetworkServer(definition))) return false;
  return (await readSetupState(homeDir)).answer !== "not-now";
}

/** True when version `a` is older than `b` (dotted numbers; anything else is never older). */
function olderThan(a: string, b: string): boolean {
  const parse = (version: string) => /^\d+(?:\.\d+)*$/.test(version) ? version.split(".").map(Number) : undefined;
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference < 0;
  }
  return false;
}

/** The installed version when Casper's own entry runs an older version than this Casper's pin or the newest release
 * it knows of. A newer one (put there by a newer Casper on the same machine) is kept: offering it would be a downgrade.
 * Any other entry (your own, or `uv run --directory <checkout>`) is never updated. */
async function availableUpdate(homeDir: string, configured: readonly MCPServerDefinition[], releases?: NetworkReleaseOptions): Promise<{ name: string; from: string; to: string } | undefined> {
  const ours = configured.find((definition) => isCaspersEntry(definition, homeDir));
  if (!ours) return undefined;
  const installed = await installedVersion(homeDir, NETWORK_SERVER);
  if (!installed) return undefined;
  const target = await networkUpdateTarget(homeDir, installed, releases);
  return olderThan(installed, target) ? { name: ours.name, from: installed, to: target } : undefined;
}

/** An update to ask about at start: there is one, and the person hasn't said Not now to this version. */
export async function shouldOfferNetworkUpdate(homeDir: string, configured: readonly MCPServerDefinition[], releases?: NetworkReleaseOptions): Promise<{ from: string; to: string } | undefined> {
  const update = await availableUpdate(homeDir, configured, releases);
  if (!update || (await readSetupState(homeDir)).updateNotNow === update.to) return undefined;
  return { from: update.from, to: update.to };
}

/** The one /mcp line about Casper's network server, or undefined when there's nothing to say. */
export async function networkSetupLine(homeDir: string, configured: readonly MCPServerDefinition[], releases?: NetworkReleaseOptions): Promise<string | undefined> {
  const update = await availableUpdate(homeDir, configured, releases);
  if (update) return `${update.name}: update ready (${update.from} → ${update.to}) — /mcp setup network`;
  const ours = configured.find((definition) => isCaspersEntry(definition, homeDir));
  if (ours) return await installedVersion(homeDir, NETWORK_SERVER) ? undefined : `${ours.name}: not installed — /mcp setup network`;
  if (configured.some((definition) => definition.name === NETWORK_SERVER_NAME || isNetworkServer(definition))) return undefined;
  return `${NETWORK_SERVER_NAME}: not set up — /mcp setup network`;
}

async function ask(host: SetupHost, question: NumberedQuestion): Promise<string | undefined> {
  return host.chooseAnswer(`${question.text}\n${numberedLines(question.choices)}`, "Type 1 or 2: ", ["1", "2"]);
}

function installSpec(host: SetupHost, spec: LockedSpec, swap?: (renames: () => Promise<void>) => Promise<void>) {
  return (host.installer ?? installLockedSpec)(spec, {
    homeDir: host.homeDir, write: (text) => host.write(text), uvMissing: UV_MISSING_NETWORK, ...host.install, ...(swap ? { swap } : {}),
  });
}

/**
 * Installs `version`: a newer release from the lock attached to it on GitHub (checked first), or the bundled pin.
 * A release lock that can't be fetched or fails the check is said plainly, and the bundled pin is installed instead
 * when it is newer than what is there (`from`); otherwise nothing changes (`kept`). A lock that fails the check is
 * remembered like Not now, so that release isn't offered again at start.
 */
async function install(host: SetupHost, version: string, from: string | undefined, swap?: (renames: () => Promise<void>) => Promise<void>): Promise<{ ok: boolean; message: string; version: string; kept?: boolean }> {
  if (version !== NETWORK_SERVER.version) {
    const fetched = await fetchReleaseLock(version, releaseOptions(host.releases));
    if (fetched.ok) return { ...await installSpec(host, releaseSpec(version, fetched.lock), swap), version };
    host.write(`${NETWORK_SERVER.label} ${version} wasn't installed: ${fetched.reason}.\n`);
    // A lock that fails the check stays bad: it isn't offered again at start (/mcp setup network can still retry it).
    if (fetched.failedCheck) await writeSetupState(host.homeDir, { updateNotNow: version }).catch(() => {});
    if (from && !olderThan(from, NETWORK_SERVER.version)) return { ok: false, message: `The network server keeps ${from}.`, version: from, kept: true };
    host.write(`Casper installs the version it ships with, ${NETWORK_SERVER.version}, instead.\n`);
  }
  return { ...await installSpec(host, NETWORK_SERVER, swap), version: NETWORK_SERVER.version };
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
    if (installed && olderThan(installed, await networkUpdateTarget(host.homeDir, installed, host.releases))) {
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
  // No uv: the question says so and 2 installs it first, so the setup never dead-ends.
  const needsUv = !await hasUv(host);
  const target = await networkUpdateTarget(host.homeDir, undefined, host.releases);
  const setupQuestion = needsUv ? networkSetupUvQuestion(host.install?.platform, target) : networkSetupQuestion(target);
  const answer = await ask(host, { ...setupQuestion, text: `${fromReleaseNote(target)}${setupQuestion.text}` });
  if (answer !== "2") {
    // The person's 1, Enter or any other answer is kept, so the offer never nags; nobody answering (closed,
    // cancelled) keeps nothing.
    if (answer !== undefined) await writeSetupState(host.homeDir, { answer: "not-now" });
    if (answer !== undefined) host.write(`${NOT_NOW}\n`);
    return "not-now";
  }
  if (needsUv) {
    host.write("Installing uv…\n");
    let uv: { ok: boolean; message?: string };
    try { uv = await (host.uvInstaller ?? (() => runUvInstaller(host.install?.platform, host.install?.env)))(); }
    catch (error) { uv = { ok: false, message: error instanceof Error ? error.message : String(error) }; }
    if (!uv.ok || !await hasUv(host)) {
      host.write(`uv didn't install${uv.message ? ` (${uv.message})` : ""}. Install it from docs.astral.sh/uv, then type /mcp setup network.\n`);
      return "failed";
    }
  }
  const installed = await install(host, target, undefined);
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
 * When this Casper pins, or a release on GitHub is, a newer version than the one installed: 1 Not now · 2 Update it. On 2 the new version is
 * built beside the old one while it runs; then, once its running calls finish, the server stops, the folders are
 * swapped (the command in ~/.casper/mcp.json, its hash and its remembered approval stay) and it starts again. A swap
 * that fails (Windows keeps a running program's folder locked) puts the old folder back and starts that. Not now is
 * kept per version.
 */
export async function runNetworkUpdate(host: SetupHost, options: { explicit: boolean }): Promise<UpdateResult> {
  const update = await availableUpdate(host.homeDir, await host.configured(), host.releases);
  if (!update) return "current";
  if (!options.explicit && (await readSetupState(host.homeDir)).updateNotNow === update.to) return "not-now";
  if (!host.canAsk()) { host.write(`${CANT_ASK_UPDATE}\n`); return "cant-ask"; }
  const answer = await ask(host, updateQuestion(update.from, update.to));
  if (answer !== "2") {
    if (answer !== undefined) await writeSetupState(host.homeDir, { updateNotNow: update.to });
    if (answer !== undefined) host.write(`Not updated. The network server keeps ${update.from}. Type /mcp setup network to update.\n`);
    return "not-now";
  }
  let swapFailed = false;
  const installed = await install(host, update.to, update.from, (renames) => host.restart(update.name, async () => {
    try { await renames(); } catch (error) { swapFailed = true; throw error; }
  }));
  if (!installed.ok) {
    host.write(swapFailed
      ? `Casper couldn't swap in the new version (its files are in use). The network server keeps ${update.from} and is running again. Close any other Casper window, then type /mcp setup network.\n`
      : installed.kept ? `${installed.message}\n` : `${installed.message}\nThe network server keeps ${update.from}.\n`);
    return "failed";
  }
  host.write(`Network server updated to ${installed.version}.\n`);
  return "updated";
}
