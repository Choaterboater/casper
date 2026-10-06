import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { MCPServerSandbox, mcpBwrapArgs, sandboxLines, sandboxSummary } from "../src/mcp/sandbox";
import { CENTRAL_TOKEN_HOST, loginHosts, serverProfile } from "../src/mcp/sandbox/profile";
import { HostProxy, parseTarget } from "../src/mcp/sandbox/proxy";
import { needsSandbox } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step().catch(() => {}); });

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-mcp-sandbox-")));
  cleanup.push(() => removeTempDir(root));
  return root;
}

function stdio(name: string, command: string, args: string[] = [], env: Record<string, string> = {}): MCPServerDefinition {
  return { name, source: "test", scope: "user", transport: { type: "stdio", command, args, env } } as MCPServerDefinition;
}

/** A venv where Casper installs casper-network-mcp, with `program` (JavaScript, run by this Bun) as its entry. */
async function fakeVenv(home: string, program: string, entryName = "casper-network-mcp"): Promise<string> {
  const venv = path.join(home, ".casper/tools/casper-network-mcp/venv");
  await mkdir(path.join(venv, "bin"), { recursive: true });
  const bun = await realpath(process.execPath);
  await writeFile(path.join(venv, "pyvenv.cfg"), `home = ${path.dirname(bun)}\n`);
  await writeFile(path.join(venv, "server.cjs"), program);
  const entry = path.join(venv, "bin", entryName);
  await writeFile(entry, `#!/bin/sh\nexec ${JSON.stringify(bun)} ${JSON.stringify(path.join(venv, "server.cjs"))} "$@"\n`);
  await chmod(entry, 0o755);
  return entry;
}

describe("profiles", () => {
  test("the network server's hosts come from its saved logins; Central adds its token host", () => {
    expect(loginHosts({ MIST_HOST: "https://api.eu.mist.com", MIST_API_TOKEN: "x" })).toEqual(["api.eu.mist.com"]);
    expect(loginHosts({ CENTRAL_BASE_URL: "https://us1.api.central.arubanetworks.com", CLEARPASS_BASE_URL: "https://10.1.2.3:8443" }))
      .toEqual(["us1.api.central.arubanetworks.com", "10.1.2.3", CENTRAL_TOKEN_HOST]);
    expect(loginHosts({})).toEqual([]);
  });

  test("only casper-network-mcp from an installed venv gets a profile; anything else runs as it is", async () => {
    const home = await tempRoot();
    const entry = await fakeVenv(home, "");
    const found = serverProfile(stdio("network", entry), { home, logins: { MIST_HOST: "https://api.mist.com" } });
    expect("profile" in found && found.profile).toMatchObject({
      id: "casper-network-mcp", hosts: ["api.mist.com"], cache: path.join(home, ".cache/casper-network-mcp"),
    });
    expect("profile" in found && found.profile.reads[0]).toBe(path.dirname(path.dirname(entry)));
    expect(serverProfile(stdio("network", "uvx", ["casper-network-mcp"]), { home, logins: {} })).toEqual({ none: "it doesn't run from an installed venv" });
    expect(serverProfile(stdio("other", "/usr/bin/some-mcp"), { home, logins: {} })).toEqual({ none: "Casper doesn't know what it needs" });
    expect(serverProfile(stdio("network", entry, [], { HTTPS_PROXY: "http://proxy:8080" }), { home, logins: {} })).toEqual({ none: "it sets its own proxy" });
    expect(serverProfile({ name: "web", source: "test", transport: { type: "http", url: "https://x.example", headers: {} } } as MCPServerDefinition, { home, logins: {} }))
      .toEqual({ none: "remote" });
  });
});

