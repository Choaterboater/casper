import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { discoverMCPConfiguration, type MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { CapabilityBroker } from "../src/capabilities/broker";
import { boundCapabilityResult } from "../src/capabilities/result";
import { fixtureServer } from "./fixtures/mcp-server";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const fixturePath = path.join(import.meta.dir, "fixtures/mcp-server.ts");
function definition(name = "generic", mode = "generic"): MCPServerDefinition {
  return { name, source: "fixture", cwd: process.cwd(), disabled: false, transport: {
    type: "stdio", command: process.execPath, args: [fixturePath], env: { FIXTURE_MODE: mode, FIXTURE_ID: name },
  } };
}
function manager(servers = [definition()], timeoutMs = 2000) {
  const value = new MCPManager({ servers, diagnostics: [] }, { timeoutMs });
  cleanup.push(() => value.close());
  return value;
}
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Condition not reached");
    await Bun.sleep(10);
  }
}

test("MCP config discovery is metadata-only, layered, isolated per entry, and redacts errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-config-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const put = async (file: string, value: unknown) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  };
  await put(path.join(home, ".casper/mcp.json"), { mcpServers: { same: { command: "global" }, invalidOverride: { command: "global" } } });
  await put(path.join(home, ".casper/profiles/work/mcp.json"), { mcpServers: { same: { command: "profile" } } });
  await put(path.join(project, "mcp.json"), { mcpServers: { same: { command: "root" } } });
  await put(path.join(project, ".mcp.json"), { mcpServers: { same: { command: "dot" } } });
  await put(path.join(project, ".casper/mcp.json"), { mcpServers: {
    same: { command: "never-executed", args: ["SECRET"], env: { TOKEN: "SECRET" }, trusted: true },
    invalidOverride: { url: "https://user:SECRET@example.invalid" },
    bad: { type: "sse", url: "https://example.invalid/SECRET" },
    http: { url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
    disabled: { command: "no", disabled: true },
  } });
  const config = await discoverMCPConfiguration({ homeDir: home, projectRoot: project, profileName: "work" });
  expect(config.servers.map((server) => server.name)).toEqual(["disabled", "http", "same"]);
  expect(config.servers.find((server) => server.name === "same")?.transport).toMatchObject({ command: "never-executed" });
  expect(config.diagnostics).toHaveLength(2);
  expect(JSON.stringify(config.diagnostics)).not.toContain("SECRET");
  const mcp = new MCPManager(config);
  cleanup.push(() => mcp.close());
  await mcp.prepare();
  expect(mcp.status().map((status) => status.state)).toEqual(["disabled", "disconnected", "disconnected"]);
  expect(JSON.stringify(mcp.status())).not.toContain("SECRET");
  expect(mcp.catalog()).toEqual([]);
  await expect(mcp.connect("disabled")).rejects.toThrow("disabled");
});

test("a personal HPE profile is not discovered for default or unrelated profiles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-personal-mcp-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(root, "home/.casper/profiles/personal");
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "mcp.json"), JSON.stringify({ mcpServers: { hpe: { command: "never-run-personal-server" } } }));
  const options = { homeDir: path.join(root, "home"), projectRoot: path.join(root, "project") };
  expect((await discoverMCPConfiguration(options)).servers).toEqual([]);
  expect((await discoverMCPConfiguration({ ...options, profileName: "other" })).servers).toEqual([]);
  const config = await discoverMCPConfiguration({ ...options, profileName: "personal" });
  expect(config.servers.map((server) => server.name)).toEqual(["hpe"]);
  const mcp = new MCPManager(config);
  cleanup.push(() => mcp.close());
  await mcp.prepare();
  expect(mcp.status()[0]?.state).toBe("disconnected");
});

