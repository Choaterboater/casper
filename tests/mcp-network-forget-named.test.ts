import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { networkLoginHost } from "../src/app/network-host";
import { CapabilityBroker } from "../src/capabilities/broker";
import type { MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { askToForgetNamedLogin, type LoginHost } from "../src/mcp/network/ask-login";
import { readNamedLogins, saveNamedLogin } from "../src/mcp/network/logins";
import { networkServerEntry } from "../src/mcp/network/server";
import { allowSlowServerStopsOnWindows, fakeServerProgram } from "./support/fake-program";
import { removeTempDir } from "./support/temp-dir";

allowSlowServerStopsOnWindows();
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const TEMP = { CENTRAL_BASE_URL: "https://us5.api.central.arubanetworks.com", CENTRAL_CLIENT_ID: "client-temp-EXAMPLE", CENTRAL_CLIENT_SECRET: "sec-EXAMPLE-temp-99" };

/** Casper's network server (a stand-in that answers a call with login: <name> from the CENTRAL_<NAME>_* it started
 * with) behind the real manager and broker, with a saved "temp" Central login. */
async function setup(env: Record<string, string> = {}, ownEnv: Record<string, string> = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-forget-named-"));
  cleanup.push(() => removeTempDir(home));
  const where = networkServerEntry(home).command;
  await mkdir(path.dirname(where), { recursive: true });
  const entry = await fakeServerProgram(where, "fake-network-mcp", { FAKE_CALLS_FILE: path.join(home, "calls.log"), ...env });
  await saveNamedLogin(home, "temp", TEMP);
  const definition: MCPServerDefinition = { name: "network", source: path.join(home, ".casper/mcp.json"), scope: "user", cwd: home, disabled: false,
    transport: { type: "stdio", ...networkServerEntry(home), command: entry, env: ownEnv } };
  const manager = new MCPManager({ servers: [definition], diagnostics: [] }, { timeoutMs: 15_000, homeDir: home });
  cleanup.push(() => manager.close());
  await manager.connect("network");
  const broker = new CapabilityBroker(manager, undefined, { writesGate: true });
  const events: string[] = [];
  const host: LoginHost = {
    homeDir: home, interactive: true, canAsk: () => true, privateInput: async () => undefined,
    chooseAnswer: async () => "2", write: (text) => { events.push(`said ${text.trim()}`); },
    restart: async (server) => { await manager.restartAfterCalls(server, { loginsChanged: true }); events.push("restarted"); },
    access: (server) => manager.policy(server).access,
    startSettings: (server) => {
      const own = manager.definition(server);
      return own.transport.type === "stdio" ? { source: own.source, env: own.transport.env } : undefined;
    },
  };
  const read = async () => {
    const result = await broker.invoke("mcp:network:invoke_read_tool", { name: "central_list_aps", arguments: {}, login: "temp" });
    const text = JSON.stringify(result);
    // The client id is hidden from the AI as a secret: whether the login answered is what counts.
    return text.includes("unknown_login") ? "without temp" : text.includes('\\"login\\":\\"temp\\"') || text.includes('"login":"temp"') ? "with temp" : text;
  };
  /** Until the server has received a call to `tool` (it logs each call as it arrives). */
  const received = async (tool: string) => {
    const end = Date.now() + 15_000;
    while (!(await readFile(path.join(home, "calls.log"), "utf8").catch(() => "")).includes(`"name":"${tool}"`)) {
      if (Date.now() > end) throw new Error(`the server never got ${tool}`);
      await Bun.sleep(20);
    }
  };
  return { home, manager, broker, host, events, read, received };
}

test("after Forgot, a call with that login no longer reaches it", async () => {
  const s = await setup();
  expect(await s.read()).toBe("with temp");
  expect(await askToForgetNamedLogin(s.host, "network", "temp")).toBe("forgot");
  expect(await readNamedLogins(s.home)).toEqual({});
  expect(await s.read()).toBe("without temp");
}, 30_000);

test("the server reports its named Central logins, so Casper can tell whether one is still there", async () => {
  const s = await setup();
  expect(s.manager.policy("network").access?.products.find((item) => item.product === "central")?.namedLogins).toEqual(["temp"]);
}, 30_000);

test("a forget while a call with that login is still running: Forgot after the server lost it, and that call's answer says it is from before", async () => {
  const s = await setup({ FAKE_SLOW_MS: "1000" });
  let stale = "";
  const running = s.broker.invoke("mcp:network:invoke_read_tool", { name: "central_list_aps", arguments: {}, login: "temp" })
    .then((result) => { stale = result.summary; s.events.push("call ended"); });
  await s.received("central_list_aps");
  expect(await askToForgetNamedLogin(s.host, "network", "temp")).toBe("forgot");
  await running;
  expect(s.events).toEqual(["call ended", "restarted", 'said Forgot the Central "temp" login.']);
  // The AI read this answer after Forgot: it says the logins changed while it ran, so it isn't taken as current.
  expect(stale).toContain("The network server's logins changed while this call ran (one was forgotten or replaced). This answer came from the logins before; call again for the current state.");
  expect(await s.read()).toBe("without temp");
  expect(s.manager.policy("network").access?.products.find((item) => item.product === "central")?.namedLogins).toBeUndefined();
  // A call that starts after the restart has no such line.
  expect((await s.broker.invoke("mcp:network:invoke_read_tool", { name: "central_list_aps", arguments: {} })).summary).not.toContain("logins changed");
}, 30_000);

test("a login the server still has after the restart is never 'Forgot': the message says what still holds it", async () => {
  // The server's own start settings (~/.casper/mcp.json) set the temp login too.
  const s = await setup({}, { CENTRAL_TEMP_BASE_URL: TEMP.CENTRAL_BASE_URL, CENTRAL_TEMP_CLIENT_ID: TEMP.CENTRAL_CLIENT_ID, CENTRAL_TEMP_CLIENT_SECRET: TEMP.CENTRAL_CLIENT_SECRET });
  expect(await askToForgetNamedLogin(s.host, "network", "temp")).toBe("held");
  expect(await readNamedLogins(s.home)).toEqual({});
  const said = s.events.filter((line) => line.startsWith("said ")).join("\n");
  expect(said).not.toContain("Forgot the Central");
  expect(said).toContain('said Removed the Central "temp" login from Casper\'s saved logins, but the running network server still has it: '
    + `its settings in ${path.join(s.home, ".casper/mcp.json")} set CENTRAL_TEMP_BASE_URL, CENTRAL_TEMP_CLIENT_ID and CENTRAL_TEMP_CLIENT_SECRET. Remove them there and type /mcp reload.`);
  expect(await s.read()).toBe("with temp");
}, 30_000);

test("Casper's login host restarts the server for a login change, and names where its start settings come from", async () => {
  const asked: unknown[] = [];
  const definition = { name: "network", source: "/home/example/.casper/mcp.json", transport: { type: "stdio", command: "x", args: [], env: { CENTRAL_TEMP_CLIENT_ID: "x" } } };
  const app = { mcp: { restartAfterCalls: async (name: string, options: unknown) => { asked.push([name, options]); }, definition: () => definition } } as never;
  const host = networkLoginHost(app);
  await host.restart("network");
  expect(asked).toEqual([["network", { loginsChanged: true }]]);
  expect(host.startSettings?.("network")).toEqual({ source: "/home/example/.casper/mcp.json", env: { CENTRAL_TEMP_CLIENT_ID: "x" } });
});
