import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverMCPConfiguration, resolveEnvironment } from "../src/mcp/config";
import { vscodeUserDirs } from "../src/mcp/import";
import { MCPManager } from "../src/mcp/manager";
import { matchPreset } from "../src/mcp/presets";
import { removeTempDir } from "./support/temp-dir";

const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await removeTempDir(dir); });
async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-setup-config-"));
  cleanup.push(home);
  const project = path.join(home, "work", "repo");
  await mkdir(project, { recursive: true });
  return { home, project };
}
async function put(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
}

test("servers from ~/.claude.json (about 3 MB), this project's entry and VS Code are found, start in home, and say where they came from", async () => {
  const { home, project } = await tempHome();
  const history = Array.from({ length: 3000 }, (_, i) => ({ display: `prompt ${i} ${"x".repeat(1000)}` }));
  await put(path.join(home, ".claude.json"), {
    oauthAccount: { accessToken: "SECRET-oauth" }, history,
    mcpServers: { junos: { command: "/opt/junos/run", env: { TOKEN: "SECRET-env" } } },
    projects: { [project]: { mcpServers: { "aruba-central": { command: "/opt/centralmcp/bin/centralmcp" } } } },
  });
  await put(path.join(vscodeUserDirs(home, "linux")[0]!, "mcp.json"), '{ // comment\n "servers": { "netbox": { "command": "/opt/netbox-mcp", "env": { "T": "${env:NB_TOKEN}" } }, } }');
  const configuration = await discoverMCPConfiguration({ projectRoot: project, homeDir: home, platform: "linux" });
  expect(configuration.diagnostics).toEqual([]);
  expect(configuration.servers.map((server) => [server.name, server.scope, server.importedFrom, server.cwd, server.source])).toEqual([
    ["aruba-central", "imported", "claude-project", home, path.join(home, ".claude.json")],
    ["junos", "imported", "claude", home, path.join(home, ".claude.json")],
    ["netbox", "imported", "vscode", home, path.join(vscodeUserDirs(home, "linux")[0]!, "mcp.json")],
  ]);
  const netbox = configuration.servers.find((server) => server.name === "netbox")!;
  expect(netbox.transport).toMatchObject({ env: { T: "${NB_TOKEN}" } });
  // Nothing else from ~/.claude.json reaches the configuration, its diagnostics or /mcp status.
  const manager = new MCPManager(configuration);
  expect(JSON.stringify([configuration.diagnostics, manager.status()])).not.toContain("SECRET");
  expect(manager.status().find((status) => status.name === "junos")!.importedFrom).toBe("~/.claude.json");
});

test("Casper's own files win over imports, and the duplicate is reported by name and file", async () => {
  const { home, project } = await tempHome();
  await put(path.join(home, ".claude.json"), { mcpServers: { junos: { command: "/from-claude" } } });
  await put(path.join(vscodeUserDirs(home, "linux")[0]!, "mcp.json"), { servers: { junos: { command: "/from-vscode" } } });
  await put(path.join(home, ".casper/mcp.json"), { mcpServers: { junos: { command: "/from-casper" } } });
  const configuration = await discoverMCPConfiguration({ projectRoot: project, homeDir: home, platform: "linux" });
  expect(configuration.servers).toHaveLength(1);
  expect(configuration.servers[0]).toMatchObject({ scope: "user", transport: { command: "/from-casper" } });
  expect(configuration.servers[0]!.importedFrom).toBeUndefined();
  expect(configuration.diagnostics).toEqual(['"junos" is in VS Code and ~/.claude.json; using ~/.casper/mcp.json']);
});

test("~/.mcp.json is imported, but not when the project is the home folder, where it is the project's own file", async () => {
  const { home, project } = await tempHome();
  await put(path.join(home, ".mcp.json"), { mcpServers: { lab: { command: "/opt/lab" } } });
  const elsewhere = await discoverMCPConfiguration({ projectRoot: project, homeDir: home, platform: "linux" });
  expect(elsewhere.servers.map((server) => [server.name, server.scope, server.importedFrom])).toEqual([["lab", "imported", "mcp.json"]]);
  const atHome = await discoverMCPConfiguration({ projectRoot: home, homeDir: home, platform: "linux" });
  expect(atHome.servers.map((server) => [server.name, server.scope, server.importedFrom])).toEqual([["lab", "project", undefined]]);
  expect(atHome.diagnostics).toEqual([]);
});

