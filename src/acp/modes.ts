// The access an ACP app's chip sets (decision 82): Read only, Ask first (Casper's usual boxes) and Don't ask (as
// /permissions all). Sent as ACP session modes and as the `mode` config option, so a client that knows either one can
// show and set it. Only the app's pick of the mode sets Read only; Casper's own switch (/permissions all, "Yes to
// everything this session") moves the mode it reports, never the other way round.

import type { CasperApp } from "../app";
import { RpcFailure, RPC, type Json } from "./rpc";

export type AccessModeId = "read" | "ask" | "full";

export interface AccessMode { id: AccessModeId; name: string; description: string }

/** The three modes, in the chip's order. */
export const ACCESS_MODES: readonly AccessMode[] = [
  { id: "read", name: "Read only", description: "Casper looks and answers. It blocks every change it can see: only reads, look commands and MCP reads run." },
  { id: "ask", name: "Ask first", description: "Casper's usual boxes: it asks before a command that changes things, a write outside the project, a new host or another machine." },
  { id: "full", name: "Don't ask", description: "Like /permissions all: commands, hosts, writes outside the project and other machines are Yes. The app's own tools ask in Casper's box; MCP changes, risky kinds, protected places and secrets keep their boxes." },
];

/** `acp_access: off` in ~/.casper/config.yaml: the app may set Read only or Ask first, never Don't ask. */
export const FULL_REFUSED = "Casper's acp_access setting is off, so an app can't turn its asking off. Pick Read only or Ask first, or type /permissions all in the chat.";

/** The parts of the app the access reads and sets. */
export type AccessHost = Pick<CasperApp, "readOnlyAccess" | "stopAsking" | "clientAccess" | "projectContext"> & { updateFooter?(): void };

/** The mode the app is in now: Read only first (it holds whatever else is set), then Casper's /permissions all. */
export function accessModeOf(app: Pick<CasperApp, "readOnlyAccess" | "stopAsking">): AccessModeId {
  return app.readOnlyAccess ? "read" : app.stopAsking ? "full" : "ask";
}

/** Whether the app may set Don't ask (acp_access, on by default). */
export function fullOffered(app: Pick<CasperApp, "projectContext">): boolean {
  return app.projectContext?.acpAccess !== "off";
}

/** The modes this session offers: all three, or Read only and Ask first with acp_access off. The mode in use stays
 * listed (a typed /permissions all with acp_access off). */
export function offeredModes(app: Pick<CasperApp, "projectContext" | "readOnlyAccess" | "stopAsking">): AccessMode[] {
  const current = accessModeOf(app);
  return ACCESS_MODES.filter((mode) => mode.id !== "full" || fullOffered(app) || current === "full");
}

/** ACP's `modes` object for a session/new or session/load reply. */
export function modeState(app: Pick<CasperApp, "projectContext" | "readOnlyAccess" | "stopAsking">, hide: (text: string) => string): Json {
  return { currentModeId: accessModeOf(app), availableModes: offeredModes(app).map((mode) => ({ id: mode.id, name: hide(mode.name), description: hide(mode.description) })) };
}

/** The `mode` config option, last in the list. */
export function modeOption(app: Pick<CasperApp, "projectContext" | "readOnlyAccess" | "stopAsking">, hide: (text: string) => string): Json {
  return { id: "mode", name: "Access", category: "mode", type: "select", currentValue: accessModeOf(app),
    options: offeredModes(app).map((mode) => ({ value: mode.id, name: hide(mode.name), description: hide(mode.description) })) };
}

/** Plain words for a mode the app set, on Casper's transcript (stderr). */
const SET_WORDS: Record<AccessModeId, string> = {
  read: "Read only: Casper looks and answers, and blocks every change it can see.",
  ask: "Ask first: Casper's usual boxes.",
  full: "Don't ask: shell commands, hosts, writes outside the project and other machines are answered Yes for this session. The app's own tools, MCP changes, risky kinds, protected places and secrets keep their boxes.",
};

/**
 * Sets the mode the app picked: Read only and /permissions all's switch, and which box the app's own servers use. A
 * refused request changes nothing. Returns the mode before.
 */
export function setAccessMode(app: AccessHost, id: unknown, write: (text: string) => void): AccessModeId {
  if (typeof id !== "string") throw new RpcFailure(RPC.invalidParams, "mode takes one of its listed values");
  if (!ACCESS_MODES.some((mode) => mode.id === id)) throw new RpcFailure(RPC.invalidParams, `Unknown mode: ${id} (read, ask, full)`);
  const mode = id as AccessModeId;
  if (mode === "full" && !fullOffered(app)) throw new RpcFailure(RPC.invalidParams, FULL_REFUSED);
  const before = accessModeOf(app);
  app.readOnlyAccess = mode === "read";
  app.stopAsking = mode === "full";
  app.clientAccess = mode;
  app.updateFooter?.();
  if (before !== mode) write(`[permissions] The app set ${SET_WORDS[mode]}\n`);
  return before;
}

/** The options the client was told (`told`, as JSON) after a session/set_mode, whose empty reply tells it only the
 * mode: `told` with its mode option as `now` has it, so a model or effort change Casper made and has not sent yet still
 * differs from `now` and goes at the next update. */
export function withModeTold(told: string, now: readonly Json[]): string {
  const mode = now.find((option) => option.id === "mode");
  const before = told ? JSON.parse(told) as Json[] : [];
  return JSON.stringify(mode ? before.map((option) => option.id === "mode" ? mode : option) : before);
}
