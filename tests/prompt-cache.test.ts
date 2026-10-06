import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { CasperApp } from "../src/app";
import { browserDefaults } from "../src/browser/discovery";
import { CACHE_IN_PROJECT_ERROR, loadConfiguration } from "../src/config/load";
import { loadProjectContext } from "../src/project/context";
import { type CacheModel, cacheRetentionFor } from "../src/runtime/cache";
import type { AgentRuntime, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { cleanEnv } from "./support/env";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function folders() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-prompt-cache-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper", "profiles", "work"), { recursive: true });
  await mkdir(path.join(project, ".casper"), { recursive: true });
  return { root, home, project };
}

test("auto keeps the long cache only where it costs nothing extra; long, short and off are what they say", () => {
  const table: Array<[string, CacheModel, "long" | "short"]> = [
    ["OpenAI chat completions", { api: "openai-completions", provider: "openai", id: "gpt-demo" }, "long"],
    ["OpenAI responses", { api: "openai-responses", provider: "openai", id: "gpt-demo" }, "long"],
    ["OpenAI under another provider name", { api: "openai-completions", provider: "demo", id: "gpt-demo", baseUrl: "https://api.openai.com/v1" }, "long"],
    ["an OpenAI-compatible server", { api: "openai-completions", provider: "demo", id: "demo-model", baseUrl: "https://llm.example.com/v1" }, "short"],
    ["a local server", { api: "openai-completions", provider: "demo", id: "demo-model", baseUrl: "http://127.0.0.1:8080/v1" }, "short"],
    ["another responses provider", { api: "openai-responses", provider: "demo", id: "demo-model" }, "short"],
    ["a non-Anthropic model via OpenRouter", { api: "openai-completions", provider: "openrouter", id: "openai/gpt-demo" }, "long"],
    ["an Anthropic model via OpenRouter", { api: "openai-completions", provider: "openrouter", id: "anthropic/claude-demo" }, "short"],
    ["OpenRouter set to Anthropic cache_control", { api: "openai-completions", provider: "openrouter", id: "demo", compat: { cacheControlFormat: "anthropic" } }, "short"],
    ["OpenAI without the long cache", { api: "openai-completions", provider: "openai", id: "demo", compat: { supportsLongCacheRetention: false } }, "short"],
    ["responses with the explicit cache mode", { api: "openai-responses", provider: "openai", id: "demo", compat: { supportsExplicitPromptCacheMode: true } }, "short"],
    ["the Anthropic API", { api: "anthropic-messages", provider: "anthropic", id: "claude-demo" }, "short"],
    ["Anthropic through a gateway", { api: "anthropic-messages", provider: "google-vertex", id: "claude-demo" }, "short"],
    ["Bedrock", { api: "bedrock-converse-stream", provider: "amazon-bedrock", id: "anthropic.claude-demo" }, "short"],
    ["Gemini", { api: "google-generative-ai", provider: "google", id: "gemini-demo" }, "short"],
    ["an unknown wire format", { api: "demo-api", provider: "demo", id: "demo" }, "short"],
  ];
  for (const [label, model, expected] of table) {
    expect({ label, retention: cacheRetentionFor(undefined, model) }).toEqual({ label, retention: expected });
    expect({ label, retention: cacheRetentionFor("auto", model) }).toEqual({ label, retention: expected });
  }
  const anthropic = { api: "anthropic-messages", provider: "anthropic", id: "claude-demo" };
  expect(cacheRetentionFor("long", anthropic)).toBe("long");
  expect(cacheRetentionFor("short", { api: "openai-completions" })).toBe("short");
  expect(cacheRetentionFor("off", anthropic)).toBe("none");
  expect(cacheRetentionFor("long", { api: "bedrock-converse-stream" })).toBe("short");
  expect(cacheRetentionFor("off", { api: "bedrock-converse-stream" })).toBe("none");
});

