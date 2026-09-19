import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

const empty = { type: "object" as const, properties: {}, additionalProperties: false };
const site = { type: "object" as const, properties: { site: { type: "string" } }, required: ["site"], additionalProperties: false };
const read = (name: string, description: string, inputSchema: Tool["inputSchema"] = empty): Tool => ({ name, description, inputSchema, annotations: { readOnlyHint: true } });

/** Synthetic HPE-shaped catalogs. Never contacts devices or external services. */
export function fixtureServer(mode = "generic") {
  const server = new Server({ name: "casper-fixture", version: "1" }, { capabilities: { tools: { listChanged: true } } });
  let tools: Tool[] = mode === "router" ? [
    read("find_tool", "Find a backend networking tool and optionally its schema", {
      type: "object", properties: { query: { type: "string" }, include_schema: { type: "boolean" } }, additionalProperties: false,
    }),
    read("invoke_read_tool", "Dispatch a read-only backend networking tool", {
      type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name"], additionalProperties: false,
    }),
    // Deliberately contradictory hint: Casper must still treat generic dispatch as consequential.
    read("invoke_tool", "Dispatch any backend tool"),
    ...Array.from({ length: 337 }, (_, i) => read(`wrapper_${i}`, "networking health wrapper")),
  ] : [
    ...Array.from({ length: 330 }, (_, i) => read(`get_site_metric_${i}`, "Read site health metric")),
    read("inspect_quantum_flux", "Inspect rare quantum flux counter", mode === "schema-arrays" ? {
      ...site, properties: { site: { type: "string", enum: Array.from({ length: 80 }, (_, i) => `site-${i}`) } },
    } : site),
    { name: "set_site", description: "Change site configuration", inputSchema: site, annotations: { readOnlyHint: false, destructiveHint: false } },
    { name: "mystery", description: "Claims to be safe read-only in prose", inputSchema: empty },
    read("fixture_refresh", "Change fixture catalog"),
    read("slow_read", "Wait for cancellation"),
    read("large_read", "Read a large collection"),
    read("error_read", "Return a protocol tool error"),
    read("crash_read", "Close fixture transport"),
    read("status", "Read fixture identity"),
    read("env_read", "Read explicitly provided fixture variable"),
  ];
  if (mode === "schema-budget") {
    const schemaAt = (bytes: number): Tool["inputSchema"] => {
      const schema = { ...empty, description: '"'.repeat(2000) };
      schema.description += "x".repeat(bytes - Buffer.byteLength(JSON.stringify(JSON.stringify(schema))));
      return schema;
    };
    tools = [
      read("inspect_budget_in", "Schema budget boundary", schemaAt(12_000)),
      read("inspect_budget_out", "Schema budget boundary", schemaAt(12_001)),
    ];
  }
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const offset = Number(request.params?.cursor ?? 0);
    return { tools: tools.slice(offset, offset + 100), ...(offset + 100 < tools.length ? { nextCursor: String(offset + 100) } : {}) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    if (name === "slow_read") await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 60_000);
      extra.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (name === "crash_read") { await server.close(); return { content: [] }; }
    if (name === "fixture_refresh") {
      tools = [
        ...tools.filter((tool) => tool.name !== "status").map((tool) => {
          if (mode === "schema-change" && tool.name === "inspect_quantum_flux") {
            return { ...tool, inputSchema: { ...site, properties: { site: { type: "integer" } } }, annotations: { readOnlyHint: false } };
          }
          return tool.name === "set_site" ? { ...tool, description: "Changed site configuration tool" } : tool;
        }),
        read("late_read", "Late arrival after notification"),
      ];
      await server.notification({ method: "notifications/tools/list_changed" });
    }
    let value: unknown = { tool: name, arguments: args ?? {}, identity: process.env.FIXTURE_ID ?? mode, pid: process.pid };
    if (name === "find_tool") value = [{ name: "inspect_quantum_flux", capability: "read", recommended_dispatcher: "invoke_read_tool", ...(args?.include_schema ? { inputSchema: site } : {}) }];
    if (name === "invoke_read_tool") value = { counter: 42, tool: args?.name };
    if (name === "env_read") value = { supplied: process.env.FIXTURE_VALUE ?? "absent" };
    if (name === "large_read") value = { items: Array.from({ length: 2000 }, (_, i) => ({ i, text: "👻".repeat(1000) })), next_cursor: "provider-read-cursor" };
    if (name === "error_read") return { isError: true, content: [{ type: "text", text: "Fixture rejected the read" }] };
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  });
  return server;
}

if (import.meta.main) {
  if (process.env.FIXTURE_MODE === "stall") {
    process.stdin.resume();
  } else {
    if (process.env.FIXTURE_MODE === "stubborn") {
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 60_000);
    }
    await fixtureServer(process.env.FIXTURE_MODE).connect(new StdioServerTransport());
  }
}
