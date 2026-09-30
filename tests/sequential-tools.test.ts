import { expect, test } from "bun:test";
import { browserTool } from "../src/browser/tools";
import type { BrowserSession } from "../src/browser/session";
import { CapabilityBroker } from "../src/capabilities/broker";
import type { LSPManager } from "../src/lsp/manager";
import { lspTools } from "../src/lsp/tools";
import type { MCPManager } from "../src/mcp/manager";
import { askTool } from "../src/tui/ask";
import { WebLookup } from "../src/web/lookup";
import { webTools } from "../src/web/tools";

// Tools that ask the human or drive shared state run one call at a time; read-only tools stay
// parallel, because Pi runs a whole batch in order once any call in it is marked.
test("tools that ask or drive shared state are marked one at a time", () => {
  expect(askTool({ available: () => false, ask: async () => undefined, record: () => {} }).sequential).toBe(true);
  expect(browserTool({} as BrowserSession).sequential).toBe(true);
  const lsp = lspTools({ status: () => [{ state: "ready" }] } as unknown as LSPManager, async () => false);
  expect(lsp.map((tool) => [tool.name, tool.sequential])).toEqual([["lsp", true]]);
  // Web lookups only read and never ask, so they stay parallel.
  const web = webTools(new WebLookup({ provider: { id: "duckduckgo", label: "Fake", search: async () => [] } }));
  expect(web.map((tool) => [tool.name, tool.sequential ?? false])).toEqual([["web_search", false], ["web_fetch", false]]);
});

test("MCP calls that may need approval run one at a time; reads and search stay parallel", async () => {
  const tool = (name: string, readOnly: boolean) => ({ name, inputSchema: { type: "object" }, ...(readOnly ? { annotations: { readOnlyHint: true } } : {}) });
  const manager = {
    catalogRevision: 1,
    prepare: async () => {},
    policy: () => ({ writes: "on", showOptIn: false }),
    status: () => [{ name: "demo" }],
    catalog: () => [{ server: "demo", generation: 1, tools: [tool("list_sites", true), tool("update_site", false)] }],
  } as unknown as MCPManager;
  const tools = await new CapabilityBroker(manager).prepare("list update sites");
  const marked = Object.fromEntries(tools.map((entry) => [entry.name.replace(/_[0-9a-f]{24}$/, ""), entry.sequential ?? false]));
  expect(marked).toEqual({ find_capability: false, call_capability: true, mcp_list_sites: false, mcp_update_site: true });
});
