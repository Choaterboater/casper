import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * A stand-in for `ssh <options> -- <host> "<remote command>"`: Bun starts it with the same words ssh would get, and it
 * ignores them. No ssh and no other machine: it only answers like an MCP server on the far side would. It has a
 * read-only access_check (casper/access-check v2) unless FAKE_NO_ACCESS=1. FAKE_CALLS_FILE: one line per start and
 * per call.
 */
const words = process.argv.slice(2);
const calls = process.env.FAKE_CALLS_FILE;
const log = (line: string) => { if (calls) appendFileSync(calls, `${line}\n`); };
log(`start ${JSON.stringify(words)}`);

const object = (properties: Record<string, object> = {}): Tool["inputSchema"] => ({ type: "object", properties });
const TOOLS: Tool[] = [
  { name: "list_boxes", description: "List the boxes.", inputSchema: object(), annotations: { readOnlyHint: true } },
  { name: "restart_box", description: "Restart a box.", inputSchema: object({ box: { type: "string" } }),
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { "casper/change-kind": "disruptive" } },
  ...(process.env.FAKE_NO_ACCESS === "1" ? [] : [
    { name: "access_check", description: "What this login may do.", inputSchema: object(), annotations: { readOnlyHint: true } } satisfies Tool,
  ]),
];

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const server = new Server({ name: "fake-ssh", version: "0.0.0-fake" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  log(`call ${name} ${JSON.stringify(request.params.arguments ?? {})}`);
  if (name === "access_check") {
    return text({ contract: "casper/access-check v2", products: [{ product: "lab", access: "read-only", identity: "reader" }] });
  }
  if (name === "list_boxes") return text({ boxes: ["box-1"] });
  return text({ ok: true, tool: name });
});
await server.connect(new StdioServerTransport());