test("340 generic tools expose at most eight schemas and rare tools remain discoverable and callable", async () => {
  const mcp = manager();
  await mcp.connect("generic");
  expect(mcp.status()[0]).toMatchObject({ state: "ready", toolCount: 340 });
  const broker = new CapabilityBroker(mcp);
  const surface = await broker.prepare("Read site health metric");
  expect(surface).toHaveLength(8);
  expect(surface.filter((tool) => tool.name.startsWith("mcp_"))).toHaveLength(6);
  expect(JSON.stringify(surface)).not.toContain("Inspect rare quantum flux");
  expect(broker.search("quantum flux")).toMatchObject([{ id: "mcp:generic:inspect_quantum_flux", safety: "read" }]);
  const find = surface.find((tool) => tool.name === "find_capability")!;
  const search = await find.execute({ query: "quantum flux" });
  expect(search.text).toContain("mcp:generic:inspect_quantum_flux");
  expect(search.text).not.toContain("inputSchema");
  // Providers may materialize optional string fields as empty strings.
  expect((await find.execute({ query: "quantum flux", id: "" })).isError).not.toBe(true);
  const schema = await find.execute({ id: "mcp:generic:inspect_quantum_flux", query: "" });
  expect(JSON.parse(JSON.parse(schema.text).data.inputSchemaJson).required).toEqual(["site"]);
  const call = surface.find((tool) => tool.name === "call_capability")!;
  expect((await call.execute({ id: "mcp:generic:inspect_quantum_flux", arguments: { site: "lab" } })).text).toContain('"site":"lab"');
  expect((await call.execute({ id: "mcp:generic:inspect_quantum_flux", arguments: {} })).isError).toBe(true);
  expect((await find.execute({ id: "missing" })).isError).toBe(true);
});

test("schema inspection preserves enum and required semantics beyond the result item budget", async () => {
  const mcp = manager([definition("generic", "schema-arrays")]);
  await mcp.connect("generic");
  const broker = new CapabilityBroker(mcp);
  const find = (await broker.prepare("health")).find((tool) => tool.name === "find_capability")!;
  const response = await find.execute({ id: "mcp:generic:inspect_quantum_flux" });
  const envelope = JSON.parse(response.text);
  // Accept either structured disclosure or a lossless JSON-string representation.
  const schema = envelope.data.inputSchemaJson ? JSON.parse(envelope.data.inputSchemaJson) : envelope.data.inputSchema;
  expect(schema.required).toEqual(["site"]);
  expect(schema.properties.site.enum).toHaveLength(80);
  expect(schema.properties.site.enum[79]).toBe("site-79");
  expect(envelope.truncated).toBe(false);
  expect(Buffer.byteLength(response.text)).toBeLessThanOrEqual(16_384);
  await expect(broker.invoke("mcp:generic:inspect_quantum_flux", {})).rejects.toThrow("Invalid MCP arguments");
  expect((await broker.invoke("mcp:generic:inspect_quantum_flux", { site: "site-79" })).isError).toBe(false);
});

test("escaped schema budgets agree across inspection, direct selection, and fallback calls", async () => {
  const mcp = manager([definition("generic", "schema-budget")]);
  await mcp.connect("generic");
  const broker = new CapabilityBroker(mcp);
  const surface = await broker.prepare("schema budget boundary");
  expect(surface.filter((tool) => tool.name.startsWith("mcp_")).map((tool) => tool.description.split("]")[0]))
    .toEqual(["[read; mcp:generic:inspect_budget_in"]);
  const find = surface.find((tool) => tool.name === "find_capability")!;
  const response = await find.execute({ id: "mcp:generic:inspect_budget_in" });
  const envelope = JSON.parse(response.text);
  expect(envelope.truncated).toBe(false);
  expect(Buffer.byteLength(response.text)).toBeLessThanOrEqual(16_384);
  expect(JSON.parse(envelope.data.inputSchemaJson)).toEqual(broker.describe("mcp:generic:inspect_budget_in").inputSchema);
  expect((await broker.invoke("mcp:generic:inspect_budget_in", {})).isError).toBe(false);
  expect(() => broker.describe("mcp:generic:inspect_budget_out")).toThrow("exposure budget");
  expect((await find.execute({ id: "mcp:generic:inspect_budget_out" })).isError).toBe(true);
  await expect(broker.invoke("mcp:generic:inspect_budget_out", {})).rejects.toThrow("exposure budget");
});

