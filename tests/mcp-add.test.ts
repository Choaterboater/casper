import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CapabilityBroker } from "../src/capabilities/broker";
import { entryText, MCP_ADD_HINT, mcpAddLine, parseMcpAdd, runMcpAdd, splitWords, type McpAdd, type McpAddHost } from "../src/mcp/add";
import { discoverMCPConfiguration, serverEntryProblem } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { formatTaskPrompt, MCP_TYPED } from "../src/task/classify";
import { CHILD_KILL_MS, childTestLimit } from "./support/limits";
import { posixModes } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

/** /mcp add: a server named on one line, written to ~/.casper/mcp.json and connected. Only placeholder servers here. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const network = path.join(import.meta.dir, "fixtures/mcp-network-server.ts");

interface FakeHost extends McpAddHost { output: string; connected: string[]; manager?: MCPManager }

/** The add's host: the files under a fresh home, and a connect that starts the written server for real. */
async function addHost(files: { casper?: unknown; claude?: unknown } = {}, connectError?: string): Promise<FakeHost> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-add-"));
  cleanup.push(() => removeTempDir(homeDir));
  await mkdir(path.join(homeDir, ".casper"), { recursive: true });
  if (files.casper) await writeFile(path.join(homeDir, ".casper/mcp.json"), JSON.stringify(files.casper));
  if (files.claude) await writeFile(path.join(homeDir, ".claude.json"), JSON.stringify(files.claude));
  const configured = async () => (await discoverMCPConfiguration({ projectRoot: homeDir, homeDir, platform: "linux" })).servers;
  const host: FakeHost = {
    homeDir, output: "", connected: [], configured,
    write: (text) => { host.output += text; },
    connect: async (name) => {
      host.connected.push(name);
      if (connectError) return { ok: false, message: connectError };
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
const servers = async (home: string) => JSON.parse(await readFile(path.join(home, ".casper/mcp.json"), "utf8")).mcpServers;

test("the words are split as a shell splits them, nothing expanded; the /mcp add line Casper says reads back the same", () => {
  expect(splitWords("example npx -y example-mcp@1.4.2 mcp")).toEqual(["example", "npx", "-y", "example-mcp@1.4.2", "mcp"]);
  expect(splitWords(`docs node "/srv/my docs/server.js" --label 'a b' "say \\"hi\\""`)).toEqual(["docs", "node", "/srv/my docs/server.js", "--label", "a b", 'say "hi"']);
  // A Windows path keeps its backslashes, and ${NAME} stays for the connection to fill in.
  expect(splitWords("win C:\\tools\\mcp.exe --token ${DOCS_TOKEN}")).toEqual(["win", "C:\\tools\\mcp.exe", "--token", "${DOCS_TOKEN}"]);
  expect(splitWords("x 'not closed")).toBeUndefined();
  const add: McpAdd = { name: "docs", entry: { command: "node", args: ["/srv/my docs/server.js", "it's", "", "plain"] } };
  expect(mcpAddLine(add)).toBe(`/mcp add docs node '/srv/my docs/server.js' "it's" '' plain`);
  expect(parseMcpAdd(mcpAddLine(add).replace(/^\/mcp add /, ""))).toEqual(add);
});

test("/mcp add takes a name and a command with its words, or a name and an address; a bad one says why", () => {
  expect(parseMcpAdd("example npx -y example-mcp@1.4.2 mcp")).toEqual({ name: "example", entry: { command: "npx", args: ["-y", "example-mcp@1.4.2", "mcp"] } });
  expect(parseMcpAdd("docs https://mcp.example.com/mcp")).toEqual({ name: "docs", entry: { url: "https://mcp.example.com/mcp" } });
  expect(parseMcpAdd("local http://127.0.0.1:8931/mcp")).toEqual({ name: "local", entry: { url: "http://127.0.0.1:8931/mcp" } });
  for (const words of ["", "example"]) expect(parseMcpAdd(words)).toEqual({ error: "usage" });
  for (const [words, error] of [
    ["-rf npx thing", "A server name is letters"],
    ["two/parts npx thing", "A server name is letters"],
    ["docs http://mcp.example.com/mcp", "must be https://"],
    ["docs https://user:pw@mcp.example.com/mcp", "can't hold a user name"],
    ["docs https://mcp.example.com/mcp --extra", "takes nothing after it"],
    ["gh https://github.com/example/example-mcp", "That is a GitHub page, not a server's address"],
    ["docs 'npx", "A quote isn't closed."],
    ["docs npx\u0007bell", "can't be used"],
  ] as const) expect((parseMcpAdd(words) as { error: string }).error).toContain(error);
});

test("plain http:// works for this computer and your own network; a public or cloud-metadata address still needs https://", () => {
  for (const url of ["http://192.168.0.10:8080/mcp", "http://10.0.0.5/mcp", "http://172.16.4.2:9000/mcp", "http://100.64.0.7/mcp",
    "http://[fd00::5]:8080/mcp", "http://nas.local:8080/mcp", "http://switch.lan/mcp", "http://hub.home.arpa/mcp", "http://localhost:8931/mcp"]) {
    expect(parseMcpAdd(`net ${url}`)).toEqual({ name: "net", entry: { url } });
    expect(serverEntryProblem("net", { url })).toBeUndefined();
  }
  for (const url of ["http://169.254.169.254/mcp", "http://8.8.8.8/mcp", "http://172.32.0.1/mcp", "http://metadata.google.internal/mcp", "http://mcp.example.com/mcp"]) {
    expect((parseMcpAdd(`net ${url}`) as { error: string }).error).toContain("must be https://");
    expect(serverEntryProblem("net", { url })).toBe("HTTPS required outside this computer and your network");
  }
});

test("an address typed without http:// or https:// says what to type instead of trying to run it", () => {
  for (const target of ["192.168.0.10:8080", "192.168.0.10:8080/mcp", "nas.local:8080", "localhost:8931"]) {
    const error = (parseMcpAdd(`lab ${target}`) as { error: string }).error;
    expect(error).toContain("an address");
    expect(error).toContain(`/mcp add lab http://${target}`);
  }
  // A program name or a path is still a command.
  expect(parseMcpAdd("net node server.js")).toEqual({ name: "net", entry: { command: "node", args: ["server.js"] } });
  expect(parseMcpAdd("net C:\\tools\\net.exe")).toMatchObject({ name: "net", entry: { args: [] } });
});

test("add writes the entry where Casper reads it (0600), starts the server and says each step", async () => {
  const host = await addHost();
  const add: McpAdd = { name: "net", entry: { command: process.execPath, args: [network] } };
  expect(await runMcpAdd(host, add)).toBe("added");
  expect((await servers(host.homeDir)).net).toEqual({ command: process.execPath, args: [network], env: {} });
  if (posixModes) expect((await stat(path.join(host.homeDir, ".casper/mcp.json"))).mode & 0o777).toBe(0o600);
  expect(host.connected).toEqual(["net"]);
  expect(host.manager!.status()[0]).toMatchObject({ name: "net", state: "ready", toolCount: 3 });
  expect(host.output).toBe(`[mcp] Added net to ~/.casper/mcp.json: ${entryText(add.entry)}. Starting it…\n`);
}, childTestLimit());

test("a name a server already has, in ~/.casper/mcp.json or a file Casper imports, is refused before anything is written", async () => {
  const mine = { mcpServers: { net: { command: "node", args: ["/srv/old.js"] } } };
  const host = await addHost({ casper: mine });
  expect(await runMcpAdd(host, { name: "net", entry: { command: "npx", args: ["-y", "other@1.0.0"] } })).toBe("exists");
  expect(host.output).toBe(`[mcp] net is already a server (${path.join(host.homeDir, ".casper/mcp.json")}). Pick another name. Nothing changed.\n`);
  expect(await servers(host.homeDir)).toEqual(mine.mcpServers);
  const imported = await addHost({ claude: { mcpServers: { lab: { command: "node", args: ["/srv/lab.js"] } } } });
  expect(await runMcpAdd(imported, { name: "lab", entry: { command: "npx", args: ["-y", "lab@1.0.0"] } })).toBe("exists");
  expect(imported.output).toContain("lab is already a server");
  expect(imported.connected).toEqual([]);
  await expect(stat(path.join(imported.homeDir, ".casper/mcp.json"))).rejects.toThrow();
});

test("an address is written as an HTTP server that loads; one that didn't start keeps its entry and says what to type", async () => {
  const host = await addHost({}, "fetch failed");
  expect(await runMcpAdd(host, { name: "docs", entry: { url: "https://mcp.example.com/mcp" } })).toBe("failed");
  expect((await servers(host.homeDir)).docs).toEqual({ type: "http", url: "https://mcp.example.com/mcp" });
  expect((await host.configured()).find((entry) => entry?.name === "docs")?.transport).toEqual({ type: "http", url: "https://mcp.example.com/mcp", headers: {} });
  expect(host.output).toBe("[mcp] Added docs to ~/.casper/mcp.json: https://mcp.example.com/mcp. Starting it…\n"
    + "[mcp] docs is in ~/.casper/mcp.json but didn't start: fetch failed.\nFix that, then type /mcp connect docs.\n");
});

test("the AI is told the exact line to type for an MCP server, only in a request that names MCP, and so is find_capability", async () => {
  const model = { commands: {} } as never;
  const classification = { intent: "configure", mode: "modify", verification: [] } as never;
  const asked = formatTaskPrompt("add the example MCP server, it starts with npx -y example-mcp@1.4.2 mcp", classification, model);
  expect(asked).toContain(`- ${MCP_TYPED}`);
  expect(MCP_TYPED).toBe("MCP servers: to add one, call casper_mcp_add (it asks the user first; if it can't, it says the /mcp add line "
    + "to type). To connect one Casper lists, the user types /mcp connect <name>: you can't run / commands.");
  expect(formatTaskPrompt("fix the login bug", classification, model)).not.toContain("/mcp");
  // A change Casper will review and prove gets the request as written, plus this one line when it names MCP.
  const proving = { proveChange: true, reviewFollows: true };
  const general = { intent: "general", mode: "modify", verification: [] } as never;
  expect(formatTaskPrompt("fix the login bug", general, model, proving)).toBe("fix the login bug");
  expect(formatTaskPrompt("connect my mcp server", general, model, proving)).toBe(`${MCP_TYPED}\nUser request:\nconnect my mcp server`);
  const manager = new MCPManager({ servers: [{ name: "lab", source: "fixture", cwd: os.tmpdir(), disabled: false,
    transport: { type: "stdio", command: process.execPath, args: [network], env: {} } }], diagnostics: [] });
  cleanup.push(() => manager.close());
  const find = (await new CapabilityBroker(manager).prepare("status")).find((tool) => tool.name === "find_capability");
  expect(find?.description).toContain("If nothing is connected, ask the user to type /mcp connect <name>, or /mcp add <name> <command> [args…] for a new server.");
  expect(MCP_ADD_HINT).toContain("/mcp add <name> <command> [args…], such as /mcp add docs npx -y @example/docs-mcp@1.2.0");
});
