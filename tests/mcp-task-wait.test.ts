import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import { CapabilityBroker } from "../src/capabilities/broker";
import type { MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { childTestLimit } from "./support/limits";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const fixture = path.join(import.meta.dir, "fixtures/mcp-server.ts");
const server = (name: string, mode: string): MCPServerDefinition => ({ name, source: "fixture", scope: "client", cwd: process.cwd(), disabled: false,
  transport: { type: "stdio", command: process.execPath, args: [fixture], env: { FIXTURE_MODE: mode } } });

test("a task starts after a bounded wait while one server is still starting, and the AI is told", async () => {
  // The stalled server would hold a task's start for its whole 20 s start limit.
  const manager = new MCPManager({ servers: [server("ready", "generic"), server("stalled", "stall")], diagnostics: [] },
    { connectTimeoutMs: 20_000, taskWaitMs: 2_000 });
  const broker = new CapabilityBroker(manager);
  cleanup.push(() => broker.close());
  const started = performance.now();
  const tools = await broker.prepare("inspect quantum flux");
  expect(performance.now() - started).toBeLessThan(10_000);
  expect(manager.status().map(({ name, state }) => ({ name, state }))).toEqual([
    { name: "ready", state: "ready" }, { name: "stalled", state: "connecting" }]);
  // The ready server's tools are there; the AI hears the other one is still starting.
  expect(broker.search("quantum flux").map((tool) => tool.source)).toContain("ready");
  const find = tools.find((tool) => tool.name === "find_capability")!;
  expect(find.description).toContain("stalled: still starting");
  expect(find.description).not.toContain("ready: still starting");
}, childTestLimit(2));