test("the project's .vscode/mcp.json is project content and gets the project review", async () => {
  const { home, project } = await tempHome();
  await put(path.join(project, ".vscode/mcp.json"), { servers: { local: { command: "${workspaceFolder}/.venv/bin/python3", args: ["server.py"] } } });
  const configuration = await discoverMCPConfiguration({ projectRoot: project, homeDir: home, platform: "linux" });
  expect(configuration.servers.map((server) => [server.name, server.scope, server.cwd])).toEqual([["local", "project", project]]);
  const review = new MCPManager(configuration).review("local");
  expect(review?.preview).toContain(`source: ${path.join(project, ".vscode/mcp.json")} (project file)`);
});

test("entries VS Code has to fill in are skipped by name, and the others still load", async () => {
  const { home, project } = await tempHome();
  await put(path.join(vscodeUserDirs(home, "linux")[0]!, "mcp.json"), { servers: {
    netbox: { command: "/opt/netbox", env: { TOKEN: "${input:token}" } },
    ok: { command: "/opt/ok" },
  } });
  const configuration = await discoverMCPConfiguration({ projectRoot: project, homeDir: home, platform: "linux" });
  expect(configuration.servers.map((server) => server.name)).toEqual(["ok"]);
  expect(configuration.diagnostics).toEqual(['Skipped "netbox" from VS Code: it asks VS Code for a value (${input:token}). Put it in ~/.casper/mcp.json instead.']);
});

test("imports can be turned off, and a broken ~/.claude.json never takes Casper's own servers down", async () => {
  const { home, project } = await tempHome();
  await put(path.join(home, ".claude.json"), '{"mcpServers": {"junos": ');
  await put(path.join(home, ".casper/mcp.json"), { mcpServers: { mine: { command: "/opt/mine" } } });
  const configuration = await discoverMCPConfiguration({ projectRoot: project, homeDir: home, platform: "linux" });
  expect(configuration.servers.map((server) => server.name)).toEqual(["mine"]);
  expect(configuration.diagnostics).toEqual(["Cannot read ~/.claude.json (it may be in use). Try /mcp reload."]);
  const off = await discoverMCPConfiguration({ projectRoot: project, homeDir: home, platform: "linux", imports: false });
  expect(off.diagnostics).toEqual([]);
});

test("${VAR:-fallback} uses the fallback when VAR is unset or empty, and VAR when it is set", () => {
  const name = "CASPER_TEST_FALLBACK_VAR";
  const saved = process.env[name];
  try {
    delete process.env[name];
    expect(resolveEnvironment(`--site=\${${name}:-lab}`)).toBe("--site=lab");
    expect(resolveEnvironment(`\${${name}:-}`)).toBe("");
    process.env[name] = "";
    expect(resolveEnvironment(`\${${name}:-lab}`)).toBe("lab");
    process.env[name] = "prod";
    expect(resolveEnvironment(`--site=\${${name}:-lab}`)).toBe("--site=prod");
    delete process.env[name];
    expect(() => resolveEnvironment(`\${${name}}`)).toThrow(`Missing environment variable ${name}`);
  } finally {
    if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
  }
});

test("GreenCLI's MCP export, saved as a project .mcp.json, loads as written and gets the GreenCLI preset", async () => {
  const { home, project } = await tempHome();
  // Byte for byte what GreenCLI writes (src/utils/mcpExport.ts).
  await put(path.join(project, ".mcp.json"), { mcpServers: { greencli: { type: "stdio", command: "/Applications/GreenCLI.app/Contents/MacOS/greencli-mcp", args: [] } } });
  const configuration = await discoverMCPConfiguration({ projectRoot: project, homeDir: home, platform: "linux" });
  const greencli = configuration.servers.find((server) => server.name === "greencli");
  expect(greencli).toMatchObject({ scope: "project", transport: { type: "stdio", command: "/Applications/GreenCLI.app/Contents/MacOS/greencli-mcp", args: [] } });
  expect(configuration.diagnostics).toEqual([]);
  expect(matchPreset(greencli!)?.preset.id).toBe("greencli-mcp");
});
