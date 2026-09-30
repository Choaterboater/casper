import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CapabilityBroker, type ConfirmCapability } from "../src/capabilities/broker";
import type { MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import type { RuntimeTool } from "../src/runtime/types";

const network = path.join(import.meta.dir, "fixtures/mcp-network-server.ts");
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function server(name: string, env: Record<string, string>): MCPServerDefinition {
  return { name, source: "/home/u/.casper/mcp.json", scope: "user", cwd: process.cwd(), disabled: false,
    transport: { type: "stdio", command: process.execPath, args: [network], env } };
}
async function connected(definition: MCPServerDefinition, confirm?: ConfirmCapability) {
  const mcp = new MCPManager({ servers: [definition], diagnostics: [] }, { timeoutMs: 5000 });
  cleanup.push(() => mcp.close());
  await mcp.connect(definition.name);
  const broker = new CapabilityBroker(mcp, confirm);
  return { mcp, broker };
}
async function callTool(tools: RuntimeTool[], name: string, args: Record<string, unknown>) {
  const tool = tools.find((entry) => entry.name === name)!;
  return tool.execute(args);
}

test("an MCP result reaches the model with device secrets hidden, a count, and the next-page cursor kept", async () => {
  const { broker } = await connected(server("lab", { FIXTURE_MODE: "config" }));
  const tools = await broker.prepare("running config");
  const answer = await callTool(tools, "call_capability", { id: "mcp:lab:get_running_config", arguments: {} });
  for (const secret of ["AQBapFixtureCipher", "RadKeyCX", "FixtureComm", "SuperPSK123"]) expect(answer.text).not.toContain(secret);
  expect(answer.text).toContain("<secret hidden>");
  expect(answer.text).toContain("hostname sw1");
  const result = JSON.parse(answer.text);
  expect(result.secretsHidden).toBe(4);
  expect(result.summary).toContain("4 secrets hidden before the AI saw this");
  expect(result.nextCursor).toMatchObject({ value: "c1" });
  expect(answer.text).toContain("list_key");
});

test("a secret under a key like psk is hidden; hpe-networking-mcp's hpe_mcp_secret_ tokens pass through", async () => {
  const { broker } = await connected(server("lab", { FIXTURE_MODE: "config" }));
  const result = await broker.invoke("mcp:lab:get_ssid", {});
  const text = JSON.stringify(result);
  expect(text).not.toContain("FixturePsk-77");
  expect(text).toContain("hpe_mcp_secret_0123456789abcdef0123456789abcdef");
  expect(result.secretsHidden).toBe(1);
});

test("a change that still has <secret hidden> in it is refused before anyone is asked, and nothing is sent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-secret-gate-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const calls = path.join(root, "calls.log");
  let asked = 0;
  const { broker } = await connected(server("lab", { FIXTURE_MODE: "config", FIXTURE_CALLS_FILE: calls }), async () => { asked++; return true; });
  await expect(broker.invoke("mcp:lab:set_config", { lines: "snmp-server community <secret hidden>" }))
    .rejects.toThrow("Not executed (this change still has <secret hidden> in it). Casper hid that secret from the AI, so the AI can't send it back.");
  expect(asked).toBe(0);
  expect(await readFile(calls, "utf8").catch(() => "")).not.toContain("set_config");
});

test("docs tools of a recognised hpe-networking-mcp server are always offered, after the routers", async () => {
  const { broker } = await connected(server("hpe", { FIXTURE_MODE: "hpe-docs", HPE_MCP_TOOLSETS: "central,rag" }));
  const tools = await broker.prepare("configure vlan 20 on uplink");
  const lookup = tools.find((tool) => tool.description.includes("mcp:hpe:lookup_api"));
  expect(lookup?.description).toStartWith("[docs; read; mcp:hpe:lookup_api] Check docs here before guessing Aruba, HPE, Mist or Junos API and config details.");
  expect(lookup?.description).not.toContain("read-only");
  const names = tools.map((tool) => tool.description.match(/mcp:hpe:(\w+)/)?.[1]).filter(Boolean);
  expect(names.slice(0, 6)).toEqual(["find_tool", "invoke_read_tool", "invoke_tool", "lookup_api", "search_docs", "ask_docs"]);
  expect(tools.length).toBeLessThanOrEqual(8);
});

test("the same docs tool names on a server Casper did not recognise get no special place", async () => {
  const { broker } = await connected(server("other", { FIXTURE_MODE: "hpe-docs" }));
  const tools = await broker.prepare("configure vlan 20 on uplink");
  expect(tools.some((tool) => tool.description.includes("lookup_api"))).toBe(false);
  expect(tools.some((tool) => tool.description.startsWith("[docs"))).toBe(false);
});