test("HPE-style router catalogs prefer native discovery and read dispatch, never generic dispatch permission", async () => {
  const mcp = manager([definition("hpe", "router")]);
  await mcp.connect("hpe");
  expect(mcp.status()[0]?.toolCount).toBe(340);
  const broker = new CapabilityBroker(mcp);
  const surface = await broker.prepare("networking health wrapper");
  expect(surface).toHaveLength(5);
  expect(surface.filter((tool) => tool.name.startsWith("mcp_")).map((tool) => tool.description.split("]")[0])).toEqual([
    "[read; mcp:hpe:find_tool", "[read; mcp:hpe:invoke_read_tool", "[destructive; mcp:hpe:invoke_tool",
  ]);
  const found = await broker.invoke("mcp:hpe:find_tool", { query: "quantum", include_schema: true });
  expect(JSON.stringify(found)).toContain("inspect_quantum_flux");
  const result = await broker.invoke("mcp:hpe:invoke_read_tool", { name: "inspect_quantum_flux", arguments: { site: "lab" } });
  expect(JSON.stringify(result)).toContain('"counter":42');
  await expect(broker.invoke("mcp:hpe:invoke_tool", {})).rejects.toThrow("confirmation");
});

test("collision-safe names route to the exact server and non-read calls need immutable exact-call approval", async () => {
  const mcp = manager([definition("a-b"), definition("a_b")]);
  await Promise.all([mcp.connect("a-b"), mcp.connect("a_b")]);
  const broker = new CapabilityBroker(mcp, async (call) => {
    expect(call.capability.safety).toBe("write");
    expect(call.arguments).toEqual({ site: "reviewed" });
    call.arguments.site = "changed-by-callback";
    return true;
  });
  const surface = await broker.prepare("status");
  const direct = surface.filter((tool) => tool.name.startsWith("mcp_"));
  expect(direct).toHaveLength(2);
  expect(new Set(direct.map((tool) => tool.name)).size).toBe(2);
  const fromHyphen = direct.find((tool) => tool.description.includes("mcp:a-b:status"))!;
  const fromUnderscore = direct.find((tool) => tool.description.includes("mcp:a_b:status"))!;
  expect((await fromHyphen.execute({})).text).toContain('"identity":"a-b"');
  expect((await fromUnderscore.execute({})).text).toContain('"identity":"a_b"');
  expect(JSON.stringify(await broker.invoke("mcp:a-b:set_site", { site: "reviewed" }))).toContain('"site":"reviewed"');
  const denied = new CapabilityBroker(mcp, async () => false);
  await expect(denied.invoke("mcp:a-b:mystery", {})).rejects.toThrow("confirmation");
  expect(denied.search("mystery")[0]?.safety).toBe("external-action");
});

test("invalid arguments never reach approval, and a tool changed during approval cannot execute", async () => {
  const mcp = manager();
  await mcp.connect("generic");
  let approvals = 0;
  const broker = new CapabilityBroker(mcp, async () => {
    approvals++;
    await mcp.call("generic", "fixture_refresh", {});
    await until(() => broker.describe("mcp:generic:set_site").capability.description === "Changed site configuration tool");
    return true;
  });
  await expect(broker.invoke("mcp:generic:set_site", { site: 123 })).rejects.toThrow("Invalid MCP arguments");
  expect(approvals).toBe(0);
  await expect(broker.invoke("mcp:generic:set_site", { site: "lab" })).rejects.toThrow("changed during approval");
  expect(approvals).toBe(1);
});

test("disconnect and reconnect revoke a pending approval even when the tool schema is identical", async () => {
  const mcp = manager();
  await mcp.connect("generic");
  const broker = new CapabilityBroker(mcp, async () => {
    await mcp.disconnect("generic");
    await mcp.connect("generic");
    return true;
  });
  await expect(broker.invoke("mcp:generic:set_site", { site: "lab" })).rejects.toThrow("changed during approval");
});

test("list-change notifications refresh and remove stale tools without restarting", async () => {
  const mcp = manager();
  await mcp.connect("generic");
  const broker = new CapabilityBroker(mcp);
  expect(broker.search("status")).toHaveLength(1);
  await broker.invoke("mcp:generic:fixture_refresh", {});
  await until(() => broker.search("late arrival").length === 1);
  expect(broker.search("status")).toHaveLength(0);
  expect(JSON.stringify(await broker.invoke("mcp:generic:late_read", {}))).toContain("late_read");
  await expect(broker.invoke("mcp:generic:status", {})).rejects.toThrow("unavailable");
});

