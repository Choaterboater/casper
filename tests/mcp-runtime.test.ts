import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CasperApp } from "../src/app";
import { discoverMCPConfiguration, MissingEnvironmentError, resolvedSecrets, resolveEnvironment, startFolder, type MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { CallClock, CallClockTimeout } from "../src/mcp/clock";
import { HIDDEN } from "../src/mcp/server-output";
import { CapabilityBroker } from "../src/capabilities/broker";
import { boundCapabilityResult, capabilityErrorResult, NotExecutedError } from "../src/capabilities/result";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import { fixtureServer } from "./fixtures/mcp-server";

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const fixturePath = path.join(import.meta.dir, "fixtures/mcp-server.ts");
function definition(name = "generic", mode = "runtime", extra: Partial<MCPServerDefinition> = {}, env: Record<string, string> = {}): MCPServerDefinition {
  return { name, source: "fixture", cwd: process.cwd(), disabled: false, ...extra, transport: {
    type: "stdio", command: process.execPath, args: [fixturePath], env: { FIXTURE_MODE: mode, FIXTURE_ID: name, ...env },
  } };
}
function manager(servers: MCPServerDefinition[], options: ConstructorParameters<typeof MCPManager>[1] = {}) {
  const value = new MCPManager({ servers, diagnostics: [] }, options);
  cleanup.push(() => value.close());
  return value;
}
function setEnv(name: string, value: string) {
  process.env[name] = value;
  cleanup.push(() => { delete process.env[name]; });
}
async function tempRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

// --- the call clock --------------------------------------------------------------------------

test("the SDK turns any abort of a sent request into McpError(RequestTimeout) carrying the abort reason", async () => {
  // Casper's error classification relies on this: an McpError that is NOT RequestTimeout means the server answered.
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = fixtureServer("generic");
  await server.connect(serverSide);
  const client = new Client({ name: "pin", version: "1" }, { capabilities: {} });
  await client.connect(clientSide);
  cleanup.push(() => client.close());
  const clock = new CallClock(50, 10_000);
  const failure = await client.callTool({ name: "slow_read", arguments: {} }, undefined, { signal: clock.signal, timeout: 60_000 })
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(McpError);
  expect((failure as McpError).code).toBe(ErrorCode.RequestTimeout);
  expect((failure as McpError).message).toContain(String(new CallClockTimeout("idle", 50)));
  expect(clock.reason()).toBe("idle");
});

test("each progress message restarts the call clock; a silent call still times out", async () => {
  const mcp = manager([definition()], { callTimeoutMs: 500 });
  await mcp.connect("generic");
  // 6 progress messages 150 ms apart: 900 ms in total, above the 500 ms limit.
  const done = await mcp.call("generic", "progress_read", {});
  expect(JSON.stringify(done)).toContain('\\"job\\":\\"done\\"');
  const started = performance.now();
  await expect(mcp.call("generic", "slow_read", {})).rejects.toThrow("No answer from generic in 0.5 s. It may have run. Do not retry on your own; tell the user.");
  expect(performance.now() - started).toBeLessThan(1500);
});

test("the hard cap stops a call that reports progress forever", async () => {
  const mcp = manager([definition()], { callTimeoutMs: 300, hardCapMs: 1000 });
  await mcp.connect("generic");
  const started = performance.now();
  let clock: CallClock | undefined;
  const failure = await mcp.call("generic", "progress_forever", {}, undefined, { onClock: (value) => { clock = value; } })
    .then(() => undefined, (error: Error) => error);
  const took = performance.now() - started;
  expect(failure?.message).toBe("generic was still working after 1 s and was stopped. It may have run. Do not retry on your own; tell the user.");
  expect(clock?.reason()).toBe("hard");
  expect(took).toBeGreaterThanOrEqual(950);
  expect(took).toBeLessThan(2000);
});

test("each server has its own call limit", async () => {
  const mcp = manager([definition("quick", "runtime", { limits: { callMs: 400 } }), definition("patient")]);
  await Promise.all([mcp.connect("quick"), mcp.connect("patient")]);
  expect(mcp.status().map((status) => status.limits)).toEqual([{ connectS: 20, callS: 0.4 }, { connectS: 20, callS: 90 }]);
  const started = performance.now();
  const quick = mcp.call("quick", "slow_read", {}).then(() => "done", (error: Error) => error.message);
  const patient = mcp.call("patient", "slow_read", {}).then(() => "done", (error: Error) => error.message);
  expect(await quick).toContain("No answer from quick in 0.4 s");
  expect(performance.now() - started).toBeLessThan(1000);
  expect(await Promise.race([patient, Bun.sleep(600).then(() => "still waiting")])).toBe("still waiting");
});

// --- config ------------------------------------------------------------------------------------

test("config reads callTimeout and connectTimeout in whole seconds and rejects anything else", async () => {
  const root = await tempRoot("casper-mcp-limits-");
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(project);
  await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify({ mcpServers: {
    slow: { command: "server", callTimeout: 400, connectTimeout: 60 },
    negative: { command: "server", callTimeout: -1 },
    text: { command: "server", callTimeout: "9" },
    tooLong: { command: "server", connectTimeout: 121 },
    plain: { command: "server" },
  } }));
  const config = await discoverMCPConfiguration({ homeDir: home, projectRoot: project });
  const byName = Object.fromEntries(config.servers.map((server) => [server.name, server]));
  expect(byName.slow?.limits).toEqual({ callMs: 400_000, connectMs: 60_000 });
  expect(byName.plain?.limits).toBeUndefined();
  expect(Object.keys(byName).sort()).toEqual(["plain", "slow"]);
  for (const name of ["negative", "text", "tooLong"]) expect(config.diagnostics.join("\n")).toContain(`Invalid or unsupported MCP entry "${name}"`);
});

