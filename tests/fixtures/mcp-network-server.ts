import { appendFileSync } from "node:fs";
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
    // hpe-networking-mcp router with the rag toolset: its docs tools sit next to the router tools.
    case "hpe-docs": return [
      read("find_tool"), read("invoke_read_tool"),
      { ...plain("invoke_tool"), annotations: { readOnlyHint: false, destructiveHint: true } },
      read("search_docs", { type: "object", properties: { query: { type: "string" } } }),
      read("lookup_api", { type: "object", properties: { query: { type: "string" } } }),
      read("ask_docs", { type: "object", properties: { question: { type: "string" } } }),
      ...Array.from({ length: 20 }, (_, i) => read(`configure_vlan_uplink_helper_${i}`)),
    ];
    // A server that returns device configs with secrets in them (like get_device_running_config).
    case "config": return [
      read("get_running_config"), read("get_ssid"),
      { ...plain("set_config", { type: "object", properties: { lines: { type: "string" } }, required: ["lines"] }), annotations: { readOnlyHint: false } },
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
    case "access-wrong-contract": return text({ contract: "casper/access-check v9", products: [product("central", "read-only")] });
    default: return text("not json {");
  }
}

/** A made-up AOS-CX / AOS 8 config with secrets in it. None of these values are real. */
export const RUNNING_CONFIG = [
  "hostname sw1",
  "interface 1/1/1",
  "user admin group administrators password ciphertext AQBapFixtureCipher",
  "radius-server host 10.0.0.5 key plaintext RadKeyCX",
  "snmp-server community FixtureComm",
  "wlan ssid-profile corp",
  "  wpa-passphrase SuperPSK123",
].join("\n");

/** FIXTURE_ENV_DUMP=1 adds get_env: the argv and the HPE_MCP_/CENTRALMCP_/CLEARPASS_ env it was started with. */
function envDump() {
  const prefixes = ["HPE_MCP_", "CENTRALMCP_", "CLEARPASS_"];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => prefixes.some((prefix) => key.startsWith(prefix))));
  return { content: [{ type: "text" as const, text: JSON.stringify({ argv: process.argv.slice(2), env }) }] };
}

export function networkFixtureServer(mode = "access-ro") {
  const server = new Server({ name: "casper-network-fixture", version: "1" }, { capabilities: { tools: {} } });
  const tools = catalog(mode);
  if (process.env.FIXTURE_ENV_DUMP === "1") tools.push(read("get_env"));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // FIXTURE_CALLS_FILE: one line per call, so tests can count what reached the server.
    if (process.env.FIXTURE_CALLS_FILE) appendFileSync(process.env.FIXTURE_CALLS_FILE, `${request.params.name} ${JSON.stringify(request.params.arguments ?? {})}\n`);
    if (request.params.name === "get_env") return envDump();
    if (request.params.name === "get_running_config") return { content: [{ type: "text" as const, text: JSON.stringify({ config: RUNNING_CONFIG, next_cursor: "c1", _pagination: { list_key: "items" } }) }] };
    if (request.params.name === "get_ssid") return { content: [{ type: "text" as const, text: JSON.stringify({ ssid: "corp", psk: "FixturePsk-77", token: "hpe_mcp_secret_0123456789abcdef0123456789abcdef" }) }] };
    if (request.params.name === "access_check") {
      // access-slow never answers in time.
      if (mode === "access-slow") await new Promise((resolve) => setTimeout(resolve, 30_000));
      return accessResult(mode);
    }
    return { content: [{ type: "text", text: `called ${request.params.name}` }] };
  });
  return server;
}

if (import.meta.main) await networkFixtureServer(process.env.FIXTURE_MODE).connect(new StdioServerTransport());