test("cached descriptors, input validators, and safety decisions invalidate together after refresh", async () => {
  const mcp = manager([definition("generic", "schema-change")]);
  await mcp.connect("generic");
  const broker = new CapabilityBroker(mcp);
  const direct = (await broker.prepare("quantum flux")).find((tool) => tool.name.includes("inspect_quantum_flux"))!;
  expect((await direct.execute({ site: "lab" })).isError).not.toBe(true);
  const description = broker.describe("mcp:generic:inspect_quantum_flux");
  description.inputSchema.required = [];
  description.capability.safety = "write";
  expect(broker.describe("mcp:generic:inspect_quantum_flux").inputSchema.required).toEqual(["site"]);
  expect(broker.describe("mcp:generic:inspect_quantum_flux").capability.safety).toBe("read");
  await broker.invoke("mcp:generic:fixture_refresh", {});
  await until(() => broker.describe("mcp:generic:inspect_quantum_flux").capability.safety === "external-action");
  expect((await direct.execute({ site: "lab" })).text).toContain("Invalid MCP arguments");
  expect((await direct.execute({ site: 42 })).text).toContain("requires explicit interactive confirmation");
  await mcp.disconnect("generic");
  expect(broker.search("quantum flux")).toEqual([]);
  expect((await direct.execute({ site: 42 })).text).toContain("unavailable");
});

test("dead servers do not poison healthy ones; reconnect is bounded and does not replay calls", async () => {
  const mcp = manager([definition("good"), definition("bad", "stall")], 500);
  await Promise.all([mcp.connect("good"), mcp.connect("bad")]);
  expect(mcp.status().find((status) => status.name === "good")?.state).toBe("ready");
  expect(mcp.status().find((status) => status.name === "bad")?.state).toBe("failed");
  const broker = new CapabilityBroker(mcp);
  await expect(broker.invoke("mcp:good:crash_read", {})).rejects.toThrow("not retried");
  expect(mcp.catalog()).toEqual([]);
  await mcp.prepare();
  expect(mcp.status().find((status) => status.name === "good")?.state).toBe("ready");
  expect(JSON.stringify(await broker.invoke("mcp:good:status", {}))).toContain('"identity":"good"');
  await expect(broker.invoke("mcp:good:crash_read", {})).rejects.toThrow("not retried");
  await mcp.prepare();
  expect(mcp.status().find((status) => status.name === "good")?.error).toContain("retry limit");
  await mcp.disconnect("good");
  await mcp.prepare();
  expect(mcp.status().find((status) => status.name === "good")?.state).toBe("disconnected");
});

test("timeouts, caller cancellation, and close during handshake settle without late resurrection", async () => {
  const mcp = manager([definition()], 500);
  await mcp.connect("generic");
  const broker = new CapabilityBroker(mcp);
  const abort = new AbortController();
  const work = broker.invoke("mcp:generic:slow_read", {}, abort.signal);
  setTimeout(() => abort.abort(), 25);
  await expect(work).rejects.toThrow("cancelled");
  expect(mcp.catalog()).toEqual([]);
  await broker.prepare("slow read"); // Cancellation invalidates the affected connection; no call is replayed.
  await expect(broker.invoke("mcp:generic:slow_read", {})).rejects.toThrow("timed out");
  const stalled = manager([definition("stall", "stall")]);
  const connecting = stalled.connect("stall");
  await Bun.sleep(30);
  await Promise.all([stalled.close(), connecting, stalled.close()]);
  expect(stalled.status()[0]?.state).toBe("disconnected");
  expect(stalled.catalog()).toEqual([]);
  await expect(stalled.connect("stall")).rejects.toThrow("closed");
});

test("stdio teardown kills an uncooperative server within the CLI cleanup deadline", async () => {
  const mcp = manager([definition("stubborn", "stubborn")]);
  await mcp.connect("stubborn");
  const broker = new CapabilityBroker(mcp);
  const result = await broker.invoke("mcp:stubborn:status", {});
  const pid: number = JSON.parse(JSON.stringify(result)).data.content[0].data.pid;
  const start = performance.now();
  await mcp.close();
  expect(performance.now() - start).toBeLessThan(900);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});

