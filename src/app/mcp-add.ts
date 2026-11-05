/** casper_mcp_add and casper_mcp_remove for a task (src/mcp/add-tool.ts, src/mcp/edit.ts): the AI's way to add, change
 * or remove an MCP server, with the person's yes in Casper's approval box. Written and started as /mcp add,
 * /mcp update and /mcp remove do it. */

import type { CasperApp } from "../app";
import { MCP_ADD_YES, mcpAddTool } from "../mcp/add-tool";
import { mcpRemoveTool, type McpEditToolHost } from "../mcp/edit";
import type { RuntimeTool } from "../runtime/types";
import { recordedApproval, someoneAnswers } from "./approvals";
import { networkLoginHost, networkSetupHost } from "./network-host";
import { NO, YES_ONCE, YES_SESSION } from "./safe-choices";

function describe(app: CasperApp, name: string): string | undefined {
  const status = app.mcp?.status().find((entry) => entry.name === name);
  return status && `${status.toolCount} ${status.toolCount === 1 ? "tool" : "tools"} · writes ${status.writes}`;
}

/** The host for changing or removing a server's entry: the box offers "Yes, for this session" (decision 71); a server's
 * new entry is still never added without its own box. */
function editHost(app: CasperApp): McpEditToolHost {
  const host = networkSetupHost(app);
  return {
    homeDir: host.homeDir, configured: host.configured, connect: host.connect,
    write: (text) => host.write(text),
    privateInput: (label) => networkLoginHost(app).privateInput(label),
    restart: (name) => host.restart(name),
    reload: async () => { if (app.mcp && app.reloadMCPConfiguration) await app.mcp.reload(await app.reloadMCPConfiguration()); },
    forgetConsent: async (name) => { await app.mcp?.forget(name); },
    canAsk: () => someoneAnswers(app) && !app.closing,
    approveEdit: async (preview, question, signal) => {
      if (app.mcpEditsAllowed) {
        if (!app.closing) app.output.write(`[approval] allowed (this session): ${question.replace(/\?$/, "")}\n`);
        return true;
      }
      // Nothing answers it for the person: not /permissions all or "Yes to everything", which answer other questions.
      const answer = await recordedApproval(app, preview, question, [{ label: NO }, { label: YES_ONCE }, { label: YES_SESSION }], signal);
      if (answer === YES_SESSION) app.mcpEditsAllowed = true;
      return answer === YES_ONCE || answer === YES_SESSION;
    },
    tell: (text) => { if (!app.closing) app.output.write(text); },
    describe: (name) => describe(app, name),
  };
}

export function mcpAddToolFor(app: CasperApp): RuntimeTool | undefined {
  if (!app.mcp) return undefined;
  const host = networkSetupHost(app);
  return mcpAddTool({
    homeDir: host.homeDir, configured: host.configured,
    connect: async (name) => {
      const connected = await host.connect(name);
      app.mcpAddedThisSession.add(name);
      return connected;
    },
    write: (text) => host.write(text),
    privateInput: (label) => networkLoginHost(app).privateInput(label),
    canAsk: () => someoneAnswers(app) && !app.closing,
    // The same box as every approval, but nothing answers it for the person: not /permissions all ("Yes to everything"),
    // which answers only the shell's own questions, and no remembered answer, since it offers none.
    confirm: async (preview, question, signal) =>
      await recordedApproval(app, preview, question, [{ label: NO }, { label: MCP_ADD_YES }], signal) === MCP_ADD_YES,
    tell: (text) => { if (!app.closing) app.output.write(text); },
    describe: (name) => describe(app, name),
    editor: editHost(app),
  });
}

export function mcpRemoveToolFor(app: CasperApp): RuntimeTool | undefined {
  return app.mcp ? mcpRemoveTool(editHost(app)) : undefined;
}
