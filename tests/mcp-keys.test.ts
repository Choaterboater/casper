import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import os from "node:os";
import path from "node:path";
import { mcpAddLine, parseMcpAdd, runMcpAdd, type McpAddHost } from "../src/mcp/add";
import { mcpAddTool, type McpAddToolHost } from "../src/mcp/add-tool";
import { discoverMCPConfiguration, type MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { getsServerKey, savedKeyValues, saveServerKey, secretsFile, serverKeyFor } from "../src/mcp/server-secrets";
import { PRIVATE_PATHS } from "../src/platform/project-paths";
import { fixtureServer } from "./fixtures/mcp-server";
import { CHILD_KILL_MS, childTestLimit } from "./support/limits";
import { posixModes } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

/** A bearer token, an API key or a secret variable for your own MCP server: typed hidden, kept out of mcp.json and the
 * AI's sight, and sent only to that server. Placeholder servers and tokens only. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const TOKEN = "tok-placeholder-0123456789";
const network = path.join(import.meta.dir, "fixtures/mcp-network-server.ts");

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-keys-"));
  cleanup.push(() => removeTempDir(dir));
  await mkdir(path.join(dir, ".casper"), { recursive: true });
  return dir;
}

/** An HTTP MCP server on this computer that records the headers of every request. */
async function headerServer(): Promise<{ url: string; seen: IncomingHttpHeaders[] }> {
  const { createServer } = await import("node:http");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
  const fixture = fixtureServer("generic");
  await fixture.connect(transport);
  const seen: IncomingHttpHeaders[] = [];
  const http = createServer(async (request, response) => { seen.push(request.headers); await transport.handleRequest(request, response); });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { await fixture.close(); http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  return { url: `http://127.0.0.1:${address.port}/mcp`, seen };
}

interface Host extends McpAddHost { output: string; asked: string[]; manager?: MCPManager }
function addHost(homeDir: string, typed: string | undefined): Host {
  const configured = async () => (await discoverMCPConfiguration({ projectRoot: path.join(homeDir, "repo"), homeDir, platform: "linux" })).servers;
  const host: Host = {
    homeDir, output: "", asked: [], configured,
    write: (text) => { host.output += text; },
    privateInput: async (label) => { host.asked.push(label); return typed; },
    connect: async (name) => {
      const definition = (await configured()).find((entry) => entry.name === name)!;
      const manager = new MCPManager({ servers: [definition], diagnostics: [] }, { connectTimeoutMs: CHILD_KILL_MS, callTimeoutMs: 5000, homeDir });
      cleanup.push(() => manager.close());
      host.manager = manager;
      await manager.connect(name);
      const status = manager.status().find((entry) => entry.name === name);
      return status?.state === "ready" ? { ok: true } : { ok: false, ...(status?.error ? { message: status.error } : {}) };
    },
  };
  return host;
}

test("/mcp add takes --bearer or --api-key for an address and --key-env for a program; the line Casper says reads back the same", () => {
  expect(parseMcpAdd("docs --bearer https://mcp.example.com/mcp")).toEqual({ name: "docs", key: { kind: "bearer" }, entry: { url: "https://mcp.example.com/mcp" } });
  expect(parseMcpAdd("docs --api-key https://mcp.example.com/mcp")).toEqual({ name: "docs", key: { kind: "api-key", header: "X-API-Key" }, entry: { url: "https://mcp.example.com/mcp" } });
  expect(parseMcpAdd("docs --api-key=X-Token https://mcp.example.com/mcp")).toMatchObject({ key: { kind: "api-key", header: "X-Token" } });
  const program = parseMcpAdd("docs --key-env=DOCS_KEY npx -y example-mcp@1.2.0 --bearer");
  // Words after the command are the program's own, even one that looks like Casper's flag.
  expect(program).toEqual({ name: "docs", key: { kind: "env", name: "DOCS_KEY" }, entry: { command: "npx", args: ["-y", "example-mcp@1.2.0", "--bearer"] } });
  for (const add of [program, parseMcpAdd("docs --api-key=X-Token https://mcp.example.com/mcp")]) {
    if ("error" in add) throw new Error(add.error);
    expect(parseMcpAdd(mcpAddLine(add).replace(/^\/mcp add /, ""))).toEqual(add);
  }
  for (const [words, error] of [
    ["docs --bearer npx -y example-mcp@1.2.0", "--key-env"],
    ["docs --key-env=DOCS_KEY https://mcp.example.com/mcp", "not --key-env"],
    ["docs --key-env=PATH npx example-mcp@1.2.0", "can't be a key's variable"],
    ["docs --key-env=NODE_OPTIONS npx example-mcp@1.2.0", "can't be a key's variable"],
    ["docs --api-key=Host https://mcp.example.com/mcp", "can't be an API key header"],
    ["docs --bearer --api-key https://mcp.example.com/mcp", "one key"],
    ["docs --token https://mcp.example.com/mcp", "--bearer, --api-key"],
    ["docs --bearer", "usage"],
  ] as const) {
    const parsed = parseMcpAdd(words) as { error: string };
    expect(parsed.error, words).toContain(error);
  }
});

test("a bearer token is asked hidden, kept out of mcp.json in a private file, and sent to that server when it connects", async () => {
  const dir = await home();
  const server = await headerServer();
  const host = addHost(dir, TOKEN);
  const add = parseMcpAdd(`lab --bearer ${server.url}`);
  if ("error" in add) throw new Error(add.error);
  expect(await runMcpAdd(host, add)).toBe("added");
  expect(host.asked).toEqual(["Bearer token for lab"]);
  expect(await readFile(path.join(dir, ".casper/mcp.json"), "utf8")).not.toContain(TOKEN);
  expect(JSON.parse(await readFile(path.join(dir, ".casper/mcp.json"), "utf8")).mcpServers.lab).toEqual({ type: "http", url: server.url });
  expect(await readFile(secretsFile(dir), "utf8")).toContain(TOKEN);
  if (posixModes) expect((await stat(secretsFile(dir))).mode & 0o777).toBe(0o600);
  expect(server.seen.length).toBeGreaterThan(0);
  expect(server.seen.every((headers) => headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  // Plain http: the person is told the token crosses the network unencrypted, before typing it.
  expect(host.output).toContain("lab's bearer token goes to 127.0.0.1 over plain http, unencrypted");
  expect(host.output).not.toContain(TOKEN);
  expect(savedKeyValues(dir)).toEqual([TOKEN]);
  expect(host.manager!.loginValues("lab")).toContain(TOKEN);
}, childTestLimit());

test("an API key goes in its header, and an https server gets no plain-http warning", async () => {
  const dir = await home();
  const host = addHost(dir, TOKEN);
  const add = parseMcpAdd("docs --api-key=X-Token https://mcp.example.com/mcp");
  if ("error" in add) throw new Error(add.error);
  host.connect = async () => ({ ok: true });
  expect(await runMcpAdd(host, add)).toBe("added");
  expect(host.asked).toEqual(["API key (X-Token header) for docs"]);
  expect(host.output).not.toContain("plain http");
  const definition = (await host.configured()).find((entry) => entry?.name === "docs")!;
  expect(await serverKeyFor(definition, dir)).toEqual({ headers: { "X-Token": TOKEN }, env: {} });
});

test("a program's key goes in its own variable when it starts", async () => {
  const dir = await home();
  const host = addHost(dir, TOKEN);
  // The fixture's get_env names MIST_ variables it started with.
  const add = parseMcpAdd(`net --key-env=MIST_TEST_KEY ${JSON.stringify(process.execPath)} ${JSON.stringify(network)}`);
  if ("error" in add) throw new Error(add.error);
  const file = path.join(dir, ".casper/mcp.json");
  expect(await runMcpAdd({ ...host, connect: async () => ({ ok: true }) }, add)).toBe("added");
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.mcpServers.net.env = { FIXTURE_ENV_DUMP: "1" };
  await writeFile(file, JSON.stringify(saved));
  expect(await host.connect("net")).toEqual({ ok: true });
  const result = await host.manager!.call("net", "get_env", {});
  expect(JSON.stringify(result)).toContain(`\\"MIST_TEST_KEY\\":\\"${TOKEN}\\"`);
  // Its value is hidden wherever this server's results reach the AI.
  expect(host.manager!.loginValues("net")).toContain(TOKEN);
  expect(await readFile(file, "utf8")).not.toContain(TOKEN);
}, childTestLimit());

test("nothing typed adds nothing; a server added without a key forgets an old key of that name", async () => {
  const dir = await home();
  const host = addHost(dir, undefined);
  const add = parseMcpAdd("docs --bearer https://mcp.example.com/mcp");
  if ("error" in add) throw new Error(add.error);
  expect(await runMcpAdd(host, add)).toBe("failed");
  expect(host.output).toContain("No bearer token typed. Nothing changed.");
  expect(await stat(path.join(dir, ".casper/mcp.json")).then(() => true, () => false)).toBe(false);
  await saveServerKey(dir, "docs", { kind: "bearer" }, TOKEN);
  const plain = parseMcpAdd("docs https://mcp.example.com/mcp");
  if ("error" in plain) throw new Error(plain.error);
  expect(await runMcpAdd({ ...host, connect: async () => ({ ok: true }) }, plain)).toBe("added");
  expect(savedKeyValues(dir)).toEqual([]);
});

test("only your own ~/.casper/mcp.json server of that name gets the key: never a project's, a profile's or an imported one", async () => {
  const dir = await home();
  const own = path.join(dir, ".casper", "mcp.json");
  const base: MCPServerDefinition = { name: "docs", source: own, scope: "user", cwd: "", disabled: false, transport: { type: "http", url: "https://mcp.example.com/mcp", headers: {} } };
  expect(getsServerKey(base, dir)).toBe(true);
  for (const other of [
    { ...base, scope: "project" as const, source: path.join(dir, "repo", ".mcp.json") },
    { ...base, scope: "profile" as const, source: path.join(dir, ".casper/profiles/work/mcp.json") },
    { ...base, scope: "imported" as const, importedFrom: "claude" as const, source: path.join(dir, ".claude.json") },
  ]) expect(getsServerKey(other, dir)).toBe(false);
  await saveServerKey(dir, "docs", { kind: "bearer" }, TOKEN);
  expect(await serverKeyFor({ ...base, scope: "project", source: path.join(dir, "repo", ".mcp.json") }, dir)).toEqual({ headers: {}, env: {} });
  expect(PRIVATE_PATHS).toContain(".casper/mcp-secrets.json");
});

test("asked in chat, the AI names only the kind of key; the box says you type it next, and a run that can't ask gives the flag", async () => {
  const dir = await home();
  const asked: string[] = [];
  let told = "";
  const base: McpAddToolHost = {
    homeDir: dir, configured: async () => [], connect: async () => ({ ok: true }), write: () => {},
    privateInput: async () => TOKEN, canAsk: () => true, tell: (text) => { told += text; }, describe: () => "3 tools",
    confirm: async (preview) => { asked.push(preview); return true; },
  };
  const tool = mcpAddTool(base);
  expect(JSON.stringify(tool.inputSchema)).toContain("bearer");
  const result = await tool.execute({ name: "lab", url: "https://mcp.example.com/mcp", key: "bearer" });
  expect(result.isError).toBeUndefined();
  expect(asked[0]).toContain("  key      bearer token: you type it next, hidden; the AI never sees it");
  expect(result.text).not.toContain(TOKEN);
  expect(savedKeyValues(dir)).toEqual([TOKEN]);
  expect((await mcpAddTool(base).execute({ name: "x", url: "https://mcp.example.com/mcp", key: "env:X_KEY" })).text).toContain("not --key-env");
  const cant = await mcpAddTool({ ...base, canAsk: () => false }).execute({ name: "lab2", url: "https://mcp.example.com/mcp", key: "api-key:X-Token" });
  expect(cant.isError).toBe(true);
  expect(told).toContain("/mcp add lab2 --api-key=X-Token https://mcp.example.com/mcp");
});
