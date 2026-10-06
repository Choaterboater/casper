import { afterEach, expect, test } from "bun:test";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyEffort } from "../src/runtime/auto-effort";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { applyOpenRouterAttribution, casperTelemetryEnabled, OPENROUTER_ATTRIBUTION, openRouterRequestHeaders, useTelemetrySetting } from "../src/runtime/openrouter-attribution";
import { PiModels } from "../src/runtime/pi-models";
import { removeTempDir } from "./support/temp-dir";

type Model = NonNullable<AgentSession["model"]>;
const base: Model = {
  id: "fixture", name: "Fixture", provider: "fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:9", reasoning: false,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 1024,
};
const openrouter: Model = { ...base, provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" };

function reply(model: Model, text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

const saved = process.env.CASPER_TELEMETRY;
const dirs: string[] = [];
afterEach(async () => {
  if (saved === undefined) delete process.env.CASPER_TELEMETRY; else process.env.CASPER_TELEMETRY = saved;
  await Promise.all(dirs.splice(0).map(dir => removeTempDir(dir)));
});

test("automatic effort's direct request carries Casper's OpenRouter attribution, and only to OpenRouter", async () => {
  const sent: unknown[] = [];
  const catalog: Pick<ModelRuntime, "completeSimple"> = {
    async completeSimple(model, _context, options) { sent.push(options?.headers); return reply(model as Model, '{"effort":"low"}'); },
  };
  for (const model of [openrouter, base]) await classifyEffort({ catalog, model, supported: ["low", "high"], request: "hi" });
  process.env.CASPER_TELEMETRY = "0";
  await classifyEffort({ catalog, model: openrouter, supported: ["low", "high"], request: "hi" });
  expect(sent).toEqual([OPENROUTER_ATTRIBUTION, undefined, undefined]);
  expect(OPENROUTER_ATTRIBUTION["HTTP-Referer"]).toBe("https://choaterboater.github.io/casper/");
});

test("a one-off model call (checklist, review) carries Casper's OpenRouter attribution, and only to OpenRouter", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-openrouter-direct-")); dirs.push(dir);
  const sent: unknown[] = [];
  const catalog = {
    getModels: () => [openrouter, base], getModel: () => undefined, hasConfiguredAuth: () => true,
    async completeSimple(model: Model, _context: unknown, options?: { headers?: Record<string, string> }) { sent.push(options?.headers); return reply(model, "ok"); },
  } as unknown as ModelRuntime;
  const models = new PiModels(catalog, dir, dir);
  for (const model of [openrouter, base]) {
    const result = await models.complete({ model, thinkingLevel: "off" } as unknown as AgentSession, { systemPrompt: "s", user: "u" });
    expect(result.text).toBe("ok");
  }
  expect(sent).toEqual([OPENROUTER_ATTRIBUTION, undefined]);
});

test("telemetry: off in your own config: no app-name headers on an OpenRouter request; CASPER_TELEMETRY=0 still works", async () => {
  delete process.env.CASPER_TELEMETRY;
  const sent: unknown[] = [];
  const catalog: Pick<ModelRuntime, "completeSimple"> = {
    async completeSimple(model, _context, options) { sent.push(options?.headers); return reply(model as Model, '{"effort":"low"}'); },
  };
  let own: boolean | undefined = false;
  const stop = useTelemetrySetting(() => own);
  try {
    await classifyEffort({ catalog, model: openrouter, supported: ["low", "high"], request: "hi" });
    // The conversation's headers: the engine's own attribution is taken out too, other headers stay.
    const merged: Record<string, string | null> = { "HTTP-Referer": "https://pi.dev", "X-OpenRouter-Title": "pi", "X-OpenRouter-Categories": "cli-agent", "X-Custom": "kept" };
    applyOpenRouterAttribution(merged);
    expect(merged).toEqual({ "HTTP-Referer": null, "X-OpenRouter-Title": null, "X-OpenRouter-Categories": null, "X-Custom": "kept" });
    own = undefined;
    await classifyEffort({ catalog, model: openrouter, supported: ["low", "high"], request: "hi" });
    const attributed: Record<string, string | null> = { "HTTP-Referer": "https://pi.dev", "X-OpenRouter-Title": "pi" };
    applyOpenRouterAttribution(attributed);
    expect(attributed).toEqual(OPENROUTER_ATTRIBUTION);
    // The environment variable keeps working when your config says nothing (or on).
    own = true;
    process.env.CASPER_TELEMETRY = "0";
    await classifyEffort({ catalog, model: openrouter, supported: ["low", "high"], request: "hi" });
  } finally { stop(); }
  expect(sent).toEqual([undefined, OPENROUTER_ATTRIBUTION, undefined]);
  expect(casperTelemetryEnabled("1")).toBe(true);
});

test("a session reads telemetry: off from your own config, and closing it stops reading it", async () => {
  delete process.env.CASPER_TELEMETRY;
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-telemetry-app-"))); dirs.push(dir);
  const home = path.join(dir, "home"), project = path.join(dir, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(project, { recursive: true });
  await writeFile(path.join(home, ".casper", "config.yaml"), "telemetry: off\n");
  const app = new CasperApp({ output: { write: () => {} }, runtimeFactory() { throw new Error("No model expected"); }, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }) });
  try {
    await app.runOnce("/settings", project);
    expect(casperTelemetryEnabled()).toBe(false);
    expect(openRouterRequestHeaders(openrouter)).toEqual({});
  } finally { await app.close(); }
  expect(casperTelemetryEnabled()).toBe(true);
});
