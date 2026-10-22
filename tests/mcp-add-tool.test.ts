import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MCP_ADD_YES, mcpAddTool, type McpAddToolHost } from "../src/mcp/add-tool";
import { discoverMCPConfiguration, type MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { runnerPin, versionLine } from "../src/mcp/presets";
import { CHILD_KILL_MS, childTestLimit } from "./support/limits";
import { removeTempDir } from "./support/temp-dir";

/** casper_mcp_add: the AI adds an MCP server only after the person's yes in a box that shows the exact command and
 * version. Placeholder packages and repositories only; the one server started is Casper's own test fixture. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const network = path.join(import.meta.dir, "fixtures/mcp-network-server.ts");
const COMMIT = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

interface FakeHost extends McpAddToolHost { said: string; told: string; asked: Array<{ preview: string; question: string }>; connected: string[]; manager?: MCPManager }

/** The tool's host under a fresh home: `answer` is the person's yes (true) or no; connect starts the written server. */
async function toolHost(options: { canAsk?: boolean; answer?: boolean; casper?: unknown } = {}): Promise<FakeHost> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-tool-"));
  cleanup.push(() => removeTempDir(homeDir));
  await mkdir(path.join(homeDir, ".casper"), { recursive: true });
  if (options.casper) await writeFile(path.join(homeDir, ".casper/mcp.json"), JSON.stringify(options.casper));
  const configured = async () => (await discoverMCPConfiguration({ projectRoot: homeDir, homeDir, platform: "linux" })).servers;
  const host: FakeHost = {
    homeDir, said: "", told: "", asked: [], connected: [], configured,
    write: (text) => { host.said += text; },
    tell: (text) => { host.told += text; },
    canAsk: () => options.canAsk ?? true,
    confirm: async (preview, question) => { host.asked.push({ preview, question }); return options.answer ?? false; },
    connect: async (name) => {
      host.connected.push(name);
      const definition = (await configured()).find((entry) => entry.name === name)!;
      const manager = new MCPManager({ servers: [definition], diagnostics: [] }, { connectTimeoutMs: CHILD_KILL_MS, callTimeoutMs: 5000, homeDir });
      cleanup.push(() => manager.close());
      host.manager = manager;
      await manager.connect(name);
      const status = manager.status().find((entry) => entry.name === name);
      return status?.state === "ready" ? { ok: true } : { ok: false, ...(status?.error ? { message: status.error } : {}) };
    },
    describe: (name) => {
      const status = host.manager?.status().find((entry) => entry.name === name);
      return status && `${status.toolCount} tools · writes ${status.writes}`;
    },
  };
  return host;
}
const fileExists = (home: string) => stat(path.join(home, ".casper/mcp.json")).then(() => true, () => false);
const stdio = (command: string, args: string[]): MCPServerDefinition => ({ name: "x", source: "test", cwd: "", disabled: false, transport: { type: "stdio", command, args, env: {} } });

test("the box shows the exact name, command, words and version before anything happens; No writes and starts nothing", async () => {
  const host = await toolHost({ answer: false });
  const result = await mcpAddTool(host).execute({ name: "example", command: "npx", args: ["-y", `github:example/example-mcp#${COMMIT}`] });
  expect(host.asked).toEqual([{
    preview: "The AI wants to add an MCP server and start it now:\n"
      + "  name     example\n"
      + `  runs     npx -y github:example/example-mcp#${COMMIT}\n`
      + `  version  commit ${COMMIT} (pinned)\n`
      + "It goes in ~/.casper/mcp.json, so it starts again each session, outside the sandbox, with your permissions.\n",
    question: "Add example and start it?",
  }]);
  expect(result).toEqual({ text: "Not added: the user said no. Nothing was written or started.", isError: true });
  expect(await fileExists(host.homeDir)).toBe(false);
  expect(host.connected).toEqual([]);
  expect(MCP_ADD_YES).toBe("Yes, add it and start it");
});

test("a yes writes the server to ~/.casper/mcp.json and starts it, as /mcp add does, and the AI hears what it has", async () => {
  const host = await toolHost({ answer: true });
  const result = await mcpAddTool(host).execute({ name: "net", command: process.execPath, args: [network] });
  expect(host.asked[0]!.preview).toContain("  version  none: a program on this computer\n");
  expect(result).toEqual({ text: "Added net to ~/.casper/mcp.json and started it (3 tools · writes off). Find its tools with find_capability." });
  expect(JSON.parse(await readFile(path.join(host.homeDir, ".casper/mcp.json"), "utf8")).mcpServers.net).toEqual({ command: process.execPath, args: [network], env: {} });
  expect(host.said).toContain("[mcp] Added net to ~/.casper/mcp.json: ");
}, childTestLimit());