test("reloading with only a new callTimeout keeps consent and the connection", async () => {
  const mcp = manager([definition()]);
  await mcp.connect("generic");
  const before = JSON.stringify(await mcp.call("generic", "status", {}));
  const diff = await mcp.reload({ diagnostics: [], servers: [definition("generic", "runtime", { limits: { callMs: 400_000 } })] });
  expect(diff).toEqual({ added: [], removed: [], changed: [], revoked: [] });
  expect(mcp.status()[0]).toMatchObject({ state: "ready", limits: { connectS: 20, callS: 400 } });
  const pid = (value: string) => /\\"pid\\":(\d+)/.exec(value)?.[1];
  expect(pid(JSON.stringify(await mcp.call("generic", "status", {})))).toBe(pid(before));
});

test("imported servers never start in the opened project", () => {
  const home = "/home/me"; const project = "/home/me/work/repo";
  expect(startFolder(undefined, "imported", project, home)).toBe(home);
  const diagnostics: string[] = [];
  expect(startFolder(`${project}/x`, "imported", project, home, { name: "junos", diagnostics })).toBe(home);
  expect(startFolder("${PROJECT_ROOT}", "imported", project, home, { name: "junos", diagnostics })).toBe(home);
  expect(diagnostics).toEqual(["junos: starts in your home folder, not in this project.", "junos: starts in your home folder, not in this project."]);
  expect(startFolder("/srv/mcp", "imported", project, home)).toBe("/srv/mcp");
  expect(startFolder("~/mcp/junos", "imported", project, home)).toBe("/home/me/mcp/junos");
  // When the opened project is the home folder itself, start in ~/.casper instead.
  expect(startFolder(undefined, "imported", home, home)).toBe("/home/me/.casper");
  expect(startFolder("~", "imported", home, home)).toBe("/home/me/.casper");
  // The other scopes are unchanged.
  expect(startFolder(undefined, "user", project, home)).toBe(home);
  expect(startFolder(undefined, "project", project, home)).toBe(project);
});

