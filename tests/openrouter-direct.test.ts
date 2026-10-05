import { afterEach, expect, test } from "bun:test";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyEffort } from "../src/runtime/auto-effort";
import { OPENROUTER_ATTRIBUTION } from "../src/runtime/openrouter-attribution";
import { PiModels } from "../src/runtime/pi-models";

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
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
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
