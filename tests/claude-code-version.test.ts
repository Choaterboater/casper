import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import { applyClaudeCodeVersion, installedClaudeCodeVersion, newerVersion, parseClaudeVersion, PI_CLAUDE_CODE_VERSION, resetInstalledClaudeCodeVersion } from "../src/runtime/claude-code-version";

/** A Claude plan sign-in names a Claude Code version; Anthropic refuses newer models to an old one ("Claude Code
 * 2.1.251 does not support this model; version 2.1.280 or newer is required"). Casper names the installed one. */
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); resetInstalledClaudeCodeVersion(); });

test("PI_CLAUDE_CODE_VERSION is the version the installed Pi names, so a Pi update can't drift", () => {
  const source = readFileSync(path.join(import.meta.dir, "../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js"), "utf8");
  expect(/claudeCodeVersion = "(\d+\.\d+\.\d+)"/.exec(source)?.[1]).toBe(PI_CLAUDE_CODE_VERSION);
});

test("versions compare by number, and claude --version is read", () => {
  expect(newerVersion("2.1.251", "2.1.296")).toBe("2.1.296");
  expect(newerVersion("2.1.300", "2.1.296")).toBe("2.1.300");
  expect(newerVersion("2.10.0", "2.9.9")).toBe("2.10.0");
  expect(newerVersion("2.1.251", undefined)).toBe("2.1.251");
  expect(newerVersion("2.1.251", "not a version")).toBe("2.1.251");
  expect(parseClaudeVersion("2.1.296 (Claude Code)\n")).toBe("2.1.296");
  expect(parseClaudeVersion("")).toBeUndefined();
});

test("claude --version is asked once a run", () => {
  let asked = 0;
  const run = () => { asked++; return "2.1.296 (Claude Code)"; };
  expect(installedClaudeCodeVersion(run)).toBe("2.1.296");
  expect(installedClaudeCodeVersion(run)).toBe("2.1.296");
  expect(asked).toBe(1);
});

test("a newer installed Claude Code replaces the user-agent; an older one or none leaves the headers alone", () => {
  const newer: Record<string, string | null> = { "User-Agent": "pi", "x-other": "kept" };
  applyClaudeCodeVersion(newer, () => "9.9.9");
  expect(newer).toEqual({ "user-agent": "claude-cli/9.9.9", "x-other": "kept" });
  const older: Record<string, string | null> = { "x-other": "kept" };
  applyClaudeCodeVersion(older, () => "0.0.1");
  expect(older).toEqual({ "x-other": "kept" });
  const none: Record<string, string | null> = {};
  applyClaudeCodeVersion(none, () => undefined);
  expect(none).toEqual({});
});

test("a Claude plan sign-in names Claude Code 2.1.280 or newer", async () => {
  let agent = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    agent = request.headers.get("user-agent") ?? "";
    return Response.json({ type: "error", error: { type: "invalid_request_error", message: "fixture" } }, { status: 400 });
  } });
  servers.push(server);
  const model = { id: "fixture", name: "fixture", api: "anthropic-messages", provider: "anthropic", baseUrl: `http://127.0.0.1:${server.port}`,
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
  await complete(model as never, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { apiKey: "sk-ant-oat-local-fixture-not-a-secret" });
  const version = /^claude-cli\/(\d+\.\d+\.\d+)/.exec(agent)?.[1];
  expect(version).toBeDefined();
  expect(newerVersion(version, "2.1.280")).toBe(version);
});

test("the user-agent Casper sets reaches a plan sign-in's request in place of Pi's", async () => {
  let agent = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    agent = request.headers.get("user-agent") ?? "";
    return Response.json({ type: "error", error: { type: "invalid_request_error", message: "fixture" } }, { status: 400 });
  } });
  servers.push(server);
  const model = { id: "fixture", name: "fixture", api: "anthropic-messages", provider: "anthropic", baseUrl: `http://127.0.0.1:${server.port}`,
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
  const headers: Record<string, string | null> = {};
  applyClaudeCodeVersion(headers, () => "9.9.9");
  await complete(model as never, { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    { apiKey: "sk-ant-oat-local-fixture-not-a-secret", headers: headers as Record<string, string> });
  expect(agent).toBe("claude-cli/9.9.9");
});
