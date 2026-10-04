import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * A stand-in for casper-network-mcp: its four tools with the same annotations, its `--read-only` flag, its login
 * variables, `{"error": "login_missing", "product": …}` for a product with no login, and access_check v2 with
 * `server_gate: {flag: "--read-only", state}`. Nothing here contacts a vendor API.
 *
 * FAKE_REACH: JSON per product, what the login itself can do ({access, can_change}), reported whether or not
 *   --read-only is set. FAKE_CALLS_FILE: one line per start and per call. FAKE_INVENT_PRODUCT: login_missing
 *   names that product instead.
 */
const readOnly = process.argv.includes("--read-only");
const calls = process.env.FAKE_CALLS_FILE;
const log = (line: string) => { if (calls) appendFileSync(calls, `${line}\n`); };
log(`start ${JSON.stringify(process.argv.slice(2))}`);

const LOGIN: Record<string, string[]> = {
  mist: ["MIST_API_TOKEN"], central: ["CENTRAL_CLIENT_ID", "CENTRAL_CLIENT_SECRET"], clearpass: ["CLEARPASS_API_TOKEN"],
};
const hasLogin = (product: string) => (LOGIN[product] ?? []).every((name) => !!process.env[name]);
const reach = JSON.parse(process.env.FAKE_REACH ?? "{}") as Record<string, Record<string, unknown>>;

const object = (properties: Record<string, object> = {}, required: string[] = []): Tool["inputSchema"] => ({ type: "object", properties, required });
const call = object({ name: { type: "string" }, arguments: { type: "object" } }, ["name"]);
const tools: Tool[] = [
  { name: "find_tool", description: "Find a Mist, Central or ClearPass tool.", inputSchema: object({ query: { type: "string" } }, ["query"]), annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: "invoke_read_tool", description: "Run a read tool.", inputSchema: call, annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: "invoke_tool", description: "Run a change tool.", inputSchema: call, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: "access_check", description: "What each login can do.", inputSchema: object(), annotations: { readOnlyHint: true, destructiveHint: false } },
];

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

function accessCheck() {
  return text({
    contract: "casper/access-check v2",
    products: ["central", "mist", "clearpass"].map((product) => ({
      ...(hasLogin(product) ? { product, access: "unknown", ...reach[product] } : { product, access: "unknown", login: "missing" }),
      server_gate: { flag: "--read-only", state: readOnly ? "off" : "on" },
    })),
  });
}

const server = new Server({ name: "casper-network-mcp", version: "0.0.0-fake" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  log(`call ${request.params.name} ${JSON.stringify(args)}`);
  if (request.params.name === "access_check") return accessCheck();
  if (request.params.name === "find_tool") return text({ hits: JSON.parse(process.env.FAKE_HITS ?? "[]") });
  const name = typeof args.name === "string" ? args.name : "";
  const product = name.split("_")[0]!;
  if (process.env.FAKE_INVENT_PRODUCT) return text({ error: "login_missing", product: process.env.FAKE_INVENT_PRODUCT });
  if (LOGIN[product] && !hasLogin(product)) return text({ error: "login_missing", product });
  if (request.params.name === "invoke_tool" && readOnly) return text({ error: "This server is read-only. Nothing was sent." });
  return text({ ok: true, tool: name });
});
await server.connect(new StdioServerTransport());
