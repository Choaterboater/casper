import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MCPManager, ownServerDefaults } from "../src/mcp/manager";
import { CasperApp } from "../src/app";
import { waitUntil } from "./support/wait";
import type { MCPServerDefinition } from "../src/mcp/config";
import { CapabilityBroker } from "../src/capabilities/broker";
import { LSPManager } from "../src/lsp/manager";
import { runSettings, settingRows, type SettingsHost } from "../src/app/settings";
import { loadConfiguration } from "../src/config/load";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { removeTempDir } from "./support/temp-dir";

/** Your own MCP and language servers start by themselves (My MCP servers, My language servers in /settings). */

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const mcpFixture = path.join(import.meta.dir, "fixtures/mcp-server.ts");
const lspFixture = path.join(import.meta.dir, "fixtures/lsp-server.ts");

async function tempDir(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  cleanup.push(() => removeTempDir(root));
  return root;
}

function server(name: string, mode: string, extra: Partial<MCPServerDefinition> = {}, env: Record<string, string> = {}): MCPServerDefinition {
  return { name, source: "fixture", scope: "user", cwd: process.cwd(), disabled: false, ...extra, transport: {
    type: "stdio", command: process.execPath, args: [mcpFixture], env: { FIXTURE_MODE: mode, FIXTURE_ID: name, ...env },
  } };
}

function setup(servers: MCPServerDefinition[], autoconnect: boolean | undefined) {
  const mcp = new MCPManager({ servers, diagnostics: [] }, { timeoutMs: 15_000, ...(autoconnect === undefined ? {} : { autoconnect }) });
  const boxes: string[] = [];
  const kinds: string[] = [];
  const broker = new CapabilityBroker(mcp, async (call) => { boxes.push(call.plan.tool); return false; }, {
    writesGate: true, confirmKind: async (ask) => { kinds.push(ask.kind); return false; },
  });
  cleanup.push(() => broker.close());
  return { mcp, broker, boxes, kinds };
}

const state = (mcp: MCPManager, name: string) => mcp.status().find((status) => status.name === name)!;

test("your own MCP server connects at the start with writes on, and its change runs without the change box", async () => {
  const { mcp, broker, boxes, kinds } = setup([server("own", "own")], true);
  expect(state(mcp, "own")).toMatchObject({ approved: true, writes: "on" });
  await broker.prepare("site");
  expect(state(mcp, "own").state).toBe("ready");
  const result = await broker.invoke("mcp:own:set_site", { site: "a" });
  expect(result.isError).toBeFalsy();
  expect(boxes).toEqual([]);
  // The risky-kinds box (firmware, delete, admin) still asks.
  await expect(broker.invoke("mcp:own:delete_site", { site: "a" })).rejects.toThrow("you said no");
  expect(kinds).toEqual(["delete"]);
  expect(boxes).toEqual([]);
  // The footer's WRITES badge is for writes you turned on; your own servers' are on by default.
  expect(mcp.writesOn({ own: false })).toEqual([]);
  expect(mcp.writesOn()).toEqual(["own"]);
});

test("writes turned off (Ctrl+X) bring the change box back for your own server", async () => {
  const { mcp, broker, boxes } = setup([server("own", "own")], true);
  await broker.prepare("site");
  await mcp.setWrites("own", false);
  await expect(broker.invoke("mcp:own:set_site", { site: "a" })).rejects.toThrow("you said no");
  expect(boxes).toEqual(["set_site"]);
});

test("an unpinned package runner of your own connects on its own too", () => {
  const runner: MCPServerDefinition = { name: "runner", source: "fixture", scope: "user", cwd: process.cwd(), disabled: false,
    transport: { type: "stdio", command: "npx", args: ["-y", "some-mcp-server"], env: {} } };
  const { mcp } = setup([runner, { ...runner, name: "imported", scope: "imported" }], true);
  expect(state(mcp, "runner").approved).toBe(true);
  expect(state(mcp, "imported").approved).toBe(true);
});

test("a project's server keeps its review: it does not connect on its own", async () => {
  const { mcp, broker } = setup([server("proj", "own", { scope: "project" })], true);
  await broker.prepare("site");
  expect(state(mcp, "proj")).toMatchObject({ approved: false, state: "disconnected", writes: "off" });
});

test("a network product server connects on its own but keeps writes off and its yes/no box", async () => {
  // MIST_READ_ONLY makes it Casper's mist-mcp preset by its definition.
  const { mcp, broker, boxes } = setup([server("mist", "own", {}, { MIST_READ_ONLY: "0" })], true);
  expect(state(mcp, "mist")).toMatchObject({ approved: true, writes: "off" });
  await broker.prepare("site");
  expect(state(mcp, "mist").state).toBe("ready");
  await expect(broker.invoke("mcp:mist:set_site", { site: "a" })).rejects.toThrow("you said no");
  expect(boxes).toEqual(["set_site"]);
});

