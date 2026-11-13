import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import { MCPManager } from "../src/mcp/manager";
import { CHILD_KILL_MS, childTestLimit } from "./support/limits";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const fixture = path.join(import.meta.dir, "fixtures/mcp-server.ts");

async function connected() {
  const manager = new MCPManager({ servers: [{
    name: "typed", source: "fixture", cwd: process.cwd(), disabled: false,
    transport: { type: "stdio", command: process.execPath, args: [fixture], env: { FIXTURE_MODE: "output-schemas" } },
  }], diagnostics: [] }, { connectTimeoutMs: CHILD_KILL_MS, callTimeoutMs: 5000 });
  cleanup.push(() => manager.close());
  await manager.connect("typed");
  return manager;
}

test("a tool whose output schema can't be compiled does not stop its server from connecting", async () => {
  const manager = await connected();
  expect(manager.status()[0]).toMatchObject({ state: "ready" });
  expect(manager.catalog()[0]!.tools.map((tool) => tool.name)).toEqual(["typed_read", "wrong_shape_read", "broken_schema_read"]);
  expect(await manager.call("typed", "typed_read", {})).toMatchObject({ structuredContent: { site: "lab" } });
  // Only that tool's own call fails.
  await expect(manager.call("typed", "broken_schema_read", {})).rejects.toThrow();
}, childTestLimit());

test("a tool's result is still checked against its output schema", async () => {
  const manager = await connected();
  await expect(manager.call("typed", "wrong_shape_read", {})).rejects.toThrow();
}, childTestLimit());
