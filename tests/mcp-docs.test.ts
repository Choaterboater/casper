import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MCPServerDefinition } from "../src/mcp/config";
import { addUserServer, docsOnlyDefinition, docsPinned, isDocsServer } from "../src/mcp/docs";
import { matchPreset } from "../src/mcp/presets";
import { posixModes } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function stdio(args: string[], env: Record<string, string> = {}): MCPServerDefinition {
  return { name: "x", source: "~/.claude.json", cwd: "/repo", disabled: false, transport: { type: "stdio", command: "/repo/.venv/bin/python3", args, env } };
}
const router = stdio(["/repo/src/hpe_networking_mcp/mcp_servers/tool_router.py"], {
  PYTHONPATH: "/repo/src", CREDS_PATH: "/repo/config/credentials.yaml", HPE_MCP_ACCESS_PROFILE: "safe-read-only", HPE_MCP_TOOLSETS: "central,glp,rag",
});
const docsTools = [{ name: "search_docs" }, { name: "lookup_api" }];

test("the docs-only copy of a router runs rag.py with only PYTHONPATH; anything else gets none", () => {
  expect(docsOnlyDefinition(router)).toEqual({
    command: "/repo/.venv/bin/python3", args: ["/repo/src/hpe_networking_mcp/mcp_servers/rag.py"], cwd: "/repo", env: { PYTHONPATH: "/repo/src" },
  });
  expect(docsOnlyDefinition(stdio(["/srv/junos-mcp-server/jmcp.py", "-f", "devices.json"]))).toBeUndefined();
  // Plain launcher words are kept; a flag that could carry settings or a secret is never copied.
  const uv = stdio(["run", "--project", "/home/user/hpe", "python", "-u", "/repo/src/hpe_networking_mcp/mcp_servers/tool_router.py"]);
  expect(docsOnlyDefinition(uv)?.args).toEqual(["run", "--project", "/home/user/hpe", "python", "-u", "/repo/src/hpe_networking_mcp/mcp_servers/rag.py"]);
  for (const extra of [["--env-file", "/repo/.env"], ["--token=abc123"], ["--with-credentials", "c.yaml"], ["-X", "MIST_KEY=abc"]]) {
    expect(docsOnlyDefinition(stdio(["run", ...extra, "/repo/src/hpe_networking_mcp/mcp_servers/tool_router.py"]))).toBeUndefined();
  }
  expect(docsOnlyDefinition({ ...router, transport: { type: "http", url: "https://example.net/mcp", headers: {} } })).toBeUndefined();
});

test("docs tools get a place only for hpe-networking-mcp recognised by what it runs, over stdio", () => {
  expect(isDocsServer(docsTools)).toBe(true);
  expect(isDocsServer([{ name: "search_docs" }])).toBe(false);
  expect(docsPinned(router, matchPreset(router, []), docsTools)).toBe(true);
  const stranger = stdio(["/srv/other/server.py"]);
  expect(docsPinned(stranger, matchPreset(stranger, []), docsTools)).toBe(false);
  const http: MCPServerDefinition = { ...router, transport: { type: "http", url: "https://docs.example.net/mcp", headers: {} } };
  expect(docsPinned(http, matchPreset(router, []), docsTools)).toBe(false);
});

test("the ~/.casper/mcp.json writer keeps existing entries, refuses a used name and a broken file, and creates the file 0600", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-docs-"));
  cleanup.push(() => removeTempDir(home));
  const entry = docsOnlyDefinition(router)!;
  const file = await addUserServer(home, "hpe-docs", entry);
  if (posixModes) expect((await stat(file)).mode & 0o777).toBe(0o600);
  await expect(addUserServer(home, "hpe-docs", entry)).rejects.toThrow("hpe-docs is already in ~/.casper/mcp.json. Nothing changed.");
  const before = JSON.parse(await readFile(file, "utf8"));
  before.mcpServers.lab = { command: "lab" };
  before.note = "kept";
  await writeFile(file, JSON.stringify(before));
  await addUserServer(home, "rag", entry);
  const after = JSON.parse(await readFile(file, "utf8"));
  expect(Object.keys(after.mcpServers)).toEqual(["hpe-docs", "lab", "rag"]);
  expect(after.note).toBe("kept");
  await writeFile(file, "{ not json");
  await expect(addUserServer(home, "other", entry)).rejects.toThrow("Cannot read ~/.casper/mcp.json. Nothing changed.");
  expect(await readFile(file, "utf8")).toBe("{ not json");
});
