import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration, readAcpMcpSetting } from "../src/config/load";
import { removeTempDir } from "./support/temp-dir";
import { clientServers, withClientServers } from "../src/acp/client-servers";
import { CapabilityBroker, SEVERAL_ROUTERS_LINE } from "../src/capabilities/broker";
import { resolvedSecrets, type MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { networkServerEntry } from "../src/mcp/network/server";
import { httpFixture } from "./fixtures/mcp-http-server";
import { allowSlowServerStopsOnWindows, fakeServerProgram } from "./support/fake-program";
import { CHILD_KILL_MS, childTestLimit } from "./support/limits";

const HOME = path.resolve("/home-for-tests");
const command = path.resolve("/usr/local/bin/app-mcp");
const on = { home: HOME, setting: "on" as const };

test("An app's MCP server gets an acp- name and its header values are taken literally", () => {
  const found = clientServers([
    { type: "http", name: "app", url: "http://127.0.0.1:4321/mcp/abc", headers: [{ name: "Authorization", value: "Bearer ${ANTHROPIC_API_KEY}" }] },
    { name: "tools", command, args: ["--serve"], env: [{ name: "APP_TOKEN", value: "${HOME}-literal" }] },
  ], on);
  expect(found.definitions.map((definition) => definition.name)).toEqual(["acp-app", "acp-tools"]);
  const [http, stdio] = found.definitions as [MCPServerDefinition, MCPServerDefinition];
  expect(http).toMatchObject({ scope: "client", source: "the app (ACP)", cwd: HOME, disabled: false,
    transport: { type: "http", url: "http://127.0.0.1:4321/mcp/abc", headers: { Authorization: "Bearer ${ANTHROPIC_API_KEY}" } } });
  expect(stdio).toMatchObject({ scope: "client", cwd: HOME, transport: { type: "stdio", command, args: ["--serve"], env: { APP_TOKEN: "${HOME}-literal" } } });
  // Every value is a secret as given: nothing is filled from Casper's environment.
  // The credential after "Bearer" is hidden on its own too, and each URL-encoded (decision 89).
  const both = (value: string) => [value, encodeURIComponent(value)];
  expect(found.secrets).toEqual([...both("Bearer ${ANTHROPIC_API_KEY}"), ...both("${ANTHROPIC_API_KEY}"), ...both("${HOME}-literal")]);
  expect(resolvedSecrets(http)).toEqual([...both("Bearer ${ANTHROPIC_API_KEY}"), ...both("${ANTHROPIC_API_KEY}")]);
  expect(found.notes).toEqual([
    "[acp] The app's MCP server acp-app connects for this session.",
    "[acp] The app's MCP server acp-tools connects for this session.",
  ]);
  for (const note of found.notes) for (const value of found.secrets) expect(note).not.toContain(value);
});

test("An app's http server is sent its header exactly as the app gave it, ${VAR} and all", async () => {
  // The fixture answers only the literal value: a header filled from Casper's environment (or a refused missing
  // variable) is turned away, and the connect fails.
  const literal = "${CASPER_TEST_APP_HEADER_UNSET}";
  const server = await httpFixture(literal);
  const { definitions } = clientServers([{ type: "http", name: "app", url: server.url, headers: [{ name: "Authorization", value: `Bearer ${literal}` }] }], on);
  const mcp = new MCPManager({ servers: definitions, diagnostics: [] }, { connectTimeoutMs: CHILD_KILL_MS, callTimeoutMs: 5000 });
  try {
    await mcp.connect("acp-app");
    expect(server.refused()).toBe(0);
    const raw = await mcp.call("acp-app", "whoami", {}) as { content: { text: string }[] };
    expect(JSON.parse(raw.content[0]!.text)).toEqual({ authorization: `Bearer ${literal}` });
  } finally {
    await mcp.close();
    await server.close();
  }
});

test("An app's SSE server, bad URL, or PATH variable is refused with a note and no value", () => {
  const secret = "value-that-must-not-show-1234";
  const found = clientServers([
    { type: "sse", name: "events", url: "http://127.0.0.1:1/sse", headers: [{ name: "Authorization", value: secret }] },
    { type: "http", name: "remote", url: `http://203.0.113.9/mcp?k=${secret}`, headers: [] },
    { type: "http", name: "userinfo", url: `https://user:${secret}@example.com/mcp`, headers: [] },
    { name: "path", command, args: [], env: [{ name: "PATH", value: secret }] },
    { name: "preload", command, args: [], env: [{ name: "DYLD_INSERT_LIBRARIES", value: secret }] },
    { name: "relative", command: "app-mcp", args: [], env: [] },
    { type: "acp", name: "pipe", serverId: "1" },
    { type: "http", name: "app", url: "http://127.0.0.1:2/mcp", headers: [{ name: "Host", value: secret }] },
    { type: "http", name: "bad name!", url: "http://127.0.0.1:3/mcp", headers: [] },
  ], on);
  expect(found.definitions).toEqual([]);
  expect(found.secrets).toEqual([]);
  expect(found.notes).toEqual([
    "[acp] The app's MCP server acp-events is not connected: SSE is not supported.",
    "[acp] The app's MCP server acp-remote is not connected: HTTPS required outside this computer and your network.",
    "[acp] The app's MCP server acp-userinfo is not connected: invalid URL.",
    "[acp] The app's MCP server acp-path is not connected: PATH cannot be set.",
    "[acp] The app's MCP server acp-preload is not connected: DYLD_INSERT_LIBRARIES cannot be set.",
    "[acp] The app's MCP server acp-relative is not connected: the command must be an absolute path.",
    "[acp] The app's MCP server acp-pipe is not connected: unsupported transport.",
    "[acp] The app's MCP server acp-app is not connected: the connection sets Host.",
    "[acp] The app's MCP server number 9 is not connected: invalid name.",
  ]);
  expect(found.notes.join("\n")).not.toContain(secret);
  // More than eight, and a name used twice, are refused too.
  const many = clientServers(Array.from({ length: 10 }, (_, i) => ({ name: `s${i % 9}`, command, args: [], env: [] })), on);
  expect(many.definitions.map((definition) => definition.name)).toEqual(["acp-s0", "acp-s1", "acp-s2", "acp-s3", "acp-s4", "acp-s5", "acp-s6", "acp-s7"]);
  expect(many.notes.slice(8)).toEqual([
    "[acp] The app's MCP server acp-s8 is not connected: at most 8 servers.",
    "[acp] The app's MCP server acp-s0 is not connected: another server has that name.",
  ]);
  // acp_mcp off: nothing connects, and the note says why.
  const off = clientServers([{ type: "http", name: "app", url: "http://127.0.0.1:4/mcp", headers: [] }], { home: HOME, setting: "off" });
  expect(off).toEqual({ definitions: [], secrets: [], notes: ["[acp] The app's MCP server acp-app is not connected: acp_mcp is off."] });
});

test("An app's server never replaces a server of the same name from your files", () => {
  const own: MCPServerDefinition = { name: "acp-app", source: "/home/.casper/mcp.json", scope: "user", cwd: HOME, disabled: false,
    transport: { type: "stdio", command, args: [], env: {} } };
  const { definitions } = clientServers([
    { type: "http", name: "app", url: "http://127.0.0.1:5/mcp", headers: [] },
    { type: "http", name: "other", url: "http://127.0.0.1:6/mcp", headers: [] },
  ], on);
  const merged = withClientServers(definitions)({ servers: [own], diagnostics: ["earlier note"] });
  expect(merged.servers.map((server) => [server.name, server.scope])).toEqual([["acp-app", "user"], ["acp-other", "client"]]);
  expect(merged.servers[0]).toEqual(own);
  expect(merged.diagnostics).toEqual(["earlier note", "acp-app: the app's server is not used: a file Casper reads has a server of that name."]);
});

test("clientAsks counts only for a loopback or stdio server and only with acp_mcp on", () => {
  const asks = { _meta: { "casper/clientAsks": true } };
  const entries = [
    { type: "http", name: "loop", url: "http://127.0.0.1:7/mcp", headers: [], ...asks },
    { type: "http", name: "local", url: "http://localhost:7/mcp", headers: [], ...asks },
    { type: "http", name: "six", url: "http://[::1]:7/mcp", headers: [], ...asks },
    { type: "http", name: "lan", url: "http://192.168.1.20:7/mcp", headers: [], ...asks },
    { type: "http", name: "far", url: "https://mcp.example.com/mcp", headers: [], ...asks },
    { name: "program", command, args: [], env: [], ...asks },
    { type: "http", name: "plain", url: "http://127.0.0.1:8/mcp", headers: [] },
    { type: "http", name: "string", url: "http://127.0.0.1:9/mcp", headers: [], _meta: { "casper/clientAsks": "true" } },
  ];
  const asking = (setting: "on" | "ask") => clientServers(entries, { home: HOME, setting }).definitions.filter((definition) => definition.clientAsks).map((definition) => definition.name);
  expect(asking("on")).toEqual(["acp-loop", "acp-local", "acp-six", "acp-program"]);
  // ask: every server connects, and none skips Casper's change box.
  expect(clientServers(entries, { home: HOME, setting: "ask" }).definitions).toHaveLength(entries.length);
  expect(asking("ask")).toEqual([]);
});

test("acp_mcp is read from ~/.casper/config.yaml only: on by default, and a project or profile cannot set it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-acp-mcp-"));
  try {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await mkdir(path.join(home, ".casper/profiles/default"), { recursive: true });
    await mkdir(path.join(project, ".casper"), { recursive: true });
    expect(await readAcpMcpSetting(home)).toBe("on");
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).acpMcp).toBeUndefined();
    await writeFile(path.join(home, ".casper/config.yaml"), "acp_mcp: ask\n");
    expect(await readAcpMcpSetting(home)).toBe("ask");
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).acpMcp).toBe("ask");
    await writeFile(path.join(home, ".casper/config.yaml"), "acp_mcp: off\n");
    expect(await readAcpMcpSetting(home)).toBe("off");
    // A value Casper can't read connects the app's servers with every change asking.
    await writeFile(path.join(home, ".casper/config.yaml"), "acp_mcp: sometimes\n");
    expect(await readAcpMcpSetting(home)).toBe("ask");
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("acp_mcp must be");
    await writeFile(path.join(home, ".casper/config.yaml"), "");
    await writeFile(path.join(project, ".casper/project.yaml"), "acp_mcp: on\n");
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("acp_mcp is a user setting");
    await writeFile(path.join(project, ".casper/project.yaml"), "");
    await writeFile(path.join(home, ".casper/profiles/default/config.yaml"), "acp_mcp: off\n");
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("acp_mcp is set in ~/.casper/config.yaml only");
  } finally { await removeTempDir(root); }
});

