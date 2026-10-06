import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpCheck } from "../src/mcp/check/index";
import { formatCheckReport } from "../src/mcp/check/format";
import { safeToCall } from "../src/mcp/check/live";
import { DEAD_PROXY } from "../src/mcp/check/sandbox";
import type { McpCheckCommand } from "../src/cli-args";
import { fixtureTools } from "./fixtures/mcp-check-server";
import { checkCommand } from "./support/check-command";
import { removeTempDir } from "./support/temp-dir";

const fixture = path.resolve(import.meta.dir, "fixtures/mcp-check-server.ts");
const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await removeTempDir(dir); });

async function repo(start?: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-check-live-"));
  temps.push(root);
  if (start !== undefined) {
    await mkdir(path.join(root, ".casper"));
    await writeFile(path.join(root, ".casper/mcp-check.json"), JSON.stringify({ start, doctor: checkCommand() }));
  }
  return root;
}

const command = (root: string, extra: Partial<McpCheckCommand> = {}): McpCheckCommand =>
  ({ repo: root, live: false, quick: true, strict: false, json: false, env: {}, ...extra });

async function calls(file: string): Promise<string[]> {
  try { return (await readFile(file, "utf8")).split("\n").filter(Boolean); } catch { return []; }
}

test("offline, no fixture mode gets a single tool call, and the server sees no credentials", async () => {
  for (const mode of ["good", "unlabeled", "lying", "stdout-noise", "router-good", "router-bad", "big-schema", "secret-stderr"]) {
    const root = await repo({ command: process.execPath, args: [fixture], env: { FIXTURE_MODE: mode, MIST_API_TOKEN: "literal-token-in-example" } });
    const log = path.join(root, "calls.log");
    const envFile = path.join(root, "env.json");
    const report = await new McpCheck(command(root, { env: { FIXTURE_CALLS_FILE: log, FIXTURE_ENV_FILE: envFile } }), {
      baseEnv: { ...process.env, MIST_API_TOKEN: "real-token", HTTPS_PROXY: "http://corp:8080" },
    }).run();
    expect({ mode, calls: await calls(log) }).toEqual({ mode, calls: [] });
    expect(report.findings.some((finding) => finding.section === "live")).toBe(false);
    expect(JSON.parse(await readFile(envFile, "utf8"))).toMatchObject({ MIST_API_TOKEN: "absent", HTTPS_PROXY: DEAD_PROXY });
  }
});

test("a remote HTTP server needs --live, and offline nothing is fetched", async () => {
  const root = await repo({ url: "https://mcp.example.net/mcp" });
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = Object.assign(async () => { fetched++; return new Response("{}"); }, { preconnect: () => {} }) as typeof fetch;
  try {
    const report = await new McpCheck(command(root)).run();
    expect(report.findings).toContainEqual({ section: "server", status: "fail", label: "remote", text: "Remote server: needs --live (offline only contacts localhost)." });
  } finally { globalThis.fetch = original; }
  expect(fetched).toBe(0);
});

test("--live calls access_check and at most 3 safe reads, never a write or a mislabeled tool", async () => {
  const good = await repo({ command: process.execPath, args: [fixture], env: { FIXTURE_MODE: "good" } });
  const log = path.join(good, "calls.log");
  const report = await new McpCheck(command(good, { live: true, env: { FIXTURE_CALLS_FILE: log } })).run();
  expect(await calls(log)).toEqual(["access_check", "get_router_list", "list_sites", "show_version"]);
  const live = report.findings.filter((finding) => finding.section === "live");
  expect(live.map((finding) => [finding.status, finding.label])).toEqual([["ok", "access_check"], ["ok", "get_router_list"], ["ok", "list_sites"], ["ok", "show_version"]]);
  expect(live[0]!.text).toMatch(/^[\d.]+ s · access not checked$/);
  expect(live[1]!.text).toMatch(/^[\d.]+ s, 3 items$/);
  expect(formatCheckReport(report)).toContain("Live: up to 3 tools the server labels read-only are called on your real systems. Write tools are never called.");

  const lying = await repo({ command: process.execPath, args: [fixture], env: { FIXTURE_MODE: "lying" } });
  const lyingLog = path.join(lying, "calls.log");
  await new McpCheck(command(lying, { live: true, env: { FIXTURE_CALLS_FILE: lyingLog } })).run();
  expect(await calls(lyingLog)).toEqual(["access_check", "get_router_list"]);

  const unlabeled = await repo({ command: process.execPath, args: [fixture], env: { FIXTURE_MODE: "unlabeled" } });
  const unlabeledLog = path.join(unlabeled, "calls.log");
  const none = await new McpCheck(command(unlabeled, { live: true, env: { FIXTURE_CALLS_FILE: unlabeledLog } })).run();
  expect(await calls(unlabeledLog)).toEqual([]);
  expect(none.findings).toContainEqual({ section: "live", status: "none", label: "live", text: "No tool is labeled read-only, so --live calls nothing." });
});

