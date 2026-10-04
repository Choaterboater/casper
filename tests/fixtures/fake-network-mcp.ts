import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * A stand-in for casper-network-mcp: its four tools with the same annotations, its `--read-only` flag, its login
 * variables, `{"error": "login_missing", "product": …}` for a product with no login, and access_check v2 with
 * `server_gate: {flag: "--read-only", state}`. Nothing here contacts a vendor API.
 *
 * FAKE_INVOKE_DESTRUCTIVE=1: invoke_tool is annotated destructiveHint: true.
 * FAKE_REACH: JSON per product, what the login itself can do ({access, can_change}), reported whether or not
 *   --read-only is set. FAKE_CALLS_FILE: one line per start and per call. FAKE_INVENT_PRODUCT: login_missing
 *   names that product instead. FAKE_HITS: find_tool's hits ([{name, product, summary, kind, label}]), sent the way
 *   the real server's SDK sends a list: one text block per hit, and structuredContent {result: hits}.
 * Like the real server's gate, --read-only refuses changes but lets the listed troubleshooting tools through
 *   (FAKE_TROUBLESHOOT: comma-separated names; default cx_show, cx_ping).
 * FAKE_EXPIRED, FAKE_401: see below.
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
  { name: "invoke_tool", description: "Run a change tool.", inputSchema: call, annotations: { readOnlyHint: false, destructiveHint: process.env.FAKE_INVOKE_DESTRUCTIVE === "1" } },
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

let findCalls = 0;
const server = new Server({ name: "casper-network-mcp", version: "0.0.0-fake" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  log(`call ${request.params.name} ${JSON.stringify(args)}`);
  if (request.params.name === "access_check") return accessCheck();
  if (request.params.name === "find_tool") {
    // FAKE_HITS_LATER: what every find_tool after the first finds instead.
    const later = findCalls++ > 0 && process.env.FAKE_HITS_LATER;
    const hits = JSON.parse((later || process.env.FAKE_HITS) ?? "[]") as unknown[];
    return { content: hits.map((hit) => ({ type: "text" as const, text: JSON.stringify(hit) })), structuredContent: { result: hits } };
  }
  const name = typeof args.name === "string" ? args.name : "";
  const product = name.split("_")[0]!;
  if (process.env.FAKE_INVENT_PRODUCT) return text({ error: "login_missing", product: process.env.FAKE_INVENT_PRODUCT });
  if (LOGIN[product] && !hasLogin(product)) return text({ error: "login_missing", product });
  // FAKE_EXPIRED / FAKE_401: comma-separated products whose saved login the product no longer takes, answered the
  // newer way ({"error": "login_expired"}) or the 0.1.0 way (the product's own HTTP 401 passed through).
  if ((process.env.FAKE_EXPIRED ?? "").split(",").includes(product)) return text({ error: "login_expired", product });
  if ((process.env.FAKE_401 ?? "").split(",").includes(product)) return text({ error: `HTTP 401 at /api/${product}: {"error":"invalid_token"}` });
  const troubleshooting = (process.env.FAKE_TROUBLESHOOT ?? "cx_show,cx_ping").split(",");
  if (request.params.name === "invoke_tool" && readOnly && !troubleshooting.includes(name)) return text({ error: "This server is read-only. Nothing was sent." });
  return text({ ok: true, tool: name });
});
await server.connect(new StdioServerTransport());
