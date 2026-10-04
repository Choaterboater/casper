import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findExampleConfigs, readCheckConfig, reviewExampleConfig, reviewExampleConfigs, startDefinition } from "../src/mcp/check/examples";
import type { McpCheckCommand } from "../src/cli-args";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function repo(files: Record<string, unknown>, name = "hpe-networking-mcp"): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-check-examples-"));
  temps.push(parent);
  const root = path.join(await realpath(parent), name);
  await mkdir(root);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

const command = (extra: Partial<McpCheckCommand> = {}): McpCheckCommand =>
  ({ repo: ".", live: false, quick: false, strict: false, json: false, env: {}, ...extra });
const server = (env: Record<string, string>) => ({ mcpServers: { hpe: { command: "uv", args: ["run", "hpe-networking-mcp"], env } } });

test("a default example that turns writes on is a problem; a file named for writes gets a note", async () => {
  const root = await repo({
    ".mcp.json.example": server({ HPE_MCP_CENTRAL_WRITES: "1" }),
    "examples/mcp-clients/stdio/full-read-write.mcp.json": server({ HPE_MCP_CENTRAL_WRITES: "1", HPE_MCP_MIST_WRITES: "true" }),
    "examples/mcp-clients/stdio/minimal.mcp.json": server({ HPE_MCP_ACCESS_PROFILE: "safe-read-only", HPE_MCP_CENTRAL_WRITES: "0" }),
    "examples/notes.json": { unrelated: true },
  });
  const configs = await findExampleConfigs(root);
  expect(configs.map((config) => config.file)).toEqual([".mcp.json.example", "examples/mcp-clients/stdio/full-read-write.mcp.json", "examples/mcp-clients/stdio/minimal.mcp.json"]);
  const findings = reviewExampleConfigs(configs).map((finding) => [finding.status, finding.label, finding.text]);
  expect(findings).toEqual([
    ["fail", ".mcp.json.example", "turns writes on (HPE_MCP_CENTRAL_WRITES=1). The default example should be read-only."],
    ["note", "examples/mcp-clients/stdio/full-read-write.mcp.json", "turns writes on (the name says so)"],
    ["ok", "examples/mcp-clients/stdio/minimal.mcp.json", "keeps writes off"],
  ]);
});

test("a literal secret is a problem that shows only its length, never the value", () => {
  const token = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
  const findings = reviewExampleConfig(".mcp.json.example", { mist: { command: "uvx", env: { MIST_API_TOKEN: token, MIST_HOST: "api.mist.com" } } });
  expect(findings[0]).toMatchObject({ status: "fail", text: "has a secret in plain text (env MIST_API_TOKEN, 40 chars). Use ${MIST_API_TOKEN}." });
  expect(JSON.stringify(findings)).not.toContain(token);
  // References and placeholders are fine.
  for (const value of ["${MIST_API_TOKEN}", "<your token>", "your-token-here", "", "changeme"]) {
    expect(reviewExampleConfig(".mcp.json.example", { mist: { command: "uvx", env: { MIST_API_TOKEN: value } } }).filter((finding) => finding.status === "fail")).toEqual([]);
  }
  const header = reviewExampleConfig(".mcp.json", { remote: { url: "https://mcp.example.net", headers: { Authorization: "Bearer abcdefabcdef1234" } } });
  expect(header[0]).toMatchObject({ status: "fail", text: expect.stringContaining("header Authorization, 23 chars") });
});

test("no example config at all is a warning; examples without a read-only switch warn too", async () => {
  expect(reviewExampleConfigs(await findExampleConfigs(await repo({ "README.md": "hi" })))).toEqual([
    { section: "examples", status: "warn", label: "examples", text: "No example config file. Add .mcp.json.example so tools can set it up." },
  ]);
  const plain = reviewExampleConfigs(await findExampleConfigs(await repo({ ".mcp.json.example": server({ DEVICES: "devices.json" }) })));
  expect(plain.map((finding) => [finding.status, finding.label, finding.text])).toEqual([
    ["ok", ".mcp.json.example", "turns no writes on"],
    ["warn", "read-only", "No read-only switch found. Every tool that can change a device is always on."],
  ]);
});

test("a --read-only argument is a read-only switch: the example keeps writes off", async () => {
  const flag = { mcpServers: { mine: { command: "uv", args: ["run", "--directory", "/path/to/mine", "mine", "--read-only"], env: { MIST_API_TOKEN: "${MIST_API_TOKEN}" } } } };
  const findings = reviewExampleConfigs(await findExampleConfigs(await repo({ ".mcp.json.example": flag })));
  expect(findings.map((finding) => [finding.status, finding.label, finding.text])).toEqual([
    ["ok", ".mcp.json.example", "keeps writes off"],
  ]);
});

