import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CapabilityBroker } from "../src/capabilities/broker";
import type { MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { networkServerEntry } from "../src/mcp/network/server";
import { allowSlowServerStopsOnWindows, fakeServerProgram } from "./support/fake-program";
import { removeTempDir } from "./support/temp-dir";

allowSlowServerStopsOnWindows();
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** The network server's stand-in behind the real manager and broker; each read tool answers what `results` gives it. */
async function readServer(results: Record<string, unknown>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-offline-"));
  cleanup.push(() => removeTempDir(home));
  const where = networkServerEntry(home).command;
  await mkdir(path.dirname(where), { recursive: true });
  const entry = await fakeServerProgram(where, "fake-network-mcp", {
    FAKE_RESULTS: JSON.stringify(results), CENTRAL_CLIENT_ID: "test-id", CENTRAL_CLIENT_SECRET: "test-value", MIST_API_TOKEN: "test-token",
  });
  const definition: MCPServerDefinition = { name: "network", source: path.join(home, ".casper/mcp.json"), scope: "user", cwd: home, disabled: false,
    transport: { type: "stdio", command: entry, args: [], env: {} } };
  const manager = new MCPManager({ servers: [definition], diagnostics: [] }, { timeoutMs: 15_000, homeDir: home });
  cleanup.push(() => manager.close());
  await manager.connect("network");
  const broker = new CapabilityBroker(manager, async () => "yes", { writesGate: true });
  return async (name: string) => (await broker.invoke("mcp:network:invoke_read_tool", { name, arguments: {} })).summary;
}

const OTHER_WAY = /Before you end blocked, try another way in.*ssh to its management address.*own box.*never ask for a password in chat.*Mist.*Central.*read-only CLI.*"Next step:/s;

test("a read that shows a device offline tells the AI to try another way in and offer it as the next step", async () => {
  const read = await readServer({
    central_get_device: { name: "CORE-SW", serial: "SN0000001", status: "OFFLINE" },
    mist_list_devices: [{ name: "AP-1", status: "connected" }, { name: "SW-2", status: "disconnected" }],
    central_get_switch: { result: { hostname: "EDGE-1", connected: false } },
    central_show_ports: "Error: device not connected",
    central_list_aps: [{ name: "AP-3", status: "ONLINE" }, { name: "AP-4", status: "Up", oper_status: "down" }],
  });
  for (const tool of ["central_get_device", "mist_list_devices", "central_get_switch", "central_show_ports"]) {
    expect([tool, await read(tool)]).toEqual([tool, expect.stringMatching(OTHER_WAY)]);
  }
  // Every device online (a port that is down is not a device that is offline): no line.
  expect(await read("central_list_aps")).not.toContain("Before you end blocked");
}, 60_000);
