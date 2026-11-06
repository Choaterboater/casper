import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import type { MCPServerDefinition } from "../src/mcp/config";
import { mcpRemoveTool, newerNpmLine, npmLatest, npmPin, parseTimeout, replaceForAI, runMcpRemove, serverPlace, splitTimeoutFlag, type McpEditToolHost } from "../src/mcp/edit";
import { privatePathCommand } from "../src/platform/project-paths";

const home = path.join(os.tmpdir(), "casper-mcp-edit-home");
const definition = (args: string[], env: Record<string, string> = {}): MCPServerDefinition => ({
  name: "rea", source: path.join(home, ".casper/mcp.json"), scope: "user", cwd: home, disabled: false,
  transport: { type: "stdio", command: "npx", args, env },
});

test("~/.casper/run holds no keys: a command that reads it is refused as Casper's own records, ~/.ssh still as keys and logins", () => {
  const context = { root: path.join(home, "project"), home };
  expect(privatePathCommand("ls ~/.casper/run", context)).toStartWith("Not run: this command reads ~/.casper/run, which is private (Casper's own records).");
  expect(privatePathCommand("ls ~/.casper/agent/sessions", context)).toStartWith("Not run: this command reads ~/.casper/agent/sessions, which is private (Casper's own records).");
  expect(privatePathCommand("cat ~/.casper/mcp.json", context)).toStartWith("Not run: this command reads ~/.casper/mcp.json, which is private (keys and logins).");
  expect(privatePathCommand("cat ~/.ssh/config", context)).toStartWith("Not run: this command reads ~/.ssh, which is private (keys and logins).");
});

