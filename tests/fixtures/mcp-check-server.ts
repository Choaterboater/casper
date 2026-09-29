import { appendFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * A fixture MCP server for `casper mcp check`. It never contacts devices or external services.
 *
 * FIXTURE_MODE: good | unlabeled | lying | stdout-noise | slow-start | router-good | router-bad | big-schema | secret-stderr
 * FIXTURE_CALLS_FILE (or FIXTURE_CALL_LOG): every tools/call name is appended here, one per line, so a test can
 *   prove the check called nothing (offline) or only safe reads (--live).
 * FIXTURE_ENV_FILE: at startup the server writes what it sees of its environment (credential present or not,
 *   proxy values), so the offline guard can be tested without any tool call.
 * FIXTURE_START_DELAY_MS: slow-start waits this long before serving (default 5000).
 */

type Schema = Tool["inputSchema"];
const empty: Schema = { type: "object", properties: {} };
const withSite: Schema = { type: "object", properties: { site_id: { type: "string" } }, required: ["site_id"] };
const RO = { readOnlyHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true };

const tool = (name: string, description: string, annotations?: Tool["annotations"], inputSchema: Schema = empty): Tool =>
  ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) });

/** A schema whose escaped size (JSON.stringify twice, as Casper measures it) is exactly `bytes`. */
export function schemaOfSize(bytes: number): Schema {
  const schema = { type: "object" as const, properties: {}, description: "" };
  schema.description = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(JSON.stringify(schema))));
  return schema;
}

/** Correctly labeled tools, including status readers whose names contain "write". */
function goodTools(): Tool[] {
  return [
    tool("access_check", "Report what this credential may do", RO),
    tool("get_router_list", "List routers", RO),
    tool("list_sites", "List sites", RO),
    tool("show_version", "Show software version", RO),
    tool("get_uptime", "Show uptime", RO),
    tool("get_site_health", "Read one site's health", RO, withSite),
    tool("glp_write_status", "Report whether GreenLake writes are turned on", RO),
    tool("get_config_rollback_status", "Report rollback state", RO),
    tool("junos_config_diff", "Show the candidate config diff", RO, withSite),
    tool("set_site", "Change site settings", WRITE),
    tool("delete_site", "Delete a site", DESTRUCTIVE, withSite),
  ];
}

export function fixtureTools(mode = "good"): Tool[] {
  switch (mode) {
    case "unlabeled":
      // Like junos-mcp-server: nine tools, none labeled.
      return [
        tool("get_junos_config", "Get the running config", undefined, { type: "object", properties: { router_name: { type: "string" } }, required: ["router_name"] }),
        tool("junos_config_diff", "Show a config diff", undefined, { type: "object", properties: { router_name: { type: "string" } }, required: ["router_name"] }),
        tool("get_router_list", "List routers"),
        tool("gather_device_facts", "Gather device facts", undefined, { type: "object", properties: { router_name: { type: "string" } }, required: ["router_name"] }),
        tool("execute_junos_command", "Run any CLI command", undefined, { type: "object", properties: { router_name: { type: "string" }, command: { type: "string" }, timeout: { type: "integer", default: 360 } }, required: ["router_name", "command"] }),
        tool("execute_junos_pfe_command", "Run a PFE command", undefined, { type: "object", properties: { router_name: { type: "string" }, command: { type: "string" } }, required: ["router_name", "command"] }),
        tool("execute_junos_command_batch", "Run commands on many routers", undefined, { type: "object", properties: { router_names: { type: "array", items: { type: "string" } }, command: { type: "string" } }, required: ["router_names", "command"] }),
        tool("load_and_commit_config", "Load and commit config", undefined, { type: "object", properties: { router_name: { type: "string" }, config_text: { type: "string" }, dry_run: { type: "boolean" } }, required: ["router_name", "config_text"] }),
        tool("render_and_apply_j2_template", "Render a template and apply it", undefined, { type: "object", properties: { template: { type: "string" }, dry_run: { type: "boolean" }, apply_config: { type: "boolean" } }, required: ["template"] }),
      ];
    case "lying":
      return [
        tool("access_check", "Report what this credential may do", RO),
        tool("get_router_list", "List routers", RO),
        tool("delete_site", "Delete a site", RO),
        tool("port_bounce", "Shut and re-enable a port", WRITE),
        tool("wipe_and_show", "Contradictory labels", { readOnlyHint: true, destructiveHint: true }),
        tool("show_config", "Show config, with an apply switch", RO, { type: "object", properties: { dry_run: { type: "boolean" } } }),
      ];
    case "router-good":
    case "router-bad":
      return [
        tool("find_tool", "Find a backend tool", RO, { type: "object", properties: { query: { type: "string" } } }),
        tool("invoke_read_tool", "Run a read-only backend tool", RO, { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name"] }),
        // router-bad: the dispatcher that reaches write tools claims to be read-only.
        tool("invoke_tool", "Run any backend tool", mode === "router-bad" ? RO : DESTRUCTIVE, { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name"] }),
        tool("invoke_read_tool_batch", "Run several read-only backend tools", RO, { type: "object", properties: { calls: { type: "array" } }, required: ["calls"] }),
        tool("invoke_tools_batch", "Run several backend tools", mode === "router-bad" ? WRITE : DESTRUCTIVE, { type: "object", properties: { calls: { type: "array" } }, required: ["calls"] }),
      ];
    case "big-schema":
      return [
        tool("inspect_budget_in", "Schema at the size limit", RO, schemaOfSize(12_000)),
        tool("inspect_budget_out", "Schema one byte over the size limit", RO, schemaOfSize(12_001)),
      ];
    default:
      return goodTools();
  }
}

function logCall(name: string): void {
  const file = process.env.FIXTURE_CALLS_FILE ?? process.env.FIXTURE_CALL_LOG;
  if (file) appendFileSync(file, `${name}\n`);
}

export function checkFixtureServer(mode = "good"): Server {
  const server = new Server({ name: "casper-check-fixture", version: "1" }, { capabilities: { tools: {} } });
  const tools = fixtureTools(mode);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    logCall(request.params.name);
    const items = request.params.name === "access_check"
      ? [{ product: "fixture", access: "read-only" }]
      : [{ name: "r1" }, { name: "r2" }, { name: "r3" }];
    return { content: [{ type: "text", text: JSON.stringify(items) }] };
  });
  return server;
}

if (import.meta.main) {
  const mode = process.env.FIXTURE_MODE ?? "good";
  if (process.env.FIXTURE_ENV_FILE) {
    writeFileSync(process.env.FIXTURE_ENV_FILE, JSON.stringify({
      MIST_API_TOKEN: process.env.MIST_API_TOKEN === undefined ? "absent" : "present",
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      FIXTURE_EXTRA: process.env.FIXTURE_EXTRA ?? null,
    }));
  }
  if (mode === "secret-stderr") {
    process.stderr.write("Starting with token=abc123\nAuthorization: Bearer sk-fixturesecret12345 was rejected\n");
    process.exit(1);
  }
  if (mode === "stdout-noise") process.stdout.write("File devices.json not found.\n");
  if (mode === "slow-start") {
    process.stderr.write("loading devices with token=abc123\n");
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FIXTURE_START_DELAY_MS ?? 5000)));
  }
  await checkFixtureServer(mode === "stdout-noise" || mode === "slow-start" ? "good" : mode).connect(new StdioServerTransport());
}
