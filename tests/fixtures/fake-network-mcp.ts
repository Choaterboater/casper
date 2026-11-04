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
 * FAKE_SLOW_MS, a call's login: see below. FAKE_EXPIRED, FAKE_401: see below. FAKE_RESULTS: JSON by tool name, the result a routed call to that tool answers
 *   (one text block of its JSON, or the text itself when it is a string).
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

/** Each named Central login it started with (CENTRAL_<NAME>_CLIENT_ID), reported the way casper-network-mcp 0.1.6+ does. */
const named = Object.keys(process.env).map((key) => /^CENTRAL_([A-Z0-9]{1,32})_CLIENT_ID$/.exec(key)?.[1]).filter((name): name is string => !!name)
  .map((name) => ({ name: name.toLowerCase(), login: "set" }));

function accessCheck() {
  return text({
    contract: "casper/access-check v2",
    products: ["central", "mist", "clearpass"].map((product) => ({
      ...(hasLogin(product) ? { product, access: "unknown", ...reach[product] } : { product, access: "unknown", login: "missing" }),
      server_gate: { flag: "--read-only", state: readOnly ? "off" : "on" },
      ...(product === "central" && named.length ? { named_logins: named } : {}),
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
  // FAKE_SLOW_MS: a routed call answers after this long (a call still running when something else happens).
  if (process.env.FAKE_SLOW_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_SLOW_MS)));
  // A call with login: <name> answers with that named Central login's client id, as the server was started with it.
  if (typeof args.login === "string") {
    const id = process.env[`CENTRAL_${args.login.toUpperCase()}_CLIENT_ID`];
    return text(id ? { ok: true, tool: name, login: args.login, client: id } : { error: `No Central login named '${args.login}'.`, status: "unknown_login" });
  }
  if (process.env.FAKE_INVENT_PRODUCT) return text({ error: "login_missing", product: process.env.FAKE_INVENT_PRODUCT });
  if (LOGIN[product] && !hasLogin(product)) return text({ error: "login_missing", product });
  // FAKE_EXPIRED / FAKE_401: comma-separated products whose saved login the product no longer takes, answered the
  // newer way ({"error": "login_expired"}) or the 0.1.0 way: ApiError.as_error() for the product's 401, sent the way
  // its SDK sends a returned dict (one text block, and structuredContent {result: body}).
  if ((process.env.FAKE_EXPIRED ?? "").split(",").includes(product)) return text({ error: "login_expired", product });
  if ((process.env.FAKE_401 ?? "").split(",").includes(product)) {
    const url = `https://${product}.example.com/api/endpoint`;
    const body = { error: `${product} answered 401 to GET ${url}: {"error": "invalid_token"}`, status: 401, detail: { error: "invalid_token" }, request_id: null, url };
    return { ...text(body), structuredContent: { result: body } };
  }
  const answer = (JSON.parse(process.env.FAKE_RESULTS ?? "{}") as Record<string, unknown>)[name];
  if (answer !== undefined) return typeof answer === "string" ? { content: [{ type: "text" as const, text: answer }] } : text(answer);
  const troubleshooting = (process.env.FAKE_TROUBLESHOOT ?? "cx_show,cx_ping").split(",");
  if (request.params.name === "invoke_tool" && readOnly && !troubleshooting.includes(name)) return text({ error: "This server is read-only. Nothing was sent." });
  // FAKE_ECHO_ENV: a successful result that repeats that variable's value (a tool that lists API clients).
  if (process.env.FAKE_ECHO_ENV) return text({ ok: true, tool: name, clients: [{ name: "casper", id: process.env[process.env.FAKE_ECHO_ENV] ?? "" }] });
  return text({ ok: true, tool: name });
});
await server.connect(new StdioServerTransport());