test("a missing variable is named, never a value, and resolvedSecrets lists what to hide", () => {
  expect(() => resolveEnvironment("${CASPER_TEST_UNSET_VAR}")).toThrow(MissingEnvironmentError);
  expect(() => resolveEnvironment("${CASPER_TEST_UNSET_VAR}")).toThrow("Missing environment variable CASPER_TEST_UNSET_VAR");
  setEnv("CASPER_TEST_MCP_TOKEN", "tok-1234567");
  const stdio = definition("s", "runtime", {}, { TOKEN: "${CASPER_TEST_MCP_TOKEN}", LITERAL: "literal-secret", SHORT: "abc" });
  stdio.transport = { ...stdio.transport, args: ["--key=${CASPER_TEST_MCP_TOKEN}", "--plain-flag-value"] } as typeof stdio.transport;
  const secrets = resolvedSecrets(stdio);
  expect(secrets).toContain("tok-1234567");
  expect(secrets).toContain("literal-secret");
  expect(secrets).toContain("--key=tok-1234567");
  expect(secrets).not.toContain("abc");
  expect(secrets).not.toContain("--plain-flag-value");
  const http: MCPServerDefinition = { name: "h", source: "f", cwd: "/", disabled: false,
    transport: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${CASPER_TEST_MCP_TOKEN}", X: "${CASPER_TEST_UNSET_VAR}" } } };
  expect(resolvedSecrets(http).sort()).toEqual(["Bearer tok-1234567", "tok-1234567"]);
});

// --- failures people can understand --------------------------------------------------------------

test("a server that fails to start shows what it said, with secrets hidden", async () => {
  setEnv("CASPER_TEST_MCP_SECRET", "hunter2-very-secret");
  const mcp = manager([definition("central", "fail-start", {}, { FIXTURE_SECRET: "${CASPER_TEST_MCP_SECRET}" })]);
  await mcp.connect("central");
  const status = mcp.status()[0]!;
  expect(status.state).toBe("failed");
  expect(status.error).toBe("The server stopped while starting (exit code 1).");
  expect(status.serverOutput?.join("\n")).toContain("KeyError: 'CENTRAL_BASE_URL'");
  expect(status.serverOutput?.join("\n")).toContain(`connect("${HIDDEN}", retries=3)`);
  expect(JSON.stringify(status)).not.toContain("hunter2-very-secret");
  expect(JSON.stringify(status)).not.toContain("abc123");
});

test("a missing variable and a missing command are named plainly", async () => {
  const unset = definition("unset", "runtime", {}, { X: "${CASPER_TEST_UNSET_VAR}" });
  const missing: MCPServerDefinition = { ...definition("missing"), transport: { type: "stdio", command: "casper-no-such-cmd", args: [], env: {} } };
  const mcp = manager([unset, missing]);
  await mcp.connect("unset");
  await mcp.connect("missing");
  expect(mcp.status().map((status) => [status.state, status.error])).toEqual([
    ["failed", "Missing environment variable CASPER_TEST_UNSET_VAR"],
    ["failed", "Command not found: casper-no-such-cmd"],
  ]);
});

test("a server that logs a lot on stderr still starts and answers", async () => {
  const mcp = manager([definition("chatty", "runtime", {}, { FIXTURE_CHATTY: "20000" })]);
  await mcp.connect("chatty");
  expect(mcp.status()[0]?.state).toBe("ready");
  expect(JSON.stringify(await mcp.call("chatty", "status", {}))).toContain("chatty");
});

test("a JSON-RPC error answer keeps the connection ready", async () => {
  const mcp = manager([definition()]);
  await mcp.connect("generic");
  const pid = (value: unknown) => /\\"pid\\":(\d+)/.exec(JSON.stringify(value))?.[1];
  const before = pid(await mcp.call("generic", "status", {}));
  const failure = await mcp.call("generic", "rpc_error_read", {}).then(() => undefined, (error: Error) => error.message);
  expect(failure).toBe("generic returned an error: site 'lab' not found. It may or may not have run.");
  expect(mcp.status()[0]).toMatchObject({ state: "ready" });
  expect(mcp.catalog()[0]?.tools.length).toBeGreaterThan(0);
  expect(pid(await mcp.call("generic", "status", {}))).toBe(before);
});

test("a crash during a call is still a lost connection and spends the retry budget", async () => {
  const mcp = manager([definition()]);
  await mcp.connect("generic");
  await expect(mcp.call("generic", "crash_read", {})).rejects.toThrow("It may have run. Do not retry on your own");
  expect(mcp.status()[0]?.state).toBe("failed");
  await mcp.prepare();
  expect(mcp.status()[0]?.state).toBe("ready");
  await expect(mcp.call("generic", "crash_read", {})).rejects.toThrow("Do not retry");
  await mcp.prepare();
  expect(mcp.status()[0]?.error).toContain("retry limit");
});

test("/mcp shows each server's limits and, for a failed start, the server's last lines", async () => {
  const root = await tempRoot("casper-mcp-status-");
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(project);
  setEnv("CASPER_TEST_MCP_SECRET", "hunter2-very-secret");
  await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify({ mcpServers: {
    broken: { command: process.execPath, args: [fixturePath], env: { FIXTURE_MODE: "fail-start", FIXTURE_SECRET: "${CASPER_TEST_MCP_SECRET}" } },
    slow: { command: process.execPath, args: [fixturePath], callTimeout: 400, disabled: true },
  } }));
  let output = "";
  const app = new CasperApp({
    runtimeFactory: () => { throw new Error("No model expected"); },
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home }),
    output: { write: (text) => { output += text; } },
  });
  cleanup.push(() => app.close());
  await app.runOnce("/mcp connect broken", project).catch(() => {});
  expect(output).toContain("  limits: start 20 s · call 90 s");
  expect(output).toContain("  limits: start 20 s · call 400 s");
  expect(output).toContain("  The server stopped while starting (exit code 1).\n  Last lines from the server:\n");
  expect(output).toContain("    | KeyError: 'CENTRAL_BASE_URL'");
  expect(output).not.toContain("hunter2-very-secret");
  expect(output).not.toContain("abc123");
});