test("close drains child cleanup already started by a concurrent cancelled call", async () => {
  const mcp = manager([definition("stubborn", "stubborn")]);
  await mcp.connect("stubborn");
  const broker = new CapabilityBroker(mcp);
  const result = await broker.invoke("mcp:stubborn:status", {});
  const pid: number = JSON.parse(JSON.stringify(result)).data.content[0].data.pid;
  const abort = new AbortController();
  const call = broker.invoke("mcp:stubborn:slow_read", {}, abort.signal).catch(() => {});
  abort.abort();
  await until(() => mcp.status()[0]?.state === "failed");
  await mcp.close();
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  await call;
  expect(alive).toBe(false);
});

test("result normalization preserves application records and content-block metadata", () => {
  const record = { type: "text", text: "42", id: "record-7", next_cursor: "page-2", status: "failed" };
  const binaryLikeRecord = { type: "image", id: "ordinary-record" };
  const result = boundCapabilityResult({ content: [{
    type: "text", text: JSON.stringify({ record, binaryLikeRecord }), annotations: { audience: ["user"] },
  }] });
  expect(result.truncated).toBe(false);
  expect(result.data).toEqual({ content: [{
    type: "json", data: { record, binaryLikeRecord }, annotations: { audience: ["user"] },
  }] });
});

test("binary content omits payloads but retains bounded protocol metadata", () => {
  const metadata = { annotations: { audience: ["user"] }, _meta: { next_cursor: "page-2" } };
  const result = boundCapabilityResult({ content: [
    { type: "image", data: "binary-image", mimeType: "image/png", ...metadata },
    { type: "audio", data: "binary-audio", mimeType: "audio/wav", ...metadata },
    { type: "resource", resource: { uri: "fixture://record", blob: "binary-resource", mimeType: "application/octet-stream" }, ...metadata },
  ] });
  expect(result.truncated).toBe(true);
  expect(result.data).toEqual({ content: [
    { type: "image", mimeType: "image/png", ...metadata, omitted: "binary MCP content is not exposed" },
    { type: "audio", mimeType: "audio/wav", ...metadata, omitted: "binary MCP content is not exposed" },
    { type: "resource", resource: { uri: "fixture://record", mimeType: "application/octet-stream" }, ...metadata, omitted: "binary MCP content is not exposed" },
  ] });
  expect(JSON.stringify(result)).not.toContain("binary-image");
  expect(JSON.stringify(result)).not.toContain("binary-audio");
  expect(JSON.stringify(result)).not.toContain("binary-resource");
});

test("results bound array items and serialized bytes, preserve Unicode and errors, and disclose discarded output", async () => {
  const intact = boundCapabilityResult({ content: [{ type: "text", text: "é👻".repeat(100) }] });
  expect(intact.truncated).toBe(false);
  expect(JSON.stringify(intact)).toContain("é👻".repeat(100));
  const arrays = boundCapabilityResult({ items: Array.from({ length: 200 }, (_, i) => i), next_cursor: "provider-cursor" });
  expect(arrays.truncated).toBe(true);
  expect(arrays.data).toEqual({ items: Array.from({ length: 50 }, (_, i) => i), next_cursor: "provider-cursor" });
  const bytes = boundCapabilityResult({ isError: true, text: "👻\"\n".repeat(20_000) }, 1024);
  expect(Buffer.byteLength(JSON.stringify(bytes))).toBeLessThanOrEqual(1024);
  expect(bytes.isError).toBe(true);
  expect(bytes.truncated).toBe(true);
  expect(bytes.preview).not.toContain("�");
  const mcp = manager();
  await mcp.connect("generic");
  const broker = new CapabilityBroker(mcp);
  const output = await broker.invoke("mcp:generic:large_read", {});
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(16_384);
  expect(output.truncated).toBe(true);
  expect((await broker.invoke("mcp:generic:error_read", {})).isError).toBe(true);
});

