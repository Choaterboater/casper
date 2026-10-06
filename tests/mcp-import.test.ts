import { afterEach, expect, test } from "bun:test";
import { removeTempDir } from "./support/temp-dir";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  duplicateDiagnostics, importAll, importClaudeConfig, importHomeMcpJson, importVSCodeConfig, importVSCodeProject, vscodeUserDirs,
} from "../src/mcp/import";

const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await removeTempDir(dir); });
async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-import-"));
  cleanup.push(home);
  const project = path.join(home, "work", "repo");
  await mkdir(project, { recursive: true });
  return { home, project };
}
async function put(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}
const servers = (files: { servers: Map<string, Record<string, unknown>> }[]) => files.flatMap((file) => [...file.servers.keys()]);

test("a ~/.claude.json of about 3 MB with history imports its servers and this project's, and nothing else", async () => {
  const { home, project } = await tempHome();
  const history = Array.from({ length: 3000 }, (_, i) => ({ display: `prompt ${i} ${"x".repeat(1000)}` }));
  const document = {
    oauthAccount: { emailAddress: "someone@example.net", accessToken: "SECRET-oauth" },
    history,
    mcpServers: { junos: { type: "stdio", command: "uv", args: ["run", "/opt/junos/jmcp.py"], env: { TOKEN: "SECRET-env" } } },
    projects: {
      [project]: { history, mcpServers: { "aruba-central": { command: "/opt/centralmcp/bin/centralmcp", env: { CENTRALMCP_READONLY: "0" } } } },
      [path.join(home, "other")]: { mcpServers: { elsewhere: { command: "/bin/true" } } },
    },
  };
  await put(path.join(home, ".claude.json"), JSON.stringify(document));
  expect(Buffer.byteLength(JSON.stringify(document))).toBeGreaterThan(2 * 1024 * 1024);

  const result = await importClaudeConfig(home, project);
  expect(result.diagnostics).toEqual([]);
  expect(result.files.map((file) => [file.importedFrom, file.label, file.scope, [...file.servers.keys()]])).toEqual([
    ["claude", "~/.claude.json", "imported", ["junos"]],
    ["claude-project", "~/.claude.json (this project)", "imported", ["aruba-central"]],
  ]);
  expect(result.files[0]!.source).toBe(path.join(home, ".claude.json"));
  expect(result.files[0]!.servers.get("junos")).toEqual({ type: "stdio", command: "uv", args: ["run", "/opt/junos/jmcp.py"], env: { TOKEN: "SECRET-env" } });
  expect(servers(result.files)).not.toContain("elsewhere");
  // Nothing but the server entries is kept.
  expect(JSON.stringify([...result.files.map((file) => [...file.servers.values()])])).not.toContain("oauth");
});

test("a ~/.claude.json that is half written gives one plain line and no servers", async () => {
  const { home, project } = await tempHome();
  await put(path.join(home, ".claude.json"), '{"mcpServers": {"junos": {"command": "uv"}}, "history": [');
  const result = await importClaudeConfig(home, project);
  expect(result.files).toEqual([]);
  expect(result.diagnostics).toEqual(["Cannot read ~/.claude.json (it may be in use). Try /mcp reload."]);
});

test("a ~/.claude.json over 32 MB is skipped with a size line", async () => {
  const { home, project } = await tempHome();
  await put(path.join(home, ".claude.json"), `{"mcpServers":{},"pad":"${"x".repeat(32 * 1024 * 1024)}"}`);
  const result = await importClaudeConfig(home, project);
  expect(result.files).toEqual([]);
  expect(result.diagnostics).toEqual(["Skipped ~/.claude.json: it is larger than 32 MB."]);
});

test("claude project servers that use project-relative paths get a hint about the start folder", async () => {
  const { home, project } = await tempHome();
  await put(path.join(home, ".claude.json"), JSON.stringify({ projects: { [project]: { mcpServers: {
    local: { command: "uv", args: ["run", "server.py"] }, absolute: { command: "/usr/bin/node", args: ["/opt/x/index.js"] },
  } } } }));
  const result = await importClaudeConfig(home, project);
  expect(result.diagnostics).toEqual([
    '"local" from ~/.claude.json (this project) starts in your home folder, not the project. If it needs the project folder, copy it to ~/.casper/mcp.json with "cwd": "${PROJECT_ROOT}".',
  ]);
});