// --- what the model reads ------------------------------------------------------------------------

test("a refused call reads 'Not executed (you said no)', never 'Complete result'", async () => {
  const mcp = manager([definition()]);
  await mcp.connect("generic");
  const broker = new CapabilityBroker(mcp, async () => false);
  const call = (await broker.prepare("status")).find((tool) => tool.name === "call_capability")!;
  const result = await call.execute({ id: "mcp:generic:set_site", arguments: { site: "lab" } });
  expect(result.isError).toBe(true);
  expect(result.text).toContain("Not executed (you said no)");
  expect(JSON.parse(result.text).executed).toBe(false);
  expect(result.text).not.toContain("Complete result");
});

test("a call cancelled before it is sent reads 'Not executed (cancelled)'", async () => {
  const mcp = manager([definition()]);
  await mcp.connect("generic");
  const broker = new CapabilityBroker(mcp);
  const abort = new AbortController();
  abort.abort();
  const failure = await broker.invoke("mcp:generic:status", {}, abort.signal).then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(NotExecutedError);
  expect(capabilityErrorResult(failure)).toMatchObject({ isError: true, executed: false, summary: "Not executed (cancelled)." });
  expect(capabilityErrorResult(new DOMException("aborted", "AbortError")).summary).toBe("Not executed (cancelled).");
});

test("a server-side error result says the call failed, never 'Complete result'", async () => {
  const mcp = manager([definition()]);
  await mcp.connect("generic");
  const result = await new CapabilityBroker(mcp).invoke("mcp:generic:error_read", {});
  expect(result).toMatchObject({ isError: true, executed: true, summary: "The server said the call failed." });
});

