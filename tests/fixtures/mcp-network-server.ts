import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Network-server look-alikes for presets and access_check. Tool names match the real servers
 * (hpe-networking-mcp router, Juniper junos-mcp-server, a Karthik-style Central server); nothing
 * here contacts a device or a vendor API. FIXTURE_MODE picks the catalog.
 */
const empty = { type: "object" as const, properties: {} };
const command = { type: "object" as const, properties: { router_name: { type: "string" }, command: { type: "string" } }, required: ["router_name", "command"] };
const read = (name: string, inputSchema: Tool["inputSchema"] = empty): Tool => ({ name, description: name, inputSchema, annotations: { readOnlyHint: true, destructiveHint: false } });
const plain = (name: string, inputSchema: Tool["inputSchema"] = empty): Tool => ({ name, description: name, inputSchema });

function catalog(mode: string): Tool[] {
  switch (mode) {
    case "junos": return [
      plain("execute_junos_command", command),
      plain("execute_junos_pfe_command", command),
      plain("execute_junos_command_batch", { type: "object", properties: { router_names: { type: "array" }, command: { type: "string" } } }),
      plain("get_junos_config"), plain("junos_config_diff"), plain("render_and_apply_j2_template"),
      plain("gather_device_facts"), plain("get_router_list"), plain("load_and_commit_config"),
    ];
    case "hpe-router": return [
      read("find_tool"), read("invoke_read_tool"), read("plan_tool_workflow"),
      { ...plain("invoke_tool"), annotations: { readOnlyHint: false, destructiveHint: true } },
      { ...plain("invoke_tools_batch"), annotations: { readOnlyHint: false, destructiveHint: true } },
    ];
    case "karthik-like": return [
      read("get_devices"), read("get_sites"),
      { ...plain("update_site_name"), annotations: { readOnlyHint: false } },
      plain("assign_device_group"),
    ];
    case "access-args": return [{ ...read("access_check"), inputSchema: { type: "object", properties: { who: { type: "string" } }, required: ["who"] } }];
    case "access-unannotated": return [plain("access_check")];
    default: return [read("access_check"), read("get_status"), { ...plain("set_config"), annotations: { readOnlyHint: false } }];
  }
}

function accessResult(mode: string) {
  const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
  const product = (name: string, access: string) => ({
    product: name, access, identity: "svc-casper@example.net", role: "Observer",
    server_gate: { env_var: `HPE_MCP_${name.toUpperCase()}_WRITES`, state: "disabled" },
  });
  switch (mode) {
    case "access-ro": return text({ contract: "casper/access-check v1", products: [product("central", "read-only"), product("mist", "read-only")] });
    case "access-rw": return text({ contract: "casper/access-check v1", products: [product("central", "read-write")] });
    case "access-mixed": return text({ contract: "casper/access-check v1", products: [product("central", "read-only"), product("clearpass", "unknown")] });
    case "access-structured": return { content: [], structuredContent: { contract: "casper/access-check v1", products: [product("central", "read-only")] } };
    case "access-error": return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ contract: "casper/access-check v1", products: [product("central", "read-only")] }) }] };
    case "access-wrong-contract": return text({ contract: "casper/access-check v2", products: [product("central", "read-only")] });
    default: return text("not json {");
  }
}

export function networkFixtureServer(mode = "access-ro") {
  const server = new Server({ name: "casper-network-fixture", version: "1" }, { capabilities: { tools: {} } });
  const tools = catalog(mode);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "access_check") return accessResult(mode);
    return { content: [{ type: "text", text: `called ${request.params.name}` }] };
  });
  return server;
}

if (import.meta.main) await networkFixtureServer(process.env.FIXTURE_MODE).connect(new StdioServerTransport());
