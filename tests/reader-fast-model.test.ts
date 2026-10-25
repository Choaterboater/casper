import { afterEach, expect, test } from "bun:test";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiModels } from "../src/runtime/pi-models";
import { removeTempDir } from "./support/temp-dir";

type Model = NonNullable<AgentSession["model"]>;
const base: Model = {
  id: "big", name: "Big", provider: "fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:9", reasoning: false,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 1024,
};
const small: Model = { ...base, id: "small", name: "Small" };
const reviewer: Model = { ...base, id: "reviewer", name: "Reviewer" };

function reply(model: Model, text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir))); });

async function setup(roles: Record<string, string> | undefined, auth = (_provider: string) => true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-reader-model-")); dirs.push(dir);
  if (roles) { await mkdir(path.join(dir, ".casper")); await writeFile(path.join(dir, ".casper", "settings.json"), JSON.stringify({ modelRoles: roles })); }
  const used: string[] = [];
  const sent: unknown[] = [];
  const all = [base, small, reviewer];
  const catalog = {
    getModels: () => all, getModel: (provider: string, id: string) => all.find((model) => model.provider === provider && model.id === id),
    hasConfiguredAuth: auth,
    async completeSimple(model: Model, context: unknown, options: unknown) { used.push(model.id); sent.push({ context, options }); return reply(model, "ok"); },
  } as unknown as ModelRuntime;
  return { models: new PiModels(catalog, dir, dir), used, sent };
}

const session = { model: base, thinkingLevel: "off" } as unknown as AgentSession;

test("role fast uses the fast model, not the review model", async () => {
  const { models, used } = await setup({ fast: "fixture/small", review: "fixture/reviewer" });
  expect((await models.complete(session, { systemPrompt: "s", user: "u", role: "fast" })).text).toBe("ok");
  expect(used).toEqual(["small"]);
});

test("role fast falls back to the session model when no fast model is set", async () => {
  const { models, used } = await setup({ review: "fixture/reviewer" });
  await models.complete(session, { systemPrompt: "s", user: "u", role: "fast" });
  expect(used).toEqual(["big"]);
});

test("role fast falls back to the session model when the fast model has no login or is unknown", async () => {
  const noLogin = await setup({ fast: "other/small" });
  await noLogin.models.complete(session, { systemPrompt: "s", user: "u", role: "fast" });
  expect(noLogin.used).toEqual(["big"]);
  const loggedOut = await setup({ fast: "fixture/small" }, () => false);
  await loggedOut.models.complete(session, { systemPrompt: "s", user: "u", role: "fast" });
  expect(loggedOut.used).toEqual(["big"]);
});

test("a call sends no tools and asks for none", async () => {
  const { models, sent } = await setup(undefined);
  await models.complete(session, { systemPrompt: "s", user: "u", role: "fast" });
  const { context, options } = sent[0] as { context: Record<string, unknown>; options: Record<string, unknown> };
  expect(context.tools).toBeUndefined();
  expect(options.toolChoice).toBe("none");
});

test("without a role the review model still answers", async () => {
  const { models, used } = await setup({ fast: "fixture/small", review: "fixture/reviewer" });
  await models.complete(session, { systemPrompt: "s", user: "u" });
  expect(used).toEqual(["reviewer"]);
});

/** A model that thinks and can turn it off; one that thinks and can't. */
const thinker: Model = { ...base, id: "thinker", reasoning: true };
const alwaysThinks: Model = { ...base, id: "always", reasoning: true, thinkingLevelMap: { off: null } } as Model;

async function thinking(roles: Record<string, string> | undefined, conversation: Model = thinker, level = "high") {
  const setupResult = await setup(roles);
  const all = [base, small, reviewer, thinker, alwaysThinks];
  const catalog = setupResult.models as unknown as { catalog: { getModels(): Model[]; getModel(p: string, id: string): Model | undefined } };
  catalog.catalog.getModels = () => all;
  catalog.catalog.getModel = (provider, id) => all.find((model) => model.provider === provider && model.id === id);
  const options = () => (setupResult.sent.at(-1) as { options: { reasoning?: string; maxTokens?: number } }).options;
  const on = { model: conversation, thinkingLevel: level } as unknown as AgentSession;
  return { ...setupResult, options, on };
}
const side = { systemPrompt: "s", user: "u", role: "fast" as const, defaultEffort: "off", maxTokens: 1024, thinkingRoom: 4096 };

test("a side question asks with thinking off, whatever effort the conversation uses, and keeps the 1,024-token cap", async () => {
  const { models, options, on } = await thinking(undefined);
  const answer = await models.complete(on, side);
  expect(options().reasoning).toBeUndefined();
  expect(options().maxTokens).toBe(1024);
  expect(answer).toMatchObject({ stopReason: "stop", maxTokens: 1024 });
});

test("a fast role's own effort turns thinking on, and thinking gets room on top of the answer's tokens", async () => {
  const { models, options, on } = await thinking({ fast: "fixture/thinker:low" });
  const answer = await models.complete(on, side);
  expect(options().reasoning).toBe("low");
  expect(options().maxTokens).toBe(1024 + 4096);
  expect(answer.maxTokens).toBe(5120);
});

test("a model that can't turn thinking off gets the room too; other callers keep their effort first", async () => {
  const always = await thinking(undefined, alwaysThinks);
  await always.models.complete(always.on, side);
  expect(always.options().maxTokens).toBe(1024 + 4096);
  // An explicit effort still wins over a role's suffix (the quarantine reader passes "off" on purpose).
  const reader = await thinking({ fast: "fixture/thinker:high" });
  await reader.models.complete(reader.on, { systemPrompt: "s", user: "u", role: "fast", effort: "off", maxTokens: 4096 });
  expect(reader.options().reasoning).toBeUndefined();
  expect(reader.options().maxTokens).toBe(4096);
  // Without defaultEffort, a role with no suffix still follows the conversation.
  const plain = await thinking(undefined);
  await plain.models.complete(plain.on, { systemPrompt: "s", user: "u", role: "fast" });
  expect(plain.options().reasoning).toBe("high");
});

test("a side question on a model that can't stop thinking asks for its lowest level, never nothing (the provider's default)", async () => {
  // Like Anthropic's newest models: no off, adaptive thinking, effort mid-conversation; the lowest is low.
  const adaptive = { ...base, id: "adaptive", reasoning: true, thinkingLevelMap: { off: null, minimal: null }, forceAdaptiveThinking: true, supportsMidConvoEffort: true } as unknown as Model;
  const { models, options, on } = await thinking(undefined, adaptive);
  await models.complete(on, side);
  expect(options().reasoning).toBe("low");
  expect(options().maxTokens).toBe(1024 + 4096);
  // An explicit "off" (the untrusted-text reader's) is left as it was.
  await models.complete(on, { systemPrompt: "s", user: "u", role: "fast", effort: "off", maxTokens: 4096 });
  expect(options().reasoning).toBeUndefined();
});