test("each list is cut to 50 on its own", () => {
  const records = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i }));
  const result = boundCapabilityResult({ sites: records(60), devices: records(60) });
  expect((result.data as { sites: unknown[] }).sites).toHaveLength(50);
  expect((result.data as { devices: unknown[] }).devices).toHaveLength(50);
  expect(result.lists).toEqual([{ path: "sites", shown: 50, total: 60 }, { path: "devices", shown: 50, total: 60 }]);
  expect(result.summary).toBe("Partial result: sites shows 50 of 60, devices shows 50 of 60. Narrow the request.");
});

test("two lists from a server are both kept, each cut to 50", async () => {
  const mcp = manager([definition()]);
  await mcp.connect("generic");
  const result = await new CapabilityBroker(mcp).invoke("mcp:generic:two_lists_read", {});
  expect(result.lists).toEqual([
    { path: "content[0].data.sites", shown: 50, total: 60 }, { path: "content[0].data.devices", shown: 50, total: 60 },
  ]);
  expect(result.summary).toContain("The server gave no next page; narrow the request.");
});

test("text that repeats structuredContent is dropped, so the list keeps its 50 items and cursor", async () => {
  const mcp = manager([definition()]);
  await mcp.connect("generic");
  const result = await new CapabilityBroker(mcp).invoke("mcp:generic:dup_read", {});
  const data = result.data as { content: unknown[]; structuredContent: { items: unknown[] } };
  expect(data.content).toEqual([]);
  expect(data.structuredContent.items).toHaveLength(50);
  expect(result.duplicateTextDropped).toBe(true);
  expect(result.nextCursor).toEqual({ path: "structuredContent._pagination.next_cursor", value: "c2" });
  expect(result.summary).toBe("Partial result: structuredContent.items shows 50 of 60. More: call again with next_cursor.");
});

test("a list fanned out into one text block per item is dropped when structuredContent.result has it", async () => {
  const mcp = manager([definition()]);
  await mcp.connect("generic");
  const result = await new CapabilityBroker(mcp).invoke("mcp:generic:fanout_read", {});
  expect((result.data as { content: unknown[] }).content).toEqual([]);
  expect(result.duplicateTextDropped).toBe(true);
  expect(result.lists).toEqual([{ path: "structuredContent.result", shown: 50, total: 60 }]);
});

test("different text next to structuredContent is kept", async () => {
  const mcp = manager([definition()]);
  await mcp.connect("generic");
  const result = await new CapabilityBroker(mcp).invoke("mcp:generic:summary_read", {});
  expect(result.duplicateTextDropped).toBeUndefined();
  expect(result.data).toMatchObject({ content: [{ type: "text", text: "Summary: 3 sites" }], structuredContent: { sites: ["a", "b", "c"] } });
  // A primitive FastMCP result given again as plain text is a copy.
  const wrapped = boundCapabilityResult({ content: [{ type: "text", text: "42 devices" }], structuredContent: { result: "42 devices" } }, 16_384, 50, { mcp: true });
  expect(wrapped.duplicateTextDropped).toBe(true);
  expect(boundCapabilityResult({ content: [{ type: "text", text: "42 devices" }], structuredContent: { result: "42 devices" } }).duplicateTextDropped).toBeUndefined();
});

test("the next-page cursor survives the byte limit, and the list shrinks instead of vanishing", async () => {
  const mcp = manager([definition()]);
  await mcp.connect("generic");
  const result = await new CapabilityBroker(mcp).invoke("mcp:generic:large_read", {});
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16_384);
  expect(result.nextCursor).toEqual({ path: "content[0].data._pagination.next_cursor", value: "provider-read-cursor" });
  const items = (result.data as { content: { data: { items: unknown[] } }[] }).content[0]!.data.items;
  expect(items.length).toBeGreaterThanOrEqual(1);
  expect(items.length).toBeLessThan(50);
  expect(result.lists?.[0]).toMatchObject({ path: "content[0].data.items", total: 2000 });
  expect(result.summary).toContain("More: call again with next_cursor.");
});