test("a run that can't ask writes nothing and says the /mcp add line for the person to type", async () => {
  const host = await toolHost({ canAsk: false, answer: true });
  const result = await mcpAddTool(host).execute({ name: "example", command: "npx", args: ["-y", "@example/example-mcp@1.4.2"] });
  expect(host.asked).toEqual([]);
  expect(host.told).toBe("[mcp] The AI wanted to add example, and this run can't ask you, so nothing was added. To add it, type this in a Casper session:\n"
    + "  /mcp add example npx -y @example/example-mcp@1.4.2\n");
  expect(result).toEqual({ text: "Not added: this run can't ask the user. Tell them to type this in a Casper session: /mcp add example npx -y @example/example-mcp@1.4.2", isError: true });
  expect(await fileExists(host.homeDir)).toBe(false);
});

test("a name a server already has, or arguments that can't be a server, are refused before any box", async () => {
  const taken = await toolHost({ answer: true, casper: { mcpServers: { net: { command: "node", args: ["/srv/old.js"] } } } });
  expect(await mcpAddTool(taken).execute({ name: "net", command: "npx", args: ["-y", "other@1.0.0"] }))
    .toEqual({ text: "Not added: net is already a server. Pick another name.", isError: true });
  const host = await toolHost({ answer: true });
  const tool = mcpAddTool(host);
  for (const [args, error] of [
    [{ name: "example", command: "npx", url: "https://mcp.example.com/mcp" }, "give either command (with args) or url, not both"],
    [{ name: "example" }, "give either command (with args) or url, not both"],
    [{ name: "ex/ample", command: "npx", args: [] }, "A server name is letters"],
    [{ name: "example", url: "http://mcp.example.com/mcp" }, "must be https://"],
    [{ name: "example", url: "https://github.com/example/example-mcp" }, "That is a GitHub page"],
    [{ name: "example", command: "npx", args: ["-y", 3] }, "args must be a list of strings"],
    [{ name: "example", command: "npx", args: ["a\nb"] }, "can't be used"],
  ] as const) {
    const result = await tool.execute(args as unknown as Record<string, unknown>);
    expect({ args, isError: result.isError, said: result.text.includes(error) }).toEqual({ args, isError: true, said: true });
  }
  expect(host.asked).toEqual([]);
  expect(await fileExists(host.homeDir)).toBe(false);
});

test("the version line says the pinned version, commit or digest, a tag that can move, or that nothing is pinned", () => {
  const image = `ghcr.io/example/example-mcp@sha256:${"a".repeat(64)}`;
  for (const [command, args, line] of [
    ["npx", ["-y", "example-mcp@1.4.2", "mcp"], "example-mcp@1.4.2 (pinned)"],
    ["npx", ["-y", "example-mcp", "mcp"], "not pinned: npx fetches the newest example-mcp each time it starts"],
    ["npx", ["-y", `github:example/example-mcp#${COMMIT}`], `commit ${COMMIT} (pinned)`],
    ["npx", ["-y", "github:example/example-mcp#v1.2.0"], "v1.2.0, a tag or branch (not pinned: it can be moved; a commit can't)"],
    ["npx", ["-y", "github:example/example-mcp"], "not pinned: npx fetches the newest commit each time it starts"],
    ["uvx", ["example-mcp==1.4.2"], "example-mcp==1.4.2 (pinned)"],
    ["uvx", ["--from", "git+https://github.com/example/example-mcp@1a2b3c4", "example-mcp"], "commit 1a2b3c4 (pinned)"],
    ["uvx", ["--from", "git+https://github.com/example/example-mcp@v1.2.0", "example-mcp"], "v1.2.0, a tag or branch (not pinned: it can be moved; a commit can't)"],
    ["docker", ["run", "-i", "--rm", "ghcr.io/example/example-mcp:1.4.2"], "image tag 1.4.2 (pinned)"],
    ["docker", ["run", "-i", "--rm", image], `image digest sha256:${"a".repeat(12)}… (pinned)`],
    ["docker", ["run", "-i", "--rm", "ghcr.io/example/example-mcp"], "not pinned: docker fetches the newest image each time it starts"],
    ["node", ["/srv/example/server.js"], "none: a program on this computer"],
  ] as const) expect({ command, args, line: versionLine(stdio(command, [...args])) }).toEqual({ command, args, line });
  expect(versionLine({ ...stdio("x", []), transport: { type: "http", url: "https://mcp.example.com/mcp", headers: {} } }))
    .toBe("none: a server at an address, nothing runs on this computer");
  // A commit from GitHub is as fixed as a version, so such a server can be remembered; a tag can be moved, so it can't.
  expect(runnerPin(stdio("npx", ["-y", `github:example/example-mcp#${COMMIT}`]))?.pinned).toBe(true);
  expect(runnerPin(stdio("npx", ["-y", "github:example/example-mcp#v1.2.0"]))?.pinned).toBe(false);
});