describe("proxy", () => {
  async function ask(port: number, request: string): Promise<string> {
    return new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
      let text = "";
      socket.on("data", (chunk) => { text += chunk.toString(); if (text.includes("\r\n\r\n")) { socket.destroy(); resolve(text); } });
      socket.on("close", () => resolve(text));
      socket.on("error", () => resolve(text));
    });
  }

  test("lets a listed host through and refuses every other host and plain http", async () => {
    const target = net.createServer((socket) => socket.end("hello"));
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => target.close(resolve)));
    const port = (target.address() as net.AddressInfo).port;
    const refused: string[] = [];
    const proxy = await HostProxy.start({ hosts: ["127.0.0.1"], onRefused: (host) => refused.push(host) });
    cleanup.push(() => proxy.close());
    expect(await ask(proxy.listenPort!, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: x\r\n\r\n`)).toStartWith("HTTP/1.1 200");
    expect(await ask(proxy.listenPort!, "CONNECT example.com:443 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 403");
    expect(await ask(proxy.listenPort!, "CONNECT Example.COM:443 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 403");
    expect(await ask(proxy.listenPort!, "GET http://127.0.0.1/ HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 405");
    expect(refused).toEqual(["example.com"]);
    expect(proxy.refused()).toEqual(["example.com"]);
  });

  test("reads host and port from a CONNECT line", () => {
    expect(parseTarget("api.mist.com:443")).toEqual({ host: "api.mist.com", port: 443 });
    expect(parseTarget("[::1]:8443")).toEqual({ host: "::1", port: 8443 });
    expect(parseTarget("api.mist.com")).toBeUndefined();
    expect(parseTarget("user@host:443")).toBeUndefined();
  });
});

test("Linux: no network of its own, the home folder hidden, its folders bound back, no Unix sockets for the server", async () => {
  const root = await tempRoot();
  const home = path.join(root, "home");
  const venv = path.join(home, "venv");
  const cache = path.join(home, ".cache/x");
  await mkdir(venv, { recursive: true });
  await mkdir(cache, { recursive: true });
  const args = mcpBwrapArgs({ hidden: [home], reads: [venv], writes: [cache], cwd: cache, socat: "/usr/bin/socat", socket: path.join(root, "p.sock"),
    port: 3128, seccomp: "/x/apply-seccomp", command: [path.join(venv, "bin/server"), "--read-only"] });
  expect(args).toContain("--unshare-net");
  const line = args.join(" ");
  expect(line).toContain(`--tmpfs ${home} --ro-bind ${venv} ${venv} --bind ${cache} ${cache}`);
  const script = args.at(-1)!;
  expect(script).toContain("TCP-LISTEN:3128,bind=127.0.0.1");
  expect(script).toMatch(/\nexec \/x\/apply-seccomp .*bin\/server --read-only$/);
});

describe("off switch and /mcp lines", () => {
  test("off is kept per server; a server without a profile can't be switched", async () => {
    const home = await tempRoot();
    const entry = await fakeVenv(home, "");
    const sandbox = new MCPServerSandbox({ home, state: () => ({ kind: "on" }) });
    expect(sandbox.expected(stdio("network", entry))).toEqual({ state: "on" });
    await sandbox.setOn("network", false);
    expect(sandbox.expected(stdio("network", entry))).toMatchObject({ state: "off" });
    expect(await sandbox.hold(stdio("network", entry), { command: entry, args: [], env: {} }, {})).toMatchObject({ open: "off" });
    // Kept: a new session reads it again.
    expect(new MCPServerSandbox({ home, state: () => ({ kind: "on" }) }).expected(stdio("network", entry))).toMatchObject({ state: "off" });
    expect(JSON.parse(await readFile(path.join(home, ".casper/mcp-sandbox.json"), "utf8"))).toEqual({ off: ["network"] });
    await sandbox.setOn("network", true);
    expect(sandbox.expected(stdio("network", entry))).toEqual({ state: "on" });
    const manager = new MCPManager({ servers: [stdio("network", entry), stdio("other", "/usr/bin/true")], diagnostics: [] }, { sandbox });
    await expect(manager.setSandbox("other", false)).rejects.toThrow("has no sandbox profile");
  });

  test("no sandbox here (Windows, --no-sandbox): it runs as before and says why", async () => {
    const home = await tempRoot();
    const entry = await fakeVenv(home, "");
    const sandbox = new MCPServerSandbox({ home, state: () => ({ kind: "unsupported", reason: "Windows" }) });
    expect(await sandbox.hold(stdio("network", entry), { command: entry, args: [], env: {} }, {}))
      .toEqual({ open: "failed", why: "no sandbox here (Windows has no sandbox yet)" });
  });

  test("/mcp says which servers run sandboxed", () => {
    expect(sandboxLines("network", { state: "on", hosts: ["api.mist.com"], refused: ["example.com"] })).toEqual([
      "  sandbox: on · reaches only api.mist.com · writes only its cache · can't read your keys, ~/.casper or projects (/mcp sandbox network off)",
      "  sandbox kept it from reaching: example.com",
    ]);
    expect(sandboxLines("network", { state: "off" })).toEqual(["  sandbox: off for this server (/mcp sandbox network on)"]);
    expect(sandboxLines("other", { state: "none", why: "Casper doesn't know what it needs" })).toEqual([]);
    expect(sandboxSummary([{ name: "network", sandbox: { state: "on" } }, { name: "docs", sandbox: { state: "none" } }, { name: "web" }]))
      .toBe("Sandboxed: network. Run as they are: docs (Casper doesn't know what it needs).");
  });
});

/**
 * A tiny MCP server with three tools that try what a sandboxed server must not do: read a file, write a file and
 * connect to a host. Plain JavaScript with no imports from the repo (the project is hidden from it).
 */
const PROBE_SERVER = `
const fs = require("node:fs");
const net = require("node:net");
const tools = ["read", "write", "connect", "fetch"].map((name) => ({ name, inputSchema: { type: "object" } }));
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const text = (id, value) => reply(id, { content: [{ type: "text", text: String(value) }] });
async function call(id, name, args) {
  try {
    if (name === "read") return text(id, "read:" + fs.readFileSync(args.path, "utf8"));
    if (name === "write") { fs.writeFileSync(args.path, "x"); return text(id, "wrote"); }
    if (name === "connect") return await new Promise((resolve) => {
      const socket = net.connect(args.port, "127.0.0.1", () => { socket.destroy(); resolve(text(id, "connected")); });
      socket.on("error", (error) => resolve(text(id, "error:" + error.code)));
    });
    if (name === "fetch") { const response = await fetch(args.url); return text(id, "status:" + response.status); }
  } catch (error) { return text(id, "error:" + (error.code || error.message)); }
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (message.method === "initialize") reply(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } });
    else if (message.method === "tools/list") reply(message.id, { tools });
    else if (message.method === "tools/call") call(message.id, message.params.name, message.params.arguments || {});
    else if (message.id !== undefined) reply(message.id, {});
  }
});
`;

describe("a real sandbox", () => {
  async function setup() {
    const root = await tempRoot();
    const home = path.join(root, "home");
    await mkdir(path.join(home, ".ssh"), { recursive: true });
    await writeFile(path.join(home, ".ssh/id_test"), "PRIVATE KEY");
    const entry = await fakeVenv(home, PROBE_SERVER);
    // The same program from a folder that is not a venv: no profile.
    const plain = path.join(root, "plain-server");
    await writeFile(plain, await readFile(entry, "utf8"));
    await chmod(plain, 0o755);
    const listener = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => listener.close(resolve)));
    const notes: string[] = [];
    const sandbox = new MCPServerSandbox({ home, note: (line) => notes.push(line) });
    const manager = new MCPManager({ servers: [stdio("network", entry), stdio("plain", plain)], diagnostics: [] }, { sandbox });
    cleanup.push(() => manager.close());
    const text = async (server: string, tool: string, args: Record<string, unknown>) =>
      ((await manager.call(server, tool, args)) as { content: { text: string }[] }).content[0]!.text;
    return { home, root, manager, text, notes, port: (listener.address() as net.AddressInfo).port };
  }

  needsSandbox("a profiled server can't read ~/.ssh, write outside its cache or reach another host; others are unaffected", async () => {
    const { home, root, manager, text, notes, port } = await setup();
    await manager.connect("network");
    await manager.connect("plain");
    expect(manager.status().find((status) => status.name === "network")?.sandbox).toMatchObject({ state: "on", hosts: [] });
    expect(manager.status().find((status) => status.name === "plain")?.sandbox).toMatchObject({ state: "none" });

    expect(await text("network", "read", { path: path.join(home, ".ssh/id_test") })).toStartWith("error:");
    expect(await text("network", "write", { path: path.join(home, "outside.txt") })).toStartWith("error:");
    expect(await text("network", "write", { path: path.join(root, "outside.txt") })).toStartWith("error:");
    expect(await text("network", "write", { path: path.join(home, ".cache/casper-network-mcp/specs.sqlite") })).toBe("wrote");
    expect(await text("network", "connect", { port })).toStartWith("error:");
    expect(await text("network", "fetch", { url: "https://example.com/" })).not.toBe("status:200");
    expect(manager.status().find((status) => status.name === "network")?.sandbox?.refused).toEqual(["example.com"]);
    expect(notes.join("\n")).toContain("kept network from reaching example.com");

    // The same program without a profile runs as before.
    expect(await text("plain", "read", { path: path.join(home, ".ssh/id_test") })).toBe("read:PRIVATE KEY");
    expect(await text("plain", "connect", { port })).toBe("connected");
  });

  needsSandbox("the off switch: the server restarts unsandboxed, and on again holds it", async () => {
    const { home, manager, text } = await setup();
    await manager.connect("network");
    expect(await text("network", "read", { path: path.join(home, ".ssh/id_test") })).toStartWith("error:");
    expect(await manager.setSandbox("network", false)).toMatchObject({ state: "off" });
    expect(await text("network", "read", { path: path.join(home, ".ssh/id_test") })).toBe("read:PRIVATE KEY");
    expect(await manager.setSandbox("network", true)).toMatchObject({ state: "on" });
    expect(await text("network", "read", { path: path.join(home, ".ssh/id_test") })).toStartWith("error:");
  });
});
