import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CapabilityBroker, type ConfirmCapability } from "../src/capabilities/broker";
import type { MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import type { RuntimeTool } from "../src/runtime/types";
import { CHILD_KILL_MS, childTestLimit } from "./support/limits";
import { removeTempDir } from "./support/temp-dir";

const network = path.join(import.meta.dir, "fixtures/mcp-network-server.ts");
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function server(name: string, env: Record<string, string>): MCPServerDefinition {
  return { name, source: "/home/u/.casper/mcp.json", scope: "user", cwd: process.cwd(), disabled: false,
    transport: { type: "stdio", command: process.execPath, args: [network], env } };
}
/** The fixture server, started and ready. Its start has the guard for a real child (tests/support/limits.ts): a busy
 * Windows runner can take seconds to start a Bun child. A server that never got ready fails here with its own error
 * and output, not later as an unknown capability. */
async function ready(definition: MCPServerDefinition) {
  const mcp = new MCPManager({ servers: [definition], diagnostics: [] }, { connectTimeoutMs: CHILD_KILL_MS, callTimeoutMs: 5000 });
  cleanup.push(() => mcp.close());
  await mcp.connect(definition.name);
  expect(mcp.status()[0]).toMatchObject({ name: definition.name, state: "ready" });
  return mcp;
}
async function connected(definition: MCPServerDefinition, confirm?: ConfirmCapability) {
  const mcp = await ready(definition);
  return { mcp, broker: new CapabilityBroker(mcp, confirm) };
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
}, childTestLimit());

test("a secret under a key like psk is hidden; hpe-networking-mcp's hpe_mcp_secret_ tokens pass through", async () => {
  const { broker } = await connected(server("lab", { FIXTURE_MODE: "config" }));
  const result = await broker.invoke("mcp:lab:get_ssid", {});
  const text = JSON.stringify(result);
  expect(text).not.toContain("FixturePsk-77");
  expect(text).toContain("hpe_mcp_secret_0123456789abcdef0123456789abcdef");
  expect(result.secretsHidden).toBe(1);
}, childTestLimit());

test("a change that still has <secret hidden> in it is refused before anyone is asked, and nothing is sent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-secret-gate-"));
  cleanup.push(() => removeTempDir(root));
  const calls = path.join(root, "calls.log");
  let asked = 0;
  const { broker } = await connected(server("lab", { FIXTURE_MODE: "config", FIXTURE_CALLS_FILE: calls }), async () => { asked++; return true; });
  await expect(broker.invoke("mcp:lab:set_config", { lines: "snmp-server community <secret hidden>" }))
    .rejects.toThrow("Not executed (this change still has <secret hidden> in it). Casper hid that secret from the AI, so the AI can't send it back.");
  expect(asked).toBe(0);
  expect(await readFile(calls, "utf8").catch(() => "")).not.toContain("set_config");
}, childTestLimit());

test("docs tools of a recognised hpe-networking-mcp server are always offered, after the routers", async () => {
  const { broker } = await connected(server("hpe", { FIXTURE_MODE: "hpe-docs", HPE_MCP_TOOLSETS: "central,rag" }));
  const tools = await broker.prepare("configure vlan 20 on uplink");
  const lookup = tools.find((tool) => tool.description.includes("mcp:hpe:lookup_api"));
  expect(lookup?.description).toStartWith("[docs; read; mcp:hpe:lookup_api] Check docs here before guessing Aruba, HPE, Mist or Junos API and config details.");
  expect(lookup?.description).not.toContain("read-only");
  const names = tools.map((tool) => tool.description.match(/mcp:hpe:(\w+)/)?.[1]).filter(Boolean);
  expect(names.slice(0, 6)).toEqual(["find_tool", "invoke_read_tool", "invoke_tool", "lookup_api", "search_docs", "ask_docs"]);
  expect(tools.length).toBeLessThanOrEqual(8);
}, childTestLimit());

test("the same docs tool names on a server Casper did not recognise get no special place", async () => {
  const { broker } = await connected(server("other", { FIXTURE_MODE: "hpe-docs" }));
  const tools = await broker.prepare("configure vlan 20 on uplink");
  expect(tools.some((tool) => tool.description.includes("lookup_api"))).toBe(false);
  expect(tools.some((tool) => tool.description.startsWith("[docs"))).toBe(false);
}, childTestLimit());

test("an MCP result hides Casper's own secret values and saved logins, from any server", async () => {
  const provider = "sk-or-v1-0123456789abcdef0123456789abcdef";
  const mist = "mist-token-ABCDEF0123456789";
  const definition = server("fs", { FIXTURE_MODE: "config", FIXTURE_ENV_DUMP: "1", HPE_MCP_A: provider, HPE_MCP_B: mist });
  const broker = new CapabilityBroker(await ready(definition), undefined, { secretValues: () => [provider, mist] });
  const result = await broker.invoke("mcp:fs:get_env", {});
  const text = JSON.stringify(result);
  expect(text).not.toContain(provider);
  expect(text).not.toContain(mist);
  expect(result.secretsHidden).toBe(2);
  // Paging is untouched: an exact value is the only thing this pass hides.
  const config = await broker.invoke("mcp:fs:get_running_config", {});
  expect(JSON.stringify(config)).toContain("c1");
}, childTestLimit());

test("a tool's description, schema and tags reach the model without the values its server was given", async () => {
  // An app's server that writes its own key into its tool list (values made up for the test).
  const key = "app-key-0123456789abcdef";
  const tool = {
    name: "list_sites", annotations: { readOnlyHint: true }, _meta: { tags: [`org ${key}`] },
    description: `Lists sites. Sends Authorization: Bearer ${key} and ?key=${encodeURIComponent(`${key}/x`)}.`,
    inputSchema: { type: "object" as const, properties: { org: { type: "string", description: `Defaults to ${key}`, enum: ["main", key] }, [key]: { type: "string" } } },
  };
  const manager = {
    catalogRevision: 1, prepareForTask: async () => {}, policy: () => ({ writes: "on", showOptIn: false }), status: () => [{ name: "acp-app" }],
    catalog: () => [{ server: "acp-app", generation: 1, tools: [tool] }], loginValues: () => [key, encodeURIComponent(`${key}/x`)],
    definition: () => { throw new Error("not needed"); },
  } as unknown as MCPManager;
  const broker = new CapabilityBroker(manager, undefined, { secretValues: () => [] });
  const direct = await broker.prepare("list the sites");
  const finder = direct.find((entry) => entry.name === "find_capability")!;
  const seen = [
    JSON.stringify(direct.map((entry) => [entry.description, entry.inputSchema])),
    JSON.stringify(broker.describe("mcp:acp-app:list_sites")),
    (await finder.execute({ query: "sites" })).text,
    (await finder.execute({ id: "mcp:acp-app:list_sites" })).text,
    (await finder.execute({ query: "*" })).text,
  ];
  for (const text of seen) {
    expect(text).not.toContain(key);
    expect(text).not.toContain(encodeURIComponent(`${key}/x`));
  }
  expect(seen[0]).toContain("Lists sites. Sends Authorization: Bearer <secret hidden>");
  // The tool itself is unchanged: calls are checked against what the server listed.
  expect(tool.inputSchema.properties.org.enum).toEqual(["main", key]);
  // A tool with nothing to hide keeps its schema as the server sent it.
  const plain = new CapabilityBroker({ ...manager, loginValues: () => ["other-value-1234"] } as unknown as MCPManager, undefined, { secretValues: () => [] });
  expect(plain.describe("mcp:acp-app:list_sites").inputSchema).toEqual(tool.inputSchema);
});