describe("servers the app forwards (decision 89)", () => {
  test("An app's stdio server starts in the absolute folder its casper/cwd names, and a relative or project-root one is refused with a note and no value", () => {
    const folder = path.resolve("/srv/app-tools");
    const secret = "value-that-must-not-show-5678";
    const at = (cwd: unknown) => ({ _meta: { "casper/cwd": cwd } });
    const found = clientServers([
      { name: "here", command, args: [], env: [], ...at(folder) },
      { name: "plain", command, args: [], env: [] },
      { name: "relative", command, args: [], env: [{ name: "APP_TOKEN", value: secret }], ...at("tools/app") },
      { name: "root", command, args: [], env: [], ...at("${PROJECT_ROOT}") },
      { name: "tilde", command, args: [], env: [], ...at("~/tools") },
      { name: "number", command, args: [], env: [], ...at(42) },
    ], on);
    expect(found.definitions.map((definition) => [definition.name, definition.cwd])).toEqual([["acp-here", folder], ["acp-plain", HOME]]);
    expect(found.notes.slice(2)).toEqual([
      "[acp] The app's MCP server acp-relative is not connected: cwd must be an absolute path.",
      "[acp] The app's MCP server acp-root is not connected: cwd must be an absolute path.",
      "[acp] The app's MCP server acp-tilde is not connected: cwd must be an absolute path.",
      "[acp] The app's MCP server acp-number is not connected: cwd must be an absolute path.",
    ]);
    expect(found.notes.join("\n")).not.toContain(secret);
    expect(found.secrets).not.toContain(secret);
  });

  test("clientOwned follows casper/clientAsks also with acp_mcp ask, and never for a remote http server", () => {
    const asks = { _meta: { "casper/clientAsks": true } };
    const entries = [
      { type: "http", name: "loop", url: "http://127.0.0.1:7/mcp", headers: [], ...asks },
      { type: "http", name: "local", url: "http://localhost:7/mcp", headers: [], ...asks },
      { type: "http", name: "lan", url: "http://192.0.2.20:7/mcp", headers: [], ...asks },
      { type: "http", name: "far", url: "https://mcp.example.com/mcp", headers: [], ...asks },
      { name: "program", command, args: [], env: [], ...asks },
      { name: "other", command, args: [], env: [] },
      { type: "http", name: "plain", url: "http://127.0.0.1:8/mcp", headers: [] },
    ];
    const owned = (setting: "on" | "ask") => clientServers(entries, { home: HOME, setting }).definitions.filter((definition) => definition.clientOwned).map((definition) => definition.name);
    expect(owned("on")).toEqual(["acp-loop", "acp-local", "acp-program"]);
    // ask brings Casper's change box back, but the server is still the app's own: it may pin and hear the step.
    expect(owned("ask")).toEqual(["acp-loop", "acp-local", "acp-program"]);
    expect(clientServers(entries, { home: HOME, setting: "ask" }).definitions.filter((definition) => definition.clientAsks)).toEqual([]);
  });

  test("A header value's URL-encoded form is also hidden", () => {
    const token = "tok/en+=?&1234";
    const found = clientServers([
      { type: "http", name: "app", url: "http://127.0.0.1:9/mcp", headers: [{ name: "Authorization", value: `Bearer ${token}` }] },
      { name: "tools", command, args: [], env: [{ name: "APP_TOKEN", value: "plain-value-5678" }] },
    ], on);
    expect(found.secrets).toEqual([`Bearer ${token}`, encodeURIComponent(`Bearer ${token}`), token, encodeURIComponent(token), "plain-value-5678"]);
    // The server's results are hidden with the same values.
    expect(resolvedSecrets(found.definitions[0]!)).toEqual([`Bearer ${token}`, encodeURIComponent(`Bearer ${token}`), token, encodeURIComponent(token)]);
  });

  test("A value with a lone surrogate, which cannot be URL-encoded, connects and is hidden as given", () => {
    const value = "secret-abc-\ud800-xyz";
    const found = clientServers([{ name: "tools", command, args: [], env: [{ name: "APP_TOKEN", value }] }], on);
    expect(found.definitions.map((definition) => definition.name)).toEqual(["acp-tools"]);
    expect(found.secrets).toEqual([value]);
    expect(found.notes).toEqual(["[acp] The app's MCP server acp-tools connects for this session."]);
    expect(resolvedSecrets(found.definitions[0]!)).toEqual([value]);
  });
});