test.each([true, false])("Streamable HTTP (JSON responses: %s) supports headers, pagination, refresh, and redacted status", async (enableJsonResponse) => {
  let authenticated = false;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse });
  const fixture = fixtureServer();
  await fixture.connect(transport);
  const http = createServer(async (request, response) => {
    authenticated ||= request.headers.authorization === "Bearer fixture-secret";
    await transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    await fixture.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    delete process.env.CASPER_TEST_MCP_HEADER;
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  process.env.CASPER_TEST_MCP_HEADER = "fixture-secret";
  const mcp = manager([{ name: "http", source: "fixture", cwd: process.cwd(), disabled: false, transport: {
    type: "http", url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: "Bearer ${CASPER_TEST_MCP_HEADER}" },
  } }]);
  await mcp.connect("http");
  expect(mcp.status()[0]).toMatchObject({ state: "ready", toolCount: 340 });
  expect(authenticated).toBe(true);
  expect(JSON.stringify(mcp.status())).not.toContain("fixture-secret");
  const broker = new CapabilityBroker(mcp);
  expect(JSON.stringify(await broker.invoke("mcp:http:status", {}))).toContain('"tool":"status"');
  await broker.invoke("mcp:http:fixture_refresh", {});
  await until(() => broker.search("late arrival").length === 1);
  expect(broker.search("status")).toEqual([]);
});

test.each(["cancel", "timeout"])("HTTP cancellation/deadline (%s) closes its unanswered POST", async (mode) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
  const fixture = fixtureServer();
  await fixture.connect(transport);
  let received = false;
  let responseClosed = false;
  const http = createServer(async (request, response) => {
    if (request.method !== "POST") { await transport.handleRequest(request, response); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.method === "tools/call") {
      received = true;
      response.once("close", () => { responseClosed = true; });
      return; // Deliberately never send headers or a result, and ignore MCP cancellation.
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
  const mcp = manager([{ name: "http", source: "fixture", cwd: process.cwd(), disabled: false, transport: {
    type: "http", url: `http://127.0.0.1:${address.port}/mcp`, headers: {},
  } }], 500);
  await mcp.connect("http");
  const abort = new AbortController();
  const call = mcp.call("http", "status", {}, abort.signal).then(() => "completed", () => "cancelled");
  await until(() => received);
  if (mode === "cancel") abort.abort();
  expect(await Promise.race([call, Bun.sleep(1000).then(() => "still waiting")])).toBe("cancelled");
  await Bun.sleep(50);
  expect(responseClosed).toBe(true);
  expect(mcp.catalog()).toEqual([]);
});

test("HTTP catalog-refresh timeout closes its unanswered POST and removes stale capabilities", async () => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
  const fixture = fixtureServer();
  await fixture.connect(transport);
  let stallRefresh = false;
  let received = false;
  let responseClosed = false;
  const http = createServer(async (request, response) => {
    if (request.method !== "POST") { await transport.handleRequest(request, response); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (stallRefresh && body.method === "tools/list") {
      received = true;
      response.once("close", () => { responseClosed = true; });
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
  const mcp = manager([{ name: "http", source: "fixture", cwd: process.cwd(), disabled: false, transport: {
    type: "http", url: `http://127.0.0.1:${address.port}/mcp`, headers: {},
  } }], 500);
  await mcp.connect("http");
  expect(mcp.status()[0]?.state).toBe("ready");
  stallRefresh = true;
  await fixture.notification({ method: "notifications/tools/list_changed" });
  await until(() => received);
  await until(() => mcp.status()[0]?.state === "failed");
  await Bun.sleep(50);
  expect(responseClosed).toBe(true);
  expect(mcp.catalog()).toEqual([]);
  expect(mcp.status()[0]?.error).toContain("refresh failed");
});

test("HTTP redirects cannot forward configured secrets and failures do not echo server bodies", async () => {
  let contacted = false;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { contacted = true; return new Response("sensitive-server-body", { status: 401 }); } });
  const redirect = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.redirect(`http://127.0.0.1:${target.port}/mcp`, 307) });
  cleanup.push(async () => { redirect.stop(true); target.stop(true); });
  const make = (name: string, port: number): MCPServerDefinition => ({
    name, source: "fixture", cwd: process.cwd(), disabled: false,
    transport: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "sensitive-header" } },
  });
  const mcp = manager([make("redirect", redirect.port!), make("failure", target.port!)]);
  await mcp.connect("redirect");
  expect(contacted).toBe(false);
  await mcp.connect("failure");
  expect(mcp.status().map((status) => status.state)).toEqual(["failed", "failed"]);
  expect(JSON.stringify(mcp.status())).not.toContain("sensitive-");
});
