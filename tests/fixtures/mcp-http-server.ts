// An MCP server over Streamable HTTP on this computer, as an app that starts `casper acp` serves its own tools
// (decision 77): it answers only a request with its bearer token, and records each tool call's name, arguments and
// _meta. Started inside the test process; never contacts anything else.
//
// With `network`, it serves casper-network-mcp's four tools instead, as the app serves its bundled network server
// (decision 100): access_check answers contract v2 with server_gate {flag: "--read-only", state} ("unreported": no
// server_gate), find_tool answers `hits`, and while the gate is off invoke_tool refuses a change but lets a listed
// troubleshooting tool through (cx_show, cx_ping), like the real server's --read-only.

import { createServer, type IncomingMessage } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

const empty = { type: "object" as const, properties: {}, additionalProperties: false };
const site = { type: "object" as const, properties: { site: { type: "string" } }, required: ["site"], additionalProperties: false };
const TOOLS: Tool[] = [
  { name: "whoami", description: "Say which login the request carried", inputSchema: empty, annotations: { readOnlyHint: true } },
  { name: "set_site", description: "Change site configuration", inputSchema: site, annotations: { readOnlyHint: false } },
];

const call = { type: "object" as const, properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name"] };
const NETWORK_TOOLS: Tool[] = [
  { name: "find_tool", description: "Find a Mist, Central or ClearPass tool.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: "invoke_read_tool", description: "Run a read tool.", inputSchema: call, annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: "invoke_tool", description: "Run a change tool.", inputSchema: call, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: "access_check", description: "What each login can do.", inputSchema: empty, annotations: { readOnlyHint: true, destructiveHint: false } },
];
const TROUBLESHOOT = ["cx_show", "cx_ping"];

export interface NetworkFixtureOptions { gate: "off" | "on" | "unreported"; hits?: unknown[] }

function networkAnswer(name: string, args: Record<string, unknown>, options: NetworkFixtureOptions): unknown {
  if (name === "access_check") {
    return { contract: "casper/access-check v2", products: [{ product: "central", access: "read-write",
      ...(options.gate === "unreported" ? {} : { server_gate: { flag: "--read-only", state: options.gate } }) }] };
  }
  if (name === "find_tool") return { result: options.hits ?? [] };
  const tool = typeof args.name === "string" ? args.name : "";
  if (name === "invoke_tool" && options.gate === "off" && !TROUBLESHOOT.includes(tool)) return { error: "This server is read-only. Nothing was sent." };
  return { ok: true, tool };
}

export interface ToolCallSeen { name: string; arguments: Record<string, unknown>; meta: Record<string, unknown> | undefined }

export interface HttpFixture {
  url: string;
  /** Every tools/call that got through, in order. */
  calls: ToolCallSeen[];
  /** How many requests were refused for a missing or wrong token. */
  refused: () => number;
  close(): Promise<void>;
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

export async function httpFixture(token: string, options: { network?: NetworkFixtureOptions } = {}): Promise<HttpFixture> {
  const network = options.network;
  const calls: ToolCallSeen[] = [];
  let refused = 0;
  const http = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      refused++;
      response.writeHead(401).end();
      return;
    }
    // Stateless: a server and a transport for each request.
    const server = new Server({ name: "app-fixture", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: network ? NETWORK_TOOLS : TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const { name, arguments: args, _meta } = call.params;
      const meta = _meta ? Object.fromEntries(Object.entries(_meta).filter(([key]) => key !== "progressToken")) : undefined;
      calls.push({ name, arguments: args ?? {}, meta: meta && Object.keys(meta).length ? meta : undefined });
      const value = network ? networkAnswer(name, args ?? {}, network)
        : name === "whoami" ? { authorization: request.headers.authorization } : { tool: name, arguments: args ?? {} };
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.method === "POST" ? await body(request) : undefined);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp/fixture`, calls, refused: () => refused,
    close: async () => { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); },
  };
}