test("a server recognised as a network product by its tool list goes back to writes off", async () => {
  const { mcp, broker } = setup([server("router", "network")], true);
  expect(state(mcp, "router").writes).toBe("on");
  await broker.prepare("network");
  expect(state(mcp, "router")).toMatchObject({ state: "ready", writes: "off" });
});

test("My MCP servers off: today's behavior, connect with /mcp connect, writes off, change box", async () => {
  const { mcp, broker, boxes } = setup([server("own", "own")], false);
  expect(state(mcp, "own")).toMatchObject({ approved: false, writes: "off" });
  await broker.prepare("site");
  expect(state(mcp, "own").state).toBe("disconnected");
  await mcp.connect("own");
  await expect(broker.invoke("mcp:own:set_site", { site: "a" })).rejects.toThrow("you said no");
  expect(boxes).toEqual(["set_site"]);
});

test("your own language servers start by themselves; a project's keeps its review", async () => {
  const root = await tempDir("casper-own-lsp-");
  const definition = { source: "test", command: process.execPath, args: [lspFixture, "normal"], languages: { ".ts": "typescript" } };
  const manager = new LSPManager(root, { servers: [
    { ...definition, name: "mine", scope: "user" }, { ...definition, name: "theirs", scope: "project" },
  ], diagnostics: [] }, 10_000);
  cleanup.push(() => manager.close());
  await manager.startOwn();
  const states = Object.fromEntries(manager.status().map((status) => [status.name, status.state]));
  expect(states).toEqual({ mine: "ready", theirs: "disconnected" });
});

test("a session starts your own MCP and language servers by itself; with My MCP servers and My language servers off it doesn't", async () => {
  ownServerDefaults.start = true;
  cleanup.push(() => { ownServerDefaults.start = false; });
  for (const config of ["", "mcp_autoconnect: false\nlsp_autostart: false\n"]) {
    const { home, project } = await folders();
    await writeFile(path.join(home, ".casper", "config.yaml"), config);
    const app = new CasperApp({
      output: { write: () => {} }, runtimeFactory: () => { throw new Error("No model expected"); }, sessionHomeDir: home,
      loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
      loadMCPConfiguration: async () => ({ servers: [server("own", "own")], diagnostics: [] }),
      loadLSPConfiguration: async () => ({ servers: [{ name: "mine", source: "test", scope: "user", command: process.execPath,
        args: [lspFixture, "normal"], languages: { ".ts": "typescript" } }], diagnostics: [] }),
      loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    });
    try {
      await app.runOnce("/project", project);
      if (!config) {
        expect(await waitUntil(() => app.mcp!.status()[0]!.state === "ready" && app.lsp!.status()[0]!.state === "ready")).toBe(true);
        expect(app.mcp!.status()[0]!.writes).toBe("on");
      } else {
        await Bun.sleep(200);
        expect([app.mcp!.status()[0]!.state, app.lsp!.status()[0]!.state]).toEqual(["disconnected", "disconnected"]);
      }
    } finally { await app.close(); }
  }
});

async function folders() {
  const base = await tempDir("casper-own-settings-");
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  return { home, project, config: path.join(home, ".casper", "config.yaml"), projectFile: path.join(project, ".casper", "project.yaml") };
}

test("mcp_autoconnect and lsp_autostart are your own settings: on unless you turn them off, never in a project file", async () => {
  const { home, project, config, projectFile } = await folders();
  const load = () => loadConfiguration({ projectRoot: project, homeDir: home });
  expect(await load()).not.toHaveProperty("mcpAutoconnect");
  await writeFile(config, "mcp_autoconnect: off\nlsp_autostart: off\n");
  expect(await load()).toMatchObject({ mcpAutoconnect: false, lspAutostart: false });
  await writeFile(projectFile, "mcp_autoconnect: on\n");
  await expect(load()).rejects.toThrow("mcp_autoconnect is a user setting");
  await writeFile(projectFile, "lsp_autostart: on\n");
  await expect(load()).rejects.toThrow("lsp_autostart is a user setting");
});

test("/settings rows My MCP servers and My language servers: on by default, a pick writes the key false", async () => {
  const { home, project, config } = await folders();
  const context = async () => loadProjectContext(await inspectProject(project), { homeDir: home });
  const rows = settingRows(await context());
  expect(rows.find((row) => row.label === "My MCP servers")?.value).toBe("on");
  expect(rows.find((row) => row.label === "My language servers")?.value).toBe("on");
  const answers = ["My MCP servers", "Turn them off", "My language servers", "Turn them off", "Done"];
  let current = await context();
  const host: SettingsHost = {
    output: { write: () => {} }, homeDir: () => home, canAsk: true,
    context: async () => current, reload: async () => { current = await context(); },
    ask: async () => answers.shift(),
  };
  await runSettings(host);
  expect(await readFile(config, "utf8")).toBe("mcp_autoconnect: false\nlsp_autostart: false\n");
  expect(current).toMatchObject({ mcpAutoconnect: false, lspAutostart: false });
});