test("cache: loads from your own config or a profile and is refused in a project file", async () => {
  const { home, project } = await folders();
  expect((await loadConfiguration({ projectRoot: project, homeDir: home })).cache).toBeUndefined();
  await writeFile(path.join(home, ".casper/config.yaml"), "cache: short\n");
  const loaded = await loadConfiguration({ projectRoot: project, homeDir: home });
  expect(loaded.cache).toBe("short");
  expect(loaded.warnings).toEqual([]);
  expect((await loadProjectContext({ root: project } as never, { homeDir: home })).cache).toBe("short");
  await writeFile(path.join(home, ".casper/profiles/work/config.yaml"), "cache: off\n");
  expect((await loadConfiguration({ projectRoot: project, homeDir: home, profileName: "work" })).cache).toBe("off");
  await writeFile(path.join(home, ".casper/config.yaml"), "cache: auto\n");
  expect((await loadConfiguration({ projectRoot: project, homeDir: home })).cache).toBe("auto");
  await writeFile(path.join(home, ".casper/config.yaml"), "cache: false\n");
  expect((await loadConfiguration({ projectRoot: project, homeDir: home })).cache).toBe("off");
  await writeFile(path.join(home, ".casper/config.yaml"), "cache: forever\n");
  await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("cache must be auto, long, short or off");
  await writeFile(path.join(home, ".casper/config.yaml"), "cache: long\n");
  await writeFile(path.join(project, ".casper/project.yaml"), "cache: off\n");
  await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow(CACHE_IN_PROJECT_ERROR);
});

/** Pi asks for the long cache only where the provider supports it; elsewhere it quietly sends the short one. */
async function payload(send: (options: { apiKey: string; cacheRetention: "long"; sessionId: string; onPayload: (params: unknown) => never }) => AsyncIterable<unknown>) {
  let captured: Record<string, unknown> | undefined;
  const events = send({ apiKey: "not-a-real-key", cacheRetention: "long", sessionId: "demo-session",
    onPayload: (params) => { captured = params as Record<string, unknown>; throw new Error("stop before sending"); } });
  for await (const _event of events) { /* the stream ends with the stop error */ }
  return captured!;
}
const base = { name: "demo", reasoning: false, input: ["text"] as ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }], systemPrompt: "be brief" });

test("Pi falls back to the short cache, without an error, on providers that cannot keep it long", async () => {
  const openai = { ...base, id: "demo-model", api: "openai-completions" as const, provider: "demo", baseUrl: "https://llm.example.com/v1" };
  const long = await payload((options) => completionsStream(openai, context, options));
  expect(long.prompt_cache_retention).toBe("24h");
  const short = await payload((options) => completionsStream({ ...openai, compat: { supportsLongCacheRetention: false } }, context, options));
  expect(short.prompt_cache_retention).toBeUndefined();
  expect(short.messages).toBeDefined();

  const anthropic = { ...base, id: "demo-claude", api: "anthropic-messages" as const, provider: "demo", baseUrl: "https://llm.example.com" };
  const ttl = (params: Record<string, unknown>) => JSON.stringify(params).match(/"cache_control":\{[^}]*\}/g) ?? [];
  const hour = ttl(await payload((options) => anthropicStream(anthropic, context, options)));
  expect(hour.length).toBeGreaterThan(0);
  expect(hour.every((part) => part.includes('"ttl":"1h"'))).toBe(true);
  const minutes = ttl(await payload((options) => anthropicStream({ ...anthropic, compat: { supportsLongCacheRetention: false } }, context, options)));
  expect(minutes.length).toBeGreaterThan(0);
  expect(minutes.some((part) => part.includes("ttl"))).toBe(false);
});

