import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CapabilityBroker, SEVERAL_ROUTERS_LINE } from "../src/capabilities/broker";
import type { MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { networkServerEntry } from "../src/mcp/network/server";
import { fakeServerProgram } from "./support/fake-program";
import { removeTempDir } from "./support/temp-dir";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

// Casper's own network server and an imported hpe-networking-mcp, each with find_tool + invoke_read_tool.
async function twoNetworkServers(withOwn = true) {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-two-routers-"));
  cleanup.push(() => removeTempDir(home));
  const servers: MCPServerDefinition[] = [];
  const add = async (name: string, where: string, env: Record<string, string>) => {
    await mkdir(path.dirname(where), { recursive: true });
    const entry = await fakeServerProgram(where, "fake-network-mcp", {});
    servers.push({ name, source: path.join(home, ".casper/mcp.json"), scope: "user", cwd: home, disabled: false,
      transport: { type: "stdio", command: entry, args: [], env } });
  };
  // "hpe-networking-mcp" sorts before "network", so a name sort alone would put it first.
  await add("hpe-networking-mcp", path.join(home, "bin/hpe-mcp-router"), { HPE_MCP_EXAMPLE: "1" });
  if (withOwn) await add("network", networkServerEntry(home).command, {});
  const manager = new MCPManager({ servers, diagnostics: [] }, { timeoutMs: 15_000, homeDir: home });
  cleanup.push(() => manager.close());
  for (const server of servers) await manager.connect(server.name);
  const tools = await new CapabilityBroker(manager, async () => "no", { writesGate: true }).prepare("how many clients on the mist network");
  return { manager, tools };
}

test("with Casper's own network server and another one, the AI is told which is Casper's, sees its router first, and is told an empty answer from one server is not the answer", async () => {
  const { manager, tools } = await twoNetworkServers();
  expect(manager.policy("network").match?.preset.id).toBe("casper-network-mcp");
  expect(manager.policy("hpe-networking-mcp").match?.preset.id).toBe("hpe-networking-mcp");
  const find = tools.find((tool) => tool.name === "find_capability")!;
  expect(find.description).toContain("network: Casper's own network server (casper-network-mcp); use it first.");
  expect(find.description).toContain(SEVERAL_ROUTERS_LINE);
  const routers = tools.filter((tool) => /^mcp_find_tool_/.test(tool.name)).map((tool) => tool.description.match(/; (mcp:[^\]]+)\]/)?.[1]);
  expect(routers).toEqual(["mcp:network:find_tool", "mcp:hpe-networking-mcp:find_tool"]);
});

test("one network server alone gets no several-servers line", async () => {
  const { tools } = await twoNetworkServers(false);
  const find = tools.find((tool) => tool.name === "find_capability")!;
  expect(find.description).not.toContain(SEVERAL_ROUTERS_LINE);
  expect(find.description).not.toContain("Casper's own network server");
});