test("a server pinned to an npm version older than the newest says so, with the /mcp update line", async () => {
  const pinned = definition(["-y", "rea-agents@6.7.0", "mcp"]);
  expect(npmPin(pinned)).toEqual({ name: "rea-agents", version: "6.7.0" });
  expect(npmPin(definition(["-y", "rea-agents", "mcp"]))).toBeUndefined();
  expect(npmPin(definition(["-y", "@scope/tool@1.2.3"]))).toEqual({ name: "@scope/tool", version: "1.2.3" });
  expect(newerNpmLine(pinned, "6.8.0")).toBe("rea: rea-agents 6.8.0 is out (it runs 6.7.0). To use it: /mcp update rea npx -y rea-agents@6.8.0 mcp");
  expect(newerNpmLine(pinned, "6.7.0")).toBeUndefined();
  expect(newerNpmLine(pinned, "6.6.9")).toBeUndefined();
  expect(newerNpmLine(pinned, undefined)).toBeUndefined();
  const asked: string[] = [];
  const fake = (async (url: string) => { asked.push(url); return new Response(JSON.stringify({ version: "6.8.0" })); }) as unknown as typeof fetch;
  expect(await npmLatest("@scope/tool", fake)).toBe("6.8.0");
  expect(asked).toEqual(["https://registry.npmjs.org/@scope%2Ftool/latest"]);
  expect(await npmLatest("x", (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch)).toBeUndefined();
});

test("the AI's change box names the server, where it is, what it ran and runs now, and its settings without their values", async () => {
  const boxes: string[] = [];
  const current = definition(["-y", "rea-agents@6.7.0", "mcp", "--token=tok_EXAMPLE_abcdef0123456789"], { REA_TOKEN: "rea-EXAMPLE-secret-value" });
  const host: McpEditToolHost = {
    homeDir: home, write: () => {}, configured: async () => [current], connect: async () => ({ ok: true }),
    reload: async () => {}, restart: async () => {}, forgetConsent: async () => {}, canAsk: () => true, tell: () => {}, describe: () => undefined,
    approveEdit: async (preview) => { boxes.push(preview); return false; },
  };
  const result = await replaceForAI(host, { name: "rea", entry: { command: "npx", args: ["-y", "rea-agents@6.8.0", "mcp"] } });
  expect(result).toEqual({ text: "Not changed: the user said no. Nothing changed.", isError: true });
  expect(boxes[0]).toStartWith([
    "The AI wants to change what an MCP server runs:",
    "  name     rea",
    "  from     ~/.casper/mcp.json",
    "  settings REA_TOKEN (values hidden)",
  ].join("\n").replace("~/.casper/mcp.json", `~/.casper/mcp.json`));
  expect(boxes[0]).toContain("  now      npx -y rea-agents@6.8.0 mcp\n  version  rea-agents@6.8.0 (pinned)\n");
  expect(boxes[0]).not.toContain("rea-EXAMPLE-secret-value");
  expect(boxes[0]).not.toContain("tok_EXAMPLE_abcdef0123456789");
  // A server Casper didn't put in one of its own files is not the AI's to change.
  const imported = { ...current, scope: "imported" as const, importedFrom: "claude" as const, source: path.join(home, ".claude.json") };
  expect(await replaceForAI({ ...host, configured: async () => [imported] }, { name: "rea", entry: { command: "npx", args: ["-y", "rea-agents@6.8.0"] } }))
    .toEqual({ text: "Not changed: rea is in ~/.claude.json (Claude Code), not one of Casper's files. Tell the user to change it there (claude mcp remove rea).", isError: true });
});

test("a secret variable is never set by the AI: its value is typed hidden by the person after the box, into Casper's key file", async () => {
  const { mkdtemp, mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { removeTempDir } = await import("./support/temp-dir");
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-edit-secret-"));
  try {
    await mkdir(path.join(root, ".casper"), { recursive: true });
    const file = path.join(root, ".casper/mcp.json");
    await writeFile(file, JSON.stringify({ mcpServers: { rea: { command: "npx", args: ["-y", "rea-agents@6.8.0", "mcp"], env: {} } } }), { mode: 0o600 });
    const current: MCPServerDefinition = { name: "rea", source: file, scope: "user", cwd: root, disabled: false, transport: { type: "stdio", command: "npx", args: ["-y", "rea-agents@6.8.0", "mcp"], env: {} } };
    const boxes: string[] = [];
    const asked: string[] = [];
    const host: McpEditToolHost = {
      homeDir: root, write: () => {}, configured: async () => [current], connect: async () => ({ ok: true }),
      reload: async () => {}, restart: async () => {}, forgetConsent: async () => {}, canAsk: () => true, tell: () => {}, describe: () => "229 tools · writes on",
      approveEdit: async (preview) => { boxes.push(preview); return true; },
      privateInput: async (label) => { asked.push(label); return "rea-EXAMPLE-typed-0123456789"; },
    };
    expect(await replaceForAI(host, { name: "rea", env: { REA_API_TOKEN: "tok_EXAMPLE_from_ai_0123" } }))
      .toEqual({ text: 'Not changed: REA_API_TOKEN looks like a secret, so the AI never sets its value. Give it as "" and the user types it hidden after their yes.', isError: true });
    expect(boxes).toEqual([]);
    const result = await replaceForAI(host, { name: "rea", env: { REA_API_TOKEN: "" } });
    expect(boxes[0]).toContain("  env      REA_API_TOKEN: you type it next, hidden; the AI never sees it\n");
    expect(asked).toEqual(["REA_API_TOKEN for rea"]);
    expect(result).toEqual({ text: "Changed rea in ~/.casper/mcp.json and started it (229 tools · writes on)." });
    expect(await readFile(file, "utf8")).not.toContain("rea-EXAMPLE-typed");
    expect(await readFile(path.join(root, ".casper/mcp-secrets.json"), "utf8")).toContain("rea-EXAMPLE-typed-0123456789");
    expect(JSON.stringify(result)).not.toContain("rea-EXAMPLE-typed");
  } finally { await removeTempDir(root); }
});

test("a timeout is a length from 1s to 30m, written anywhere after the name", () => {
  expect([parseTimeout("300"), parseTimeout("300s"), parseTimeout("5m"), parseTimeout("0.5h"), parseTimeout("30m")]).toEqual([300, 300, 300, 1800, 1800]);
  for (const bad of ["0", "31m", "2h", "soon", ""]) expect(parseTimeout(bad)).toEqual({ error: "A timeout is a length from 1s to 30m, such as 300s or 5m." });
  expect(splitTimeoutFlag("rea --timeout 5m")).toEqual({ rest: "rea", timeout: "5m" });
  expect(splitTimeoutFlag("rea --timeout=300s npx -y rea-agents@6.8.0 mcp")).toEqual({ rest: "rea npx -y rea-agents@6.8.0 mcp", timeout: "300s" });
  expect(splitTimeoutFlag("rea npx x")).toEqual({ rest: "rea npx x" });
  expect(splitTimeoutFlag("rea --timeout")).toEqual({ error: "--timeout needs a length, such as --timeout 5m." });
});

test("The AI cannot edit or remove the app's server", async () => {
  const app: MCPServerDefinition = { name: "acp-app", source: "the app (ACP)", scope: "client", cwd: home, disabled: false,
    transport: { type: "http", url: "http://127.0.0.1:4000/mcp/app", headers: { Authorization: "Bearer app-EXAMPLE-token-0123456789" } } };
  expect(serverPlace(app, home)).toEqual({ kind: "other", label: "the app that started Casper", how: "change it in the app" });
  const boxes: string[] = [];
  const said: string[] = [];
  const host: McpEditToolHost = {
    homeDir: home, write: (text) => { said.push(text); }, configured: async () => [app], connect: async () => ({ ok: true }),
    reload: async () => {}, restart: async () => {}, forgetConsent: async () => {}, canAsk: () => true, tell: () => {}, describe: () => undefined,
    approveEdit: async (preview) => { boxes.push(preview); return true; },
  };
  const refusal = "acp-app is in the app that started Casper, not one of Casper's files. Tell the user to change it there (change it in the app).";
  expect(await replaceForAI(host, { name: "acp-app", entry: { url: "http://127.0.0.1:4001/mcp/other" } })).toEqual({ text: `Not changed: ${refusal}`, isError: true });
  expect(await mcpRemoveTool(host).execute({ name: "acp-app" }, new AbortController().signal)).toEqual({ text: `Not removed: ${refusal}`, isError: true });
  // No box was shown, and no file was named or touched.
  expect(boxes).toEqual([]);
  expect(await runMcpRemove(host, "acp-app")).toBe("elsewhere");
  expect(said.join("")).toBe("[mcp] acp-app is in the app that started Casper, not one of Casper's files, so Casper didn't change it. Remove it there: change it in the app.\n");
});