/** One real Pi session against a local model server: what a conversation request asks the provider for. */
async function cacheRun(cache: string | undefined, compat?: Record<string, unknown>) {
  const { home, project } = await folders();
  const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true });
  const bodies: Array<Record<string, unknown>> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    bodies.push(await request.json() as Record<string, unknown>);
    const chunk = `data: ${JSON.stringify({ id: "cache", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: "stop" }] })}\n\n`;
    return new Response(chunk + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(() => server.stop(true));
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret",
    models: [{ id: "fixture", ...(compat ? { compat } : {}) }],
  } } }));
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false }, cacheWarming: "off" }));
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture" }));
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/pi-cache.ts"), project, ...(cache ? [cache] : [])], {
    cwd: project, env: cleanEnv({ HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" }), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain('CACHE_RESULT={"text":"hello"}');
  return bodies[0]!;
}

posixOnly("a local server gets the short cache by default, cache: long asks it for the day, and cache: off sends none", async () => {
  const auto = await cacheRun(undefined);
  expect(auto.prompt_cache_retention).toBeUndefined();
  expect(auto.messages).toBeDefined();
  const long = await cacheRun("long");
  expect(long.prompt_cache_retention).toBe("24h");
  expect(typeof long.prompt_cache_key).toBe("string");
  const short = await cacheRun("short");
  expect(short.prompt_cache_retention).toBeUndefined();
  const off = await cacheRun("off");
  expect(off.prompt_cache_retention).toBeUndefined();
  expect(off.prompt_cache_key).toBeUndefined();
}, 30_000);

posixOnly("a provider without the long cache still answers: Pi leaves the day-long request out", async () => {
  const body = await cacheRun("long", { supportsLongCacheRetention: false });
  expect(body.prompt_cache_retention).toBeUndefined();
}, 20_000);

class ToolRuntime implements AgentRuntime {
  tools: RuntimeTool[] = [];
  surfaces: string[][] = [];
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.tools = options.tools ?? [];
    return {
      prompt: async () => { this.surfaces.push(this.tools.map((tool) => tool.name)); },
      setTools: (tools) => { this.tools = tools; },
      abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

async function surfaces(installed: boolean, prompts: string[]) {
  const { home, project } = await folders();
  const previous = browserDefaults.installed;
  browserDefaults.installed = async () => installed;
  cleanup.push(() => { browserDefaults.installed = previous; });
  const runtime = new ToolRuntime();
  const app = new CasperApp({
    runtimeFactory: () => runtime, output: { write: () => {} },
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
  });
  cleanup.push(() => app.close());
  await app.start(project);
  for (const prompt of prompts) await app.runOnce(prompt);
  return runtime.surfaces;
}

test("every turn of a session offers the same tools, the browser included from the start when Chrome is there", async () => {
  const seen = await surfaces(true, ["explain how login works", "check the website layout", "fix the parser"]);
  expect(seen[0]).toEqual(["delegate", "ask", "casper_session", "web_search", "web_fetch", "casper_read_untrusted", "browser"]);
  for (const surface of seen) expect(surface).toEqual(seen[0]!);
});

test("the diagram tool arrives with the first diagram word and then stays", async () => {
  const seen = await surfaces(true, ["explain how login works", "map out the login flow", "fix the parser"]);
  expect(seen).toEqual([
    ["delegate", "ask", "casper_session", "web_search", "web_fetch", "casper_read_untrusted", "browser"],
    ["delegate", "ask", "casper_session", "web_search", "web_fetch", "casper_read_untrusted", "browser", "visualize"],
    ["delegate", "ask", "casper_session", "web_search", "web_fetch", "casper_read_untrusted", "browser", "visualize"],
  ]);
});

test("without Chrome the browser tool arrives with the first browser task and then stays", async () => {
  const seen = await surfaces(false, ["explain how login works", "check the website layout", "fix the parser"]);
  expect(seen).toEqual([
    ["delegate", "ask", "casper_session", "web_search", "web_fetch", "casper_read_untrusted"],
    ["delegate", "ask", "casper_session", "web_search", "web_fetch", "casper_read_untrusted", "browser"],
    ["delegate", "ask", "casper_session", "web_search", "web_fetch", "casper_read_untrusted", "browser"],
  ]);
});

test("/usage says the cache share is unavailable when the runtime reports no usage", async () => {
  const { runSlashCommand } = await import("../src/app/commands");
  let written = "";
  const host = {
    output: { write: (text: string) => { written += text; } },
    ensureRuntime: async () => ({ getUsage: () => undefined }),
  } as unknown as Parameters<typeof runSlashCommand>[0];
  await runSlashCommand(host, "/usage");
  expect(written).toContain("Usage: unavailable\nCache: unavailable\nCost: unavailable");
});

test("diagram words bring the diagram tool; other tasks leave it out", async () => {
  const { diagramRequested } = await import("../src/app/capabilities");
  for (const task of ["Draw a diagram of the auth flow", "map out the login flow", "Show the dependency graph", "a mind map of the plan",
    "make a flowchart", "chart the release steps", "visualise the modules", "Visualize this", "sketch the architecture", "a topology map of the site"]) expect({ task, offered: diagramRequested(task) }).toEqual({ task, offered: true });
  for (const task of ["fix the parser", "add a sum function", "explain how login works", "update the sitemap", "add a GraphQL query"]) expect({ task, offered: diagramRequested(task) }).toEqual({ task, offered: false });
});
