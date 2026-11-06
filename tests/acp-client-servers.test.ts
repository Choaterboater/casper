import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration, readAcpMcpSetting } from "../src/config/load";
import { removeTempDir } from "./support/temp-dir";
import { clientServers, withClientServers } from "../src/acp/client-servers";
import { resolvedSecrets, type MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { httpFixture } from "./fixtures/mcp-http-server";
import { CHILD_KILL_MS } from "./support/limits";

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
  // The credential after "Bearer" is hidden on its own too.
  expect(found.secrets).toEqual(["Bearer ${ANTHROPIC_API_KEY}", "${ANTHROPIC_API_KEY}", "${HOME}-literal"]);
  expect(resolvedSecrets(http)).toEqual(["Bearer ${ANTHROPIC_API_KEY}", "${ANTHROPIC_API_KEY}"]);
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