test("a long text answer previews its own text with real newlines", async () => {
  const mcp = manager([definition()]);
  await mcp.connect("generic");
  const result = await new CapabilityBroker(mcp).invoke("mcp:generic:long_text_read", {});
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16_384);
  expect(result.summary).toBe("Partial result: too big to show, first part only.");
  expect(result.preview?.startsWith('set interfaces ge-0/0/0 unit 0 description "line 0"\nset interfaces')).toBe(true);
  expect(result.data).toBeUndefined();
});

test("call_capability tells the model about per-list limits and the kept cursor", async () => {
  const mcp = manager([definition()]);
  await mcp.connect("generic");
  const call = (await new CapabilityBroker(mcp).prepare("status")).find((tool) => tool.name === "call_capability")!;
  expect(call.description).toContain("Results bounded to 16 KB and 50 items per list; next_cursor is always kept. Never automatically retry consequential calls.");
});

// --- review fixes ----------------------------------------------------------------------------------

test("an HTTP failure during a call names the status and says not to retry, with header values hidden", async () => {
  const { createServer } = await import("node:http");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
  const fixture = fixtureServer("generic");
  await fixture.connect(transport);
  const http = createServer(async (request, response) => {
    if (request.method !== "POST") { await transport.handleRequest(request, response); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.method === "tools/call") {
      response.writeHead(502, { "content-type": "text/plain" }).end(`gateway lost the device; auth was ${request.headers["x-key"]}`);
      return;
    }
    await transport.handleRequest(request, response, body);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    await fixture.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  setEnv("CASPER_TEST_MCP_HEADER", "header-secret-value");
  const mcp = manager([{ name: "central", source: "fixture", cwd: process.cwd(), disabled: false, transport: {
    type: "http", url: `http://127.0.0.1:${address.port}/mcp`, headers: { "X-Key": "${CASPER_TEST_MCP_HEADER}" },
  } }]);
  await mcp.connect("central");
  expect(mcp.status()[0]?.state).toBe("ready");
  const failure = await mcp.call("central", "status", {}).then(() => undefined, (error: Error) => error.message);
  expect(failure).toBe(`central said HTTP 502: gateway lost the device; auth was ${HIDDEN}. It may have run. Do not retry on your own; tell the user.`);
});

test("server error text the model reads has device config secrets hidden", async () => {
  const mcp = manager([definition()]);
  await mcp.connect("generic");
  const failure = await mcp.call("generic", "rpc_config_error_read", {}).then(() => undefined, (error: Error) => error.message);
  expect(failure).toBe("generic returned an error: apply failed at: wlan ssid-profile corp wpa-passphrase <secret hidden>. It may or may not have run.");
  expect(failure).not.toContain("Corp-Wifi-2026");
  expect(mcp.status()[0]?.state).toBe("ready");
});

test("a timeout after progress names the last progress message, with secrets hidden", async () => {
  const mcp = manager([definition()], { callTimeoutMs: 400 });
  await mcp.connect("generic");
  const failure = await mcp.call("generic", "progress_then_silent_read", {}).then(() => undefined, (error: Error) => error.message);
  expect(failure).toStartWith("No answer from generic in 0.4 s. It may have run. Do not retry on your own; tell the user. Last progress: waiting for token=");
  expect(failure).toEndWith(" on router1.");
  expect(failure).not.toContain("abc123");
});

test("/mcp says plainly when a server gives no answer while starting, or stops after it was ready", async () => {
  const mcp = manager([definition("stall", "stall"), definition()], { connectTimeoutMs: 400 });
  await mcp.connect("stall");
  expect(mcp.status()[0]).toMatchObject({ state: "failed", error: "No answer in 0.4 s while starting." });
  await mcp.connect("generic");
  await mcp.call("generic", "crash_read", {}).catch(() => {});
  expect(mcp.status()[1]?.error).toBe("The server stopped (exit code 0). Next task may restart it.");
});
