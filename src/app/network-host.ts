/** Casper's network server from the app: the setup and login hosts (questions only a person answers, in the approval
 * queue), the offer before a request that names a network product, and ctrl+o (writes off everywhere). Moved from src/app.ts. */

import type { CasperApp } from "../app";
import os from "node:os";
import { terminalText } from "../tui/format";
import type { LoginHost } from "../mcp/network/ask-login";
import { loginFile } from "../mcp/network/logins";
import { withLoginDisplay } from "../tui/login";
import { namesNetworkProduct, runNetworkSetup, runNetworkUpdate, shouldOfferNetworkSetup, shouldOfferNetworkUpdate, type SetupHost } from "../mcp/network/setup";
import { oneAtATime, chooseAnswer, chooseNumbered } from "./approvals";
import { updateFooter } from "./footer";

/**
 * The network server's setup host: questions in the numbered approval box (only the person, never the AI's ask tool),
 * and connecting goes through the same manager as /mcp connect.
 */
export function networkSetupHost(app: CasperApp): SetupHost {
  const home = app.sessionHomeDir ?? os.homedir();
  return {
    homeDir: home,
    // The approval box works wherever approvals do (it refuses a cooked terminal itself).
    canAsk: () => app.interactive && !app.closing,
    chooseAnswer: (preview, question, choices) => chooseAnswer(app, preview, question, choices, app.commandAbort?.signal),
    write: (text) => { if (!app.closing) app.output.write(text); },
    configured: async () => app.mcp ? app.mcp.status().map((status) => app.mcp!.definition(status.name)) : [],
    connect: async (name) => {
      if (!app.mcp || !app.reloadMCPConfiguration) return { ok: false, message: "MCP is not available in this session" };
      await app.mcp.reload(await app.reloadMCPConfiguration());
      await app.mcp.connect(name);
      const status = app.mcp.status().find((entry) => entry.name === name);
      if (status?.state !== "ready") return { ok: false, ...(status?.error ? { message: status.error } : {}) };
      const remembered = await app.mcp.remember(name);
      if (!remembered.remembered) app.output.write(`[mcp] ${terminalText(remembered.reason)}\n`);
      updateFooter(app);
      return { ok: true };
    },
    restart: async (name, whileStopped) => {
      if (app.mcp) await app.mcp.restartAfterCalls(name, whileStopped ? { whileStopped } : {});
      else await whileStopped?.();
    },
    ...(app.networkSeams?.install ? { install: app.networkSeams.install } : {}),
  };
}

/** Before the AI's turn: an update to Casper's network server (asked once a session), and setup on the first request
 * that names a network product. Interactive only; the AI never starts either. */
export async function offerNetworkServer(app: CasperApp, prompt: string): Promise<void> {
  if (!app.interactive || app.closing || !app.mcp) return;
  if (app.networkUpdateAsked && (app.networkSetupOffered || !namesNetworkProduct(prompt))) return;
  const host = networkSetupHost(app);
  const configured = await host.configured();
  if (!app.networkUpdateAsked) {
    app.networkUpdateAsked = true;
    if (await shouldOfferNetworkUpdate(host.homeDir, configured)) await runNetworkUpdate(host, { explicit: false });
  }
  if (app.networkSetupOffered || !namesNetworkProduct(prompt) || app.closing) return;
  if (!await shouldOfferNetworkSetup(host.homeDir, configured)) return;
  app.networkSetupOffered = true;
  await runNetworkSetup(host, { explicit: false });
}

/**
 * The network server's login host: the question in the numbered approval box and the values in the private prompt (only the
 * person, never the AI's ask tool), both in the approval queue; the restart after a save goes through the manager.
 */
export function networkLoginHost(app: CasperApp): LoginHost {
  return {
    homeDir: app.sessionHomeDir ?? os.homedir(),
    interactive: app.interactive,
    notNow: app.loginNotNow,
    // The private prompt needs Casper's full terminal (piped input has no way to hide what you type).
    canAsk: () => app.interactive && !app.closing && !!app.terminal.exclusiveHost(),
    chooseAnswer: (preview, question, choices) => chooseNumbered(app, preview, question, choices, app.commandAbort?.signal),
    privateInput: async (label) => {
      const picker = app.terminal.exclusiveHost();
      if (!picker || app.closing) return undefined;
      const signal = app.commandAbort?.signal ?? new AbortController().signal;
      return picker.run((io) => withLoginDisplay(io, signal, (display) => display.privateInput(label))).catch(() => undefined);
    },
    write: (text) => { if (!app.closing) app.output.write(text); },
    restart: async (name) => { await app.mcp?.restartAfterCalls(name); },
    access: (name) => { try { return app.mcp?.policy(name).access; } catch { return undefined; } },
    exclusive: (work) => oneAtATime(app, work),
  };
}

/** ~/.casper/network-logins.json: its tokens are hidden in every tool output the AI reads. */
export function networkLoginFile(app: CasperApp): string {
  return loginFile(app.sessionHomeDir ?? os.homedir());
}

/** ctrl+o: writes off for every server at once, and every allowed kind and session answer ended. Returns whether
 * any of those were in force. */
export function revertWrites(app: CasperApp): boolean {
  if (app.closing) return false;
  const ended = app.endAllowances();
  const on = app.mcp?.writesOn() ?? [];
  if (ended && !on.length) {
    app.output.write("[mcp] Allowed change kinds ended. Every change asks you again.\n");
    updateFooter(app);
  }
  if (!on.length) return ended;
  // The gate flips at once; servers restart with their pins once their running calls finish.
  for (const server of on) void app.mcp!.setWrites(server, false).catch(() => {});
  for (const server of on) app.output.write(`[mcp] Writes off for ${server}. Every change asks you again.\n`);
  updateFooter(app);
  return true;
}

/** Once per new set of imported servers: say where they were found. Interactive sessions only. */
export async function reportImports(app: CasperApp): Promise<void> {
  const imported = app.mcp?.status().filter((status) => status.importedFrom && status.scope === "imported") ?? [];
  const names = imported.map((status) => status.name);
  if (!app.mcpConsent?.importSetIsNew(names)) return;
  const places = [...new Set(imported.map((status) => (status.importedFrom ?? "").replace(/ \(this project\)$/, "")))];
  const where = places.length > 1 ? `${places.slice(0, -1).join(", ")} and ${places.at(-1)}` : places[0];
  app.output.write(`[mcp] Found ${names.length} server${names.length === 1 ? "" : "s"} in ${where}. Run /mcp to see them.\n`);
  await app.mcpConsent.markImportSet(names).catch(() => {});
}