test("only read-only, read-named tools without fields that change things are safe to call", () => {
  const safe = (mode: string) => fixtureTools(mode).filter(safeToCall).map((tool) => tool.name);
  expect(safe("good")).toEqual(["get_router_list", "list_sites", "show_version", "get_uptime", "get_config_rollback_status"]);
  expect(safe("lying")).toEqual(["get_router_list"]);
  expect(safe("router-good")).toEqual([]);
  expect(safe("unlabeled")).toEqual([]);
});

test("a server that can't import its packages says to install them", async () => {
  const root = await repo({ command: process.execPath, args: ["-e", "console.error(\"ModuleNotFoundError: No module named 'mcp'\"); process.exit(1)"] });
  await writeFile(path.join(root, "uv.lock"), "");
  const report = await new McpCheck(command(root)).run();
  expect(report.findings.find((finding) => finding.label === "starts")).toMatchObject({
    status: "fail",
    text: "Stopped before it was ready (exit code 1). Not set up: it needs packages that are not installed. Run `uv sync` in the repo, then check again. Last lines it printed (secrets hidden):",
    detail: ["ModuleNotFoundError: No module named 'mcp'"],
  });
});

test("--live failures never show the credential the server was given", async () => {
  const secret = "Zq8xLmP4vT2wKdR7";
  for (const failure of ["result", "throw"]) {
    const root = await repo({ command: process.execPath, args: [fixture], env: { FIXTURE_MODE: "good", FIXTURE_CALL_ERROR: failure } });
    const report = await new McpCheck(command(root, { live: true }), { baseEnv: { ...process.env, MIST_API_TOKEN: secret } }).run();
    const live = report.findings.filter((finding) => finding.section === "live");
    expect(live.map((finding) => finding.status)).toEqual(["fail", "fail", "fail", "fail"]);
    expect(live[1]!.text).toContain("rejected •••");
    expect(formatCheckReport(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain(secret);
  }
});

test("--env wins over the example's own env, so the router's direct-mode hint works", async () => {
  const root = await repo({ command: process.execPath, args: [fixture], env: { FIXTURE_MODE: "good", FIXTURE_EXTRA: "from-example" } });
  const envFile = path.join(root, "env.json");
  await new McpCheck(command(root, { env: { FIXTURE_EXTRA: "from-flag", FIXTURE_ENV_FILE: envFile } })).run();
  expect(JSON.parse(await readFile(envFile, "utf8")).FIXTURE_EXTRA).toBe("from-flag");
});

test("offline, an example config can't point the server at a real proxy", async () => {
  const root = await repo({ command: process.execPath, args: [fixture], env: { FIXTURE_MODE: "good", HTTPS_PROXY: "http://corp:8080" } });
  const envFile = path.join(root, "env.json");
  await new McpCheck(command(root, { env: { FIXTURE_ENV_FILE: envFile } })).run();
  expect(JSON.parse(await readFile(envFile, "utf8")).HTTPS_PROXY).toBe(DEAD_PROXY);
});

test("--live failures hide device secrets the server echoed back", async () => {
  const { liveSmoke } = await import("../src/mcp/check/live");
  const tool = { name: "get_wlans", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } };
  const other = { ...tool, name: "get_radius" };
  const connection = {
    secrets: [],
    async call(name: string) {
      if (name === "get_wlans") return { isError: true, content: [{ type: "text", text: "bad line: wpa-passphrase plaintext Sup3rS3cret99" }] };
      throw new Error("invalid config: set system tacplus-server 10.1.1.1 secret \"TacKey-77\"");
    },
  } as unknown as Parameters<typeof liveSmoke>[0];
  const findings = await liveSmoke(connection, [tool, other]);
  const text = findings.map((finding) => finding.text).join("\n");
  expect(text).toContain("failed after");
  expect(text).not.toContain("Sup3rS3cret99");
  expect(text).not.toContain("TacKey-77");
});
