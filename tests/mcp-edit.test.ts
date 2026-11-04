import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import type { MCPServerDefinition } from "../src/mcp/config";
import { newerNpmLine, npmLatest, npmPin, replaceForAI, type McpEditToolHost } from "../src/mcp/edit";
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
    reload: async () => {}, forgetConsent: async () => {}, canAsk: () => true, tell: () => {}, describe: () => undefined,
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