test("~/.mcp.json is read as a user import, but not when the project is the home folder", async () => {
  const { home, project } = await tempHome();
  await put(path.join(home, ".mcp.json"), JSON.stringify({ mcpServers: { netbox: { command: "/opt/netbox-mcp", env: { NETBOX_TOKEN: "${NETBOX_TOKEN}" } } } }));
  const result = await importHomeMcpJson(home, project);
  expect(result.files.map((file) => [file.importedFrom, file.scope, [...file.servers.keys()]])).toEqual([["mcp.json", "imported", ["netbox"]]]);
  expect(result.files[0]!.servers.get("netbox")!.env).toEqual({ NETBOX_TOKEN: "${NETBOX_TOKEN}" });
  expect(await importHomeMcpJson(home, home)).toEqual({ files: [], diagnostics: [] });
  expect(await importHomeMcpJson(home, `${home}${path.sep}`)).toEqual({ files: [], diagnostics: [] });
});

test("VS Code user mcp.json with comments and a trailing comma imports its servers and translates variables", async () => {
  const { home } = await tempHome();
  const dir = vscodeUserDirs(home, "linux")[0]!;
  expect(dir).toBe(path.join(home, ".config", "Code", "User"));
  await put(path.join(dir, "mcp.json"), `{
    // my servers
    "servers": {
      "grafana": {
        "type": "stdio",
        "command": "\${userHome}/bin/mcp-grafana",
        "args": ["-t", "stdio",],
        "env": { "GRAFANA_API_KEY": "\${env:GRAFANA_TOKEN}", "FALLBACK": "\${LEVEL:-info}" },
      },
    },
  }`);
  await put(path.join(dir, "settings.json"), `{ "editor.fontSize": 14, "mcp": { "servers": { "mist": { "type": "http", "url": "https://mcp.mist.com/mcp", "headers": { "Authorization": "Bearer \${env:MIST_TOKEN}" } } } } }`);
  const result = await importVSCodeConfig(home, "linux");
  expect(result.diagnostics).toEqual([]);
  expect(result.files.map((file) => [file.importedFrom, file.label, file.scope, path.basename(file.source)])).toEqual([
    ["vscode", "VS Code", "imported", "settings.json"], ["vscode", "VS Code", "imported", "mcp.json"],
  ]);
  expect(result.files[1]!.servers.get("grafana")).toEqual({
    type: "stdio", command: `${home}/bin/mcp-grafana`, args: ["-t", "stdio"], env: { GRAFANA_API_KEY: "${GRAFANA_TOKEN}", FALLBACK: "${LEVEL:-info}" },
  });
  expect(result.files[0]!.servers.get("mist")).toEqual({ type: "http", url: "https://mcp.mist.com/mcp", headers: { Authorization: "Bearer ${MIST_TOKEN}" } });
});

test("macOS and Insiders VS Code folders are read too", async () => {
  const { home } = await tempHome();
  expect(vscodeUserDirs(home, "darwin")).toEqual([
    path.join(home, "Library", "Application Support", "Code", "User"),
    path.join(home, "Library", "Application Support", "Code - Insiders", "User"),
  ]);
  await put(path.join(home, "Library", "Application Support", "Code - Insiders", "User", "mcp.json"), `{"servers": {"a": {"command": "/bin/a"}}}`);
  const result = await importVSCodeConfig(home, "darwin");
  expect(result.files.map((file) => [file.label, [...file.servers.keys()]])).toEqual([["VS Code Insiders", ["a"]]]);
});

test("entries VS Code fills in, envFile, user-level ${workspaceFolder} and SSE are skipped by name; the rest still load", async () => {
  const { home } = await tempHome();
  await put(path.join(vscodeUserDirs(home, "linux")[0]!, "mcp.json"), JSON.stringify({ servers: {
    netbox: { command: "/opt/netbox", env: { NETBOX_TOKEN: "${input:token}" } },
    envfile: { command: "/opt/x", envFile: "${userHome}/.env" },
    folder: { command: "${workspaceFolder}/.venv/bin/python3" },
    old: { type: "sse", url: "https://example.net/sse" },
    odd: { command: "/opt/x", args: ["${config:editor.fontSize}"] },
    "bad name": { command: "/opt/x" },
    good: { command: "/opt/good" },
  } }));
  const result = await importVSCodeConfig(home, "linux");
  expect(servers(result.files)).toEqual(["good"]);
  expect(result.diagnostics).toEqual([
    'Skipped "netbox" from VS Code: it asks VS Code for a value (${input:token}). Put it in ~/.casper/mcp.json instead.',
    'Skipped "envfile" from VS Code: envFile is not supported.',
    'Skipped "folder" from VS Code: uses ${workspaceFolder} in a user file; Casper can\'t tell which folder.',
    'Skipped "old" from VS Code: SSE transport is not supported.',
    'Skipped "odd" from VS Code: uses ${config:editor.fontSize}, which Casper can\'t fill in.',
    'Skipped "bad name" from VS Code: a name can only use letters, numbers, dot, dash and underscore.',
  ]);
});

