import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const source = path.resolve(import.meta.dir, "..");
async function freshProcess(code: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-lazy-"));
  try {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await mkdir(path.join(home, ".casper"), { recursive: true });
    await mkdir(project);
    await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify({ mcpServers: { unused: { command: "never-run-fixture" } } }));
    const child = Bun.spawn([process.execPath, "-e", `
      import assert from "node:assert/strict";
      const source = ${JSON.stringify(source)};
      const project = ${JSON.stringify(project)};
      ${code}
    `], { cwd: project, env: { ...process.env, HOME: home, CASPER_PROFILE: "default", PI_OFFLINE: "1", PI_TELEMETRY: "0" }, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exit, stderr, stdout }).toEqual({ exit: 0, stderr: "", stdout: "passed\n" });
    } finally { clearTimeout(timer); }
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("local app commands and unapproved preparation do not load MCP SDK or Ajv", async () => {
  await freshProcess(`
    const { CasperApp } = await import(source + "/src/app.ts");
    const app = new CasperApp({ output: { write() {} }, runtimeFactory() { throw new Error("No model expected"); } });
    try {
      for (const command of ["/project", "/mcp", "/help"]) await app.runOnce(command, project);
      const { MCPManager } = await import(source + "/src/mcp/manager.ts");
      const { CapabilityBroker } = await import(source + "/src/capabilities/broker.ts");
      const manager = new MCPManager({ servers: [], diagnostics: [] });
      const broker = new CapabilityBroker(manager);
      assert.deepEqual(await broker.prepare("inspect"), []);
      assert.deepEqual(broker.search("anything"), []);
      await broker.close();
    } finally { await app.close(); }
    const loaded = Object.keys(require.cache).filter(p => p.includes("/node_modules/@modelcontextprotocol/") || p.includes("/node_modules/ajv/"));
    assert.deepEqual(loaded, [], "local commands must not initialize MCP/Ajv modules");
    console.log("passed");
  `);
});

test("a cold approved connection loads the real SDK and retains schema validation and cleanup", async () => {
  await freshProcess(`
    const { MCPManager } = await import(source + "/src/mcp/manager.ts");
    const { CapabilityBroker } = await import(source + "/src/capabilities/broker.ts");
    const manager = new MCPManager({ servers: [{ name: "fixture", source: "fixture", cwd: project, disabled: false,
      transport: { type: "stdio", command: process.execPath, args: [source + "/tests/fixtures/mcp-server.ts"], env: {} },
    }], diagnostics: [] });
    const broker = new CapabilityBroker(manager);
    try {
      await manager.connect("fixture");
      assert.equal(manager.status()[0].state, "ready");
      await assert.rejects(broker.invoke("mcp:fixture:inspect_quantum_flux", {}), /Invalid MCP arguments/);
      const result = await broker.invoke("mcp:fixture:inspect_quantum_flux", { site: "lab" });
      assert.equal(result.isError, false);
      assert.equal(result.data.content[0].data.arguments.site, "lab");
      assert.ok(Object.keys(require.cache).some(p => p.includes("/node_modules/@modelcontextprotocol/")));
    } finally { await broker.close(); }
    assert.equal(manager.status()[0].state, "disconnected");
    console.log("passed");
  `);
});

for (const action of ["cancel", "close", "refresh"] as const) {
  test(`${action} during validator import blocks approval and invocation`, async () => {
    await freshProcess(`
      const { CapabilityBroker } = await import(source + "/src/capabilities/broker.ts");
      let entered, release;
      const loading = new Promise(resolve => entered = resolve);
      const gate = new Promise(resolve => release = resolve);
      Bun.plugin({ name: "delay-real-validator-import", setup(build) {
        build.onLoad({ filter: /@modelcontextprotocol\\/sdk\\/dist\\/esm\\/validation\\/ajv-provider\\.js$/ }, async args => {
          entered();
          await gate;
          return { contents: await Bun.file(args.path).text(), loader: "js" };
        });
      }});
      // Scripted catalog isolates the broker's first-use import boundary. The
      // existing MCP suites cover validation against real protocol servers.
      let calls = 0, approvals = 0;
      const manager = { catalogRevision: 1, catalog() { return [{ server: "fixture", generation: this.catalogRevision, tools: [{ name: "set_value", inputSchema: { type: "object" } }] }]; },
        async call() { calls++; }, async close() {}, };
      const broker = new CapabilityBroker(manager, async () => { approvals++; return true; });
      const abort = new AbortController();
      const pending = broker.invoke("mcp:fixture:set_value", {}, abort.signal).then(() => "executed", () => "rejected");
      let timer;
      try {
        await Promise.race([loading, new Promise((_, reject) => timer = setTimeout(() => reject(new Error("Validator import was not deferred")), 1000))]);
      } finally { clearTimeout(timer); }
      if (${JSON.stringify(action)} === "cancel") abort.abort();
      else if (${JSON.stringify(action)} === "close") await broker.close();
      else manager.catalogRevision++;
      release();
      assert.equal(await pending, "rejected");
      assert.equal(approvals, 0);
      assert.equal(calls, 0);
      await broker.close();
      console.log("passed");
    `);
  });
}

for (const moduleFile of ["index", "stdio"] as const) for (const action of ["close", "disconnect", "timeout"] as const) {
  test(`${action} during SDK ${moduleFile} loading prevents late transport creation`, async () => {
    await freshProcess(`
      const { MCPManager } = await import(source + "/src/mcp/manager.ts");
      const { spyOn } = await import("bun:test");
      const spawn = spyOn(await import("node:child_process"), "spawn");
      let entered, release;
      const loading = new Promise(resolve => entered = resolve);
      const gate = new Promise(resolve => release = resolve);
      Bun.plugin({ name: "delay-real-mcp-client-import", setup(build) {
        build.onLoad({ filter: /@modelcontextprotocol\\/sdk\\/dist\\/esm\\/client\\/${moduleFile}\\.js$/ }, async args => {
          entered();
          await gate;
          return { contents: await Bun.file(args.path).text(), loader: "js" };
        });
      }});
      const marker = project + "/transport-started";
      const manager = new MCPManager({ servers: [{ name: "fixture", source: "fixture", cwd: project, disabled: false,
        transport: { type: "stdio", command: process.execPath, args: ["-e", "await Bun.write(" + JSON.stringify(marker) + ", 'started')"], env: {} },
      }], diagnostics: [] }, { timeoutMs: ${action === "timeout" ? 500 : 2000} });
      const pending = manager.connect("fixture");
      let timer;
      try {
        await Promise.race([loading, new Promise((_, reject) => timer = setTimeout(() => reject(new Error("SDK import did not reach the lazy boundary")), 1000))]);
      } finally { clearTimeout(timer); }
      assert.equal(manager.status()[0].state, "connecting");
      let closing;
      if (${JSON.stringify(action)} === "close") closing = manager.close();
      else if (${JSON.stringify(action)} === "disconnect") closing = manager.disconnect("fixture");
      else await Bun.sleep(550);
      release();
      await pending;
      await closing;
      assert.equal(spawn.mock.calls.length, 0, "revoked/timed-out import must not spawn a child");
      spawn.mockRestore();
      assert.equal(await Bun.file(marker).exists(), false);
      assert.equal(manager.status()[0].state, ${JSON.stringify(action === "timeout" ? "failed" : "disconnected")});
      assert.deepEqual(manager.catalog(), []);
      await manager.close();
      console.log("passed");
    `);
  });
}
