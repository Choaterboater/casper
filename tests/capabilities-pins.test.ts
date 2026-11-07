import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import type { MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { CapabilityBroker, MAX_CLIENT_PINS } from "../src/capabilities/broker";
import { CHILD_KILL_MS, childTestLimit } from "./support/limits";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const fixturePath = path.join(import.meta.dir, "fixtures/mcp-server.ts");
const networkPath = path.join(import.meta.dir, "fixtures/mcp-network-server.ts");
/** A server of `scope`; a client one is the app's own (casper/clientAsks), as only that one may pin (decision 89). */
function definition(name: string, mode: string, scope: MCPServerDefinition["scope"]): MCPServerDefinition {
  return { name, source: "fixture", scope, cwd: process.cwd(), disabled: false, ...(scope === "client" ? { clientOwned: true as const } : {}),
    transport: { type: "stdio", command: process.execPath, args: [fixturePath], env: { FIXTURE_MODE: mode, FIXTURE_ID: name } } };
}
async function brokerFor(...servers: MCPServerDefinition[]): Promise<CapabilityBroker> {
  const mcp = new MCPManager({ servers, diagnostics: [] }, { connectTimeoutMs: CHILD_KILL_MS, callTimeoutMs: 5000 });
  cleanup.push(() => mcp.close());
  for (const server of servers) await mcp.connect(server.name);
  return new CapabilityBroker(mcp);
}
/** The MCP tools the model is offered for a task, as `server:tool` (find_capability and call_capability left out). */
async function direct(broker: CapabilityBroker, task: string): Promise<string[]> {
  const tools = (await broker.prepare(task)).filter((tool) => tool.name.startsWith("mcp_"));
  return tools.map((tool) => /^\[[^\]]*; mcp:([^\]]+)\]/.exec(tool.description)![1]!);
}

test("Client pins join the direct tools: the first right after routers, the rest after docs, at most four", async () => {
  expect(MAX_CLIENT_PINS).toBe(4);
  // A first task that names nothing still gets the app's first four pinned tools, in its own order, and keeps them.
  const alone = await brokerFor(definition("acp-app", "pins", "client"));
  const first = await direct(alone, "hi");
  expect(first).toEqual(["acp-app:pin_one", "acp-app:pin_two", "acp-app:pin_three", "acp-app:pin_four"]);
  expect(await direct(alone, "build a panel")).toEqual(first);
  // The same tools from a server of your own are not pinned: only the app's server can ask for it.
  const own = await brokerFor(definition("mine", "pins", "user"));
  expect(await direct(own, "hi")).toEqual([]);
  // A router server's tools come first; the pins fill what is left of the eight.
  const both = await brokerFor(definition("acp-app", "pins", "client"), definition("network", "router", "user"));
  const surface = await both.prepare("hi");
  expect(surface).toHaveLength(8);
  const shown = await direct(both, "hi");
  expect(shown.slice(0, 3).every((id) => id.startsWith("network:"))).toBe(true);
  expect(shown.slice(3)).toEqual(["acp-app:pin_one", "acp-app:pin_two", "acp-app:pin_three"]);
}, childTestLimit(6));

test("With routers and a docs server too, the app's first pin stays direct and docs keep the slots left", async () => {
  // A recognised hpe-networking-mcp server's docs tools come after the first pin and before the other pins.
  const docs: MCPServerDefinition = { name: "hpe", source: "fixture", scope: "user", cwd: process.cwd(), disabled: false,
    transport: { type: "stdio", command: process.execPath, args: [networkPath], env: { FIXTURE_MODE: "hpe-rag", HPE_MCP_TOOLSETS: "rag" } } };
  // Pins and docs alone: the first pin, both docs tools, then the next pins up to four.
  const pinsAndDocs = await brokerFor(definition("acp-app", "pins", "client"), docs);
  expect(await direct(pinsAndDocs, "hi")).toEqual(["acp-app:pin_one", "hpe:lookup_api", "hpe:search_docs", "acp-app:pin_two", "acp-app:pin_three", "acp-app:pin_four"]);
  // Routers, docs and pins: three routers leave three slots, so the first pin and both docs tools, all within eight.
  const all = await brokerFor(definition("acp-app", "pins", "client"), docs, definition("network", "router", "user"));
  expect(await all.prepare("hi")).toHaveLength(8);
  const order = await direct(all, "hi");
  expect(order.slice(0, 3).every((id) => id.startsWith("network:"))).toBe(true);
  expect(order.slice(3)).toEqual(["acp-app:pin_one", "hpe:lookup_api", "hpe:search_docs"]);
  expect(await direct(all, "search the docs")).toEqual(order);
}, childTestLimit(6));

test("A runtime tool call names its MCP server and tool: a direct tool by name, call_capability by its id", async () => {
  const broker = await brokerFor(definition("acp-app", "pins", "client"));
  const [pinned] = (await broker.prepare("hi")).filter((tool) => tool.name.startsWith("mcp_"));
  expect(broker.named(pinned!.name)).toEqual({ server: "acp-app", tool: "pin_one" });
  expect(broker.named("call_capability", { id: "mcp:acp-app:pin_two" })).toEqual({ server: "acp-app", tool: "pin_two" });
  // An id Casper doesn't know still names what it asked for; anything else names nothing.
  expect(broker.named("call_capability", { id: "mcp:other%20server:do" })).toEqual({ server: "other server", tool: "do" });
  expect(broker.named("call_capability", { id: "status" })).toBeUndefined();
  expect(broker.named("find_capability", { query: "x" })).toBeUndefined();
  expect(broker.named("read")).toBeUndefined();
}, childTestLimit(1));
