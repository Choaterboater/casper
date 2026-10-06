import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixtureTools } from "./fixtures/mcp-check-server";
import { cleanEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";

const fixture = path.resolve(import.meta.dir, "fixtures/mcp-check-server.ts");
const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await removeTempDir(dir); });

test("the check fixture's modes carry the tool shapes later checks grade", () => {
  const byName = (mode: string) => Object.fromEntries(fixtureTools(mode).map((tool) => [tool.name, tool]));
  expect(Object.values(byName("unlabeled")).every((tool) => !tool.annotations)).toBe(true);
  expect(fixtureTools("unlabeled")).toHaveLength(9);
  expect(byName("lying").delete_site!.annotations).toEqual({ readOnlyHint: true });
  expect(byName("router-bad").invoke_tool!.annotations).toEqual({ readOnlyHint: true });
  expect(byName("router-good").invoke_tool!.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
  expect(byName("good").glp_write_status!.annotations).toEqual({ readOnlyHint: true });
  const sizes = fixtureTools("big-schema").map((tool) => Buffer.byteLength(JSON.stringify(JSON.stringify(tool.inputSchema))));
  expect(sizes).toEqual([12_000, 12_001]);
});

test("the check fixture logs every call and reports the environment it started with", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-check-fixture-"));
  temps.push(dir);
  const calls = path.join(dir, "calls.log");
  const envFile = path.join(dir, "env.json");
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fixture], stderr: "pipe",
    env: cleanEnv({ FIXTURE_MODE: "stdout-noise", FIXTURE_CALLS_FILE: calls, FIXTURE_ENV_FILE: envFile, HTTPS_PROXY: "http://127.0.0.1:9", MIST_API_TOKEN: undefined }) as Record<string, string>,
  });
  const client = new Client({ name: "test", version: "1" });
  // stdout-noise writes plain text before serving; the SDK client reports it as a parse error and carries on.
  client.onerror = () => {};
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("access_check");
    expect(await Bun.file(calls).exists()).toBe(false);
    await client.callTool({ name: "get_router_list", arguments: {} });
    expect(await readFile(calls, "utf8")).toBe("get_router_list\n");
    expect(JSON.parse(await readFile(envFile, "utf8"))).toEqual({ MIST_API_TOKEN: "absent", HTTPS_PROXY: "http://127.0.0.1:9", FIXTURE_EXTRA: null });
  } finally { await client.close(); }
});