test("the project's .vscode/mcp.json is project content and ${workspaceFolder} is the project", async () => {
  const { home, project } = await tempHome();
  await put(path.join(project, ".vscode", "mcp.json"), `{
    "servers": { "hpe-networking-mcp": { "type": "stdio", "command": "\${workspaceFolder}/.venv/bin/python3",
      "args": ["\${workspaceFolder}/src/hpe_networking_mcp/mcp_servers/tool_router.py"], "env": { "HPE_MCP_READONLY": "1" } } }
  }`);
  const result = await importVSCodeProject(project, home);
  expect(result.diagnostics).toEqual([]);
  expect(result.files.map((file) => [file.importedFrom, file.scope, file.label])).toEqual([["vscode-project", "project", ".vscode/mcp.json"]]);
  expect(result.files[0]!.servers.get("hpe-networking-mcp")).toEqual({
    type: "stdio", command: `${project}/.venv/bin/python3`, args: [`${project}/src/hpe_networking_mcp/mcp_servers/tool_router.py`], env: { HPE_MCP_READONLY: "1" },
  });
});

test("importAll layers VS Code, ~/.mcp.json, ~/.claude.json and this project's Claude entry, lowest first", async () => {
  const { home, project } = await tempHome();
  await put(path.join(vscodeUserDirs(home, "linux")[0]!, "mcp.json"), JSON.stringify({ servers: { junos: { command: "/a" } } }));
  await put(path.join(home, ".mcp.json"), JSON.stringify({ mcpServers: { junos: { command: "/b" } } }));
  await put(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { junos: { command: "/c" } }, projects: { [project]: { mcpServers: { junos: { command: "/d" } } } } }));
  await put(path.join(project, ".vscode", "mcp.json"), JSON.stringify({ servers: { local: { command: "/e" } } }));
  const { user, project: projectFiles } = await importAll({ home, projectRoot: project, platform: "linux" });
  expect(user.files.map((file) => file.importedFrom)).toEqual(["vscode", "mcp.json", "claude", "claude-project"]);
  expect(projectFiles.files.map((file) => [file.scope, [...file.servers.keys()]])).toEqual([["project", ["local"]]]);
  expect(duplicateDiagnostics([
    ...user.files.map((file) => ({ label: file.label, names: file.servers.keys() })),
    { label: "~/.casper/mcp.json", names: ["junos"] },
  ])).toEqual(['"junos" is in VS Code, ~/.mcp.json, ~/.claude.json and ~/.claude.json (this project); using ~/.casper/mcp.json']);
  expect(duplicateDiagnostics([{ label: "~/.claude.json", names: ["junos"] }, { label: "VS Code", names: ["junos"] }]))
    .toEqual(['"junos" is in ~/.claude.json; using VS Code']);
});

test("secrets in the imported files never show up in diagnostics", async () => {
  const { home, project } = await tempHome();
  await put(path.join(home, ".claude.json"), JSON.stringify({
    oauthAccount: { accessToken: "SECRET-1" },
    mcpServers: {
      a: { command: "/a", env: { TOKEN: "SECRET-2" }, envFile: "SECRET-3" },
      b: { type: "http", url: "https://example.net/mcp", headers: { Authorization: "SECRET-4 ${input:x}" } },
      c: { command: "/c", env: { TOKEN: 42 } },
    },
  }));
  const result = await importClaudeConfig(home, project);
  expect(result.diagnostics.length).toBe(3);
  expect(result.diagnostics.join("\n")).not.toContain("SECRET");
});

test("a server named __proto__ can't change how the entry map behaves", async () => {
  const { home, project } = await tempHome();
  await put(path.join(home, ".claude.json"), '{"mcpServers": {"__proto__": {"command": "/x"}, "ok": {"command": "/y"}}}');
  const result = await importClaudeConfig(home, project);
  expect(servers(result.files)).toEqual(["__proto__", "ok"]);
  expect(({} as Record<string, unknown>).command).toBeUndefined();
});
