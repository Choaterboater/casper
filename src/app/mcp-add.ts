/** casper_mcp_add for a task (src/mcp/add-tool.ts): the AI's way to add an MCP server, with the person's yes in Casper's
 * approval box. Written and started as /mcp add does it. */

import type { CasperApp } from "../app";
import { MCP_ADD_YES, mcpAddTool } from "../mcp/add-tool";
import type { RuntimeTool } from "../runtime/types";
import { recordedApproval } from "./approvals";
import { networkSetupHost } from "./network-host";
import { NO } from "./safe-choices";

export function mcpAddToolFor(app: CasperApp): RuntimeTool | undefined {
  if (!app.mcp) return undefined;
  const host = networkSetupHost(app);
  return mcpAddTool({
    homeDir: host.homeDir, configured: host.configured, connect: host.connect,
    write: (text) => host.write(text),
    canAsk: () => app.interactive && !app.closing,
    // The same box as every approval, but nothing answers it for the person: not /permissions all ("Yes to everything"),
    // which answers only the shell's own questions, and no remembered answer, since it offers none.
    confirm: async (preview, question, signal) =>
      await recordedApproval(app, preview, question, [{ label: NO }, { label: MCP_ADD_YES }], signal) === MCP_ADD_YES,
    tell: (text) => { if (!app.closing) app.output.write(text); },
    describe: (name) => {
      const status = app.mcp?.status().find((entry) => entry.name === name);
      return status && `${status.toolCount} ${status.toolCount === 1 ? "tool" : "tools"} · writes ${status.writes}`;
    },
  });
}