describe("a product Casper already has (decision 100)", () => {
  allowSlowServerStopsOnWindows();
  const cleanup: (() => Promise<unknown>)[] = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

  /** Wait for a condition the manager reaches after an action, never reading it once. */
  async function until(check: () => boolean, what: string): Promise<void> {
    const end = Date.now() + 20_000;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** The app's bundled network server over loopback http, and a home with Casper's own network server installed. */
  async function setUp() {
    const home = await mkdtemp(path.join(os.tmpdir(), "casper-acp-dup-"));
    cleanup.push(() => removeTempDir(home));
    const app = await httpFixture("app-token", { network: { gate: "off" } });
    cleanup.push(() => app.close());
    const { definitions } = clientServers([{ type: "http", name: "network", url: app.url, headers: [{ name: "Authorization", value: "Bearer app-token" }] }], on);
    const own = async (file: string, overrides: Partial<MCPServerDefinition> = {}): Promise<MCPServerDefinition> => {
      await mkdir(path.dirname(file), { recursive: true });
      const command = await fakeServerProgram(file, "fake-network-mcp");
      return { name: "network", source: path.join(home, ".casper/mcp.json"), scope: "user", cwd: home, disabled: false,
        transport: { type: "stdio", command, args: [], env: {} }, ...overrides };
    };
    const notes: string[] = [];
    // The not-used note is for the person (an ACP app shows it, decision 88); other lines go to onNote.
    const personNotes: string[] = [];
    const manager = (servers: MCPServerDefinition[], autoconnect: boolean) => {
      const mcp = new MCPManager({ servers: withClientServers(definitions)({ servers, diagnostics: [] }).servers, diagnostics: [] },
        { timeoutMs: 15_000, homeDir: home, autoconnect, onNote: (text) => notes.push(text), onPersonNote: (text) => personNotes.push(text) });
      cleanup.push(() => mcp.close());
      return mcp;
    };
    return { home, app, own, notes, manager, acpNotes: () => personNotes.filter((note) => note.startsWith("[acp]")) };
  }

  const NOTE = "[acp] The app's MCP server acp-network is not used: Casper has its own Network server.";

  test("Casper's own network server is used and the app's bundled one is not: no tools, no routers line, one note", async () => {
    const { own, home, manager, acpNotes, notes } = await setUp();
    const mcp = manager([await own(networkServerEntry(home).command)], true);
    await mcp.prepare();
    await until(() => mcp.status().every((status) => status.state === "ready"), "both servers to connect");
    expect(mcp.catalog().map((entry) => entry.server)).toEqual(["network"]);
    const status = mcp.status().find((entry) => entry.name === "acp-network")!;
    expect(status.preset?.id).toBe("casper-network-mcp");
    expect(status.notUsed).toBe("Casper has its own Network server");
    expect(mcp.status().find((entry) => entry.name === "network")!.notUsed).toBeUndefined();
    expect(acpNotes()).toEqual([NOTE]);
    expect(notes).not.toContain(NOTE);
    const broker = new CapabilityBroker(mcp, async () => "no", { writesGate: true });
    expect(broker.search("find tool invoke access check", 50).map((found) => found.source)).not.toContain("acp-network");
    const tools = await broker.prepare("check the network");
    const finder = tools.find((tool) => tool.name === "find_capability")!;
    expect(finder.description).toContain("network: Casper's own network server (casper-network-mcp); use it first.");
    expect(finder.description).not.toContain("acp-network");
    expect(finder.description).not.toContain(SEVERAL_ROUTERS_LINE);
    await expect(mcp.call("acp-network", "find_tool", { query: "x" })).rejects.toThrow("server not used: Casper has its own Network server");
    // A later task's prepare writes no second note.
    await broker.prepare("again");
    expect(acpNotes()).toEqual([NOTE]);
  }, childTestLimit(2));

  test("Your own look-alike, known only by its tool list, connecting after the app's still wins, and the note is written once", async () => {
    const { own, home, manager, acpNotes } = await setUp();
    // Not where Casper installs its network server, so only its tool list says what it is; not approved at the start.
    const mcp = manager([await own(path.join(home, "bin/lookalike"))], false);
    await mcp.prepare();
    await until(() => mcp.catalog().some((entry) => entry.server === "acp-network"), "the app's server to connect");
    expect(acpNotes()).toEqual([]);
    const before = mcp.catalogRevision;
    await mcp.connect("network");
    await until(() => !mcp.catalog().some((entry) => entry.server === "acp-network"), "the app's server to leave the catalog");
    expect(mcp.catalog().map((entry) => entry.server)).toEqual(["network"]);
    expect(mcp.catalogRevision).not.toBe(before);
    expect(acpNotes()).toEqual([NOTE]);
    // You disconnect yours: the app's is used again. Connect yours again: not used again, with no second note.
    await mcp.disconnect("network");
    await until(() => mcp.catalog().some((entry) => entry.server === "acp-network"), "the app's server to be used again");
    expect(mcp.status().find((entry) => entry.name === "acp-network")!.notUsed).toBeUndefined();
    await mcp.connect("network");
    await until(() => mcp.catalog().map((entry) => entry.server).join() === "network", "your own server to win again");
    expect(acpNotes()).toEqual([NOTE]);
  }, childTestLimit(3));

  test("The app's server is used, with no note, when yours is disabled, not approved, an unreviewed project server, or another product", async () => {
    const { own, home, manager, acpNotes } = await setUp();
    const entry = networkServerEntry(home).command;
    const cases: [string, MCPServerDefinition, boolean][] = [
      ["disabled", await own(entry, { disabled: true }), true],
      ["not approved (My MCP servers off, not remembered)", await own(entry), false],
      ["an unreviewed project server", await own(entry, { scope: "project", source: path.join(home, "project/.mcp.json") }), true],
      // hpe-networking-mcp, known by its definition: another product, so both are used. It never starts here.
      ["another product", { name: "hpe", source: path.join(home, ".casper/mcp.json"), scope: "user", cwd: home, disabled: false,
        transport: { type: "stdio", command: path.join(home, "bin/hpe-mcp-router"), args: [], env: {} } }, true],
    ];
    for (const [why, definition, autoconnect] of cases) {
      const mcp = manager([definition], autoconnect);
      await mcp.connect("acp-network");
      await until(() => mcp.catalog().some((found) => found.server === "acp-network"), `the app's server to be used (${why})`);
      expect(mcp.status().find((found) => found.name === "acp-network")!.notUsed).toBeUndefined();
      await mcp.close();
    }
    expect(acpNotes()).toEqual([]);
  }, childTestLimit(4));
});