test("the start definition replaces /path/to/<repo> and ${workspaceFolder} with the repo folder", async () => {
  const root = await repo({
    ".vscode/mcp.json.example": { servers: { hpe: { command: "${workspaceFolder}/.venv/bin/hpe-networking-mcp", args: ["--config", "${workspaceFolder}/config.yaml"] } } },
    "examples/mcp-clients/stdio/full-read-write.mcp.json": { mcpServers: { full: { command: "uv", args: ["--directory", "/path/to/hpe-networking-mcp", "run", "x"] } } },
    "examples/mcp-clients/stdio/minimal.mcp.json": { mcpServers: { minimal: { command: "uv", args: ["--directory", "/path/to/hpe-networking-mcp", "run", "hpe-networking-mcp"], env: { HOME_DIR: "/path/to/hpe-networking-mcp-other" } } } },
  });
  // .vscode example comes before examples/**.
  expect(await startDefinition(root, command(), {})).toMatchObject({
    name: "hpe", source: ".vscode/mcp.json.example", type: "stdio", command: `${root}/.venv/bin/hpe-networking-mcp`, args: ["--config", `${root}/config.yaml`],
  });
  await rm(path.join(root, ".vscode"), { recursive: true });
  // Among examples, a minimal or read-only name is preferred; a longer folder name is left alone.
  expect(await startDefinition(root, command(), {})).toMatchObject({
    name: "minimal", args: ["--directory", root, "run", "hpe-networking-mcp"], env: { HOME_DIR: "/path/to/hpe-networking-mcp-other" }, cwd: root,
  });
});

test("a copy of the repo in another folder still fills /path/to/<project name>", async () => {
  const root = await repo({
    "pyproject.toml": '[build-system]\nrequires = ["x"]\n\n[project]\nname = "hpe-networking-mcp"\nversion = "1"\n',
    ".mcp.json.example": { mcpServers: { hpe: { command: "/path/to/hpe-networking-mcp/.venv/bin/python3", args: ["/path/to/hpe-networking-mcp/src/tool_router.py", "/path/to/other/file"] } } },
  }, "hpe-copy");
  expect(await startDefinition(root, command(), {})).toMatchObject({
    command: `${root}/.venv/bin/python3`, args: [`${root}/src/tool_router.py`, "/path/to/other/file"],
  });
});

test("the start definition order: --, then .casper/mcp-check.json, then example files", async () => {
  const root = await repo({
    ".mcp.json.example": server({}),
    ".casper/mcp-check.json": { start: ["uv", "run", "python", "jmcp.py", "-t", "stdio"] },
  });
  const { config } = await readCheckConfig(root);
  expect(await startDefinition(root, command({ command: ["node", "server.js"] }), config)).toMatchObject({ source: "--", command: "node", args: ["server.js"] });
  expect(await startDefinition(root, command(), config)).toMatchObject({ source: ".casper/mcp-check.json", command: "uv", args: ["run", "python", "jmcp.py", "-t", "stdio"] });
  expect(await startDefinition(root, command(), {})).toMatchObject({ source: ".mcp.json.example", command: "uv" });
  expect(await startDefinition(await repo({ "pyproject.toml": "[project.scripts]\njunos-mcp-server = \"jmcp:main\"\n" }, "junos"), command(), {}))
    .toEqual({ error: "Can't tell how to start this server. Add .mcp.json.example, or pass the command: casper mcp check . -- <command>" });
});

test("--server starts a server from your MCP settings", async () => {
  const home = await repo({ ".casper/mcp.json": { mcpServers: { mine: { command: "my-server", args: ["--stdio"] } } } }, "home");
  const root = await repo({});
  expect(await startDefinition(root, command({ server: "mine" }), {}, [], home)).toMatchObject({ name: "mine", source: "--server", command: "my-server", args: ["--stdio"] });
  expect(await startDefinition(root, command({ server: "nope" }), {}, [], home)).toEqual({ error: "No server named nope in your MCP settings." });
});

test(".casper/mcp-check.json with the wrong shape is named, not guessed", async () => {
  expect((await readCheckConfig(await repo({ ".casper/mcp-check.json": { tests: 3 } }))).error).toBe('.casper/mcp-check.json: "tests" must be a command string');
  expect((await readCheckConfig(await repo({ ".casper/mcp-check.json": { start: "uv run x" } }))).error).toContain('"start" must be a command list');
  expect(await readCheckConfig(await repo({}))).toEqual({ config: {} });
});

test("an example for a server Casper has a preset for warns when it doesn't set the setting that keeps writes off", () => {
  const hpe = (env: Record<string, string>) => ({ hpe: { command: "uv", args: ["run", "python", "src/hpe_networking_mcp/mcp_servers/tool_router.py"], env } });
  expect(reviewExampleConfig(".mcp.json.example", hpe({ HPE_MCP_CENTRAL_WRITES: "0" }))).toEqual([
    { section: "examples", status: "warn", label: ".mcp.json.example", text: "does not set HPE_MCP_ACCESS_PROFILE=safe-read-only, the setting that keeps writes off. Casper sets it itself; other clients using this example don't." },
  ]);
  expect(reviewExampleConfig(".mcp.json.example", hpe({ HPE_MCP_ACCESS_PROFILE: "safe-read-only" }))).toEqual([
    { section: "examples", status: "ok", label: ".mcp.json.example", text: "keeps writes off" },
  ]);
  expect(reviewExampleConfig("examples/admin.mcp.json", hpe({}))[0]).toMatchObject({ status: "note", text: "does not keep writes off (no HPE_MCP_ACCESS_PROFILE=safe-read-only; the name says so)" });
  const grafana = (args: string[]) => ({ grafana: { command: "mcp-grafana", args, env: {} } });
  expect(reviewExampleConfig(".mcp.json", grafana([]))[0]).toMatchObject({ status: "warn", text: expect.stringContaining("does not set --disable-write") });
  expect(reviewExampleConfig(".mcp.json", grafana(["--disable-write"]))[0]).toMatchObject({ status: "ok" });
});
