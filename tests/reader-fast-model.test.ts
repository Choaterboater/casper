import { afterEach, expect, test } from "bun:test";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiModels } from "../src/runtime/pi-models";

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
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

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
