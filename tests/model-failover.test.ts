import { afterEach, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ENGINE_PARTS, Failover, failoverCause, failoverTargets, FAILOVER_MIN_WINDOW, type FailoverCause } from "../src/runtime/failover";
import type { ModelFacts } from "../src/runtime/model-facts";
import { openRouterModelFacts } from "../src/runtime/openrouter-models";
import { PiModels } from "../src/runtime/pi-models";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir))); });

test("a rate limit, a usage limit or a model that can't run now lets Casper switch; a key, a refusal, a full window or a bad request doesn't", () => {
  const cases: Array<[string, FailoverCause | undefined]> = [
    ['429 {"message":"Provider returned error","metadata":{"raw":"vendor/model:free is temporarily rate-limited upstream. Please retry shortly"}}', "rate"],
    ["429 Rate limit exceeded: too many requests", "rate"],
    ["529 overloaded_error: Overloaded", "rate"],
    // A limit that a minute's wait doesn't lift: switch at once.
    ["429 Rate limit exceeded: free-models-per-day. Add credits to unlock more requests per day", "quota"],
    ["402 Insufficient credits", "quota"],
    ["429 You exceeded your current quota, please check your plan and billing details", "quota"],
    ["Your account is out of extra usage", "quota"],
    ['404 {"message":"No endpoints found for vendor/model."}', "unavailable"],
    ["404 No endpoints found matching your data policy (Zero data retention)", "unavailable"],
    ["503 Service Unavailable", "unavailable"],
    ["502 Bad Gateway", "unavailable"],
    ["Upstream error from Hoster One: inference generation failed", "unavailable"],
    ["401 Unauthorized: invalid api key", undefined],
    ["403 Forbidden: this key can't use the model", undefined],
    ["400 Bad Request: unsupported parameter 'top_k'", undefined],
    ["This model's maximum context length is 131072 tokens", undefined],
    ["fetch failed: ECONNREFUSED", undefined],
    ["vendor/model does not support tools", undefined],
    ["", undefined],
  ];
  for (const [message, cause] of cases) expect([message, failoverCause(message)]).toEqual([message, cause]);
});

const day = (date: string) => Date.parse(`${date}T00:00:00Z`);
const NOW = day("2026-10-25");
const model = (provider: string, id: string): Model<Api> => ({
  id, name: id, provider, api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 4_000,
} as Model<Api>);
const free = (created: string, extra: Partial<ModelFacts> = {}): ModelFacts =>
  ({ free: true, price: { input: 0, output: 0 }, contextWindow: 131_072, created: day(created), tools: true, ...extra });
// What OpenRouter's list says, by id; the catalog (signed in, takes tools) has all but the last.
const openRouter = new Map<string, ModelFacts>([
  ["vendor-c/current:free", free("2026-06-01")],
  ["vendor-f/free-old:free", free("2026-09-01")],
  ["vendor-f/free-new:free", free("2026-10-20")],
  ["vendor-f/free-ending:free", free("2026-10-21", { expires: NOW + 3 * 86_400_000 })],
  ["vendor-f/free-small:free", free("2026-10-22", { contextWindow: FAILOVER_MIN_WINDOW - 1 })],
  ["vendor-f/free-no-tools:free", free("2026-10-23", { tools: false })],
  ["vendor-p/paid", { free: false, price: { input: 1, output: 2 }, contextWindow: 131_072, created: day("2026-10-24"), tools: true }],
  ["vendor-f/not-signed-in:free", free("2026-10-24")],
]);
const catalog = new Map<string, Model<Api>>([
  ...[...openRouter.keys()].filter((id) => id !== "vendor-f/not-signed-in:free").map((id) => [`openrouter/${id}`, model("openrouter", id)] as const),
  ["anthropic/claude-x", model("anthropic", "claude-x")] as const,
]);
const targets = (current: string, listed: string[], tried: string[] = []) => failoverTargets({
  current: { provider: current.slice(0, current.indexOf("/")), id: current.slice(current.indexOf("/") + 1) },
  listed, tried: new Set(tried), now: NOW,
  usable: (provider, id) => catalog.get(`${provider}/${id}`),
  facts: (provider, id) => provider === "openrouter" ? openRouter.get(id) : undefined,
  openRouter,
}).map((target) => `${target.provider}/${target.id}`);

test("the models to switch to: yours in your order, then, after a free OpenRouter model, the newest free ones that can do the work", () => {
  const listed = ["anthropic/claude-x", "openrouter/vendor-p/paid", "nowhere/missing", "openrouter/vendor-c/current:free", "anthropic/claude-x"];
  expect(targets("openrouter/vendor-c/current:free", listed)).toEqual([
    // Yours first, a paid one too, since you listed it; one that isn't there, the one that failed and a repeat are skipped.
    "anthropic/claude-x", "openrouter/vendor-p/paid",
    // Then free models, newest first: not one ending within a week, too small, without tools, not signed in, or paid.
    "openrouter/vendor-f/free-new:free", "openrouter/vendor-f/free-old:free",
  ]);
  // With no list, only free ones: never the paid model, though OpenRouter added it last.
  expect(targets("openrouter/vendor-c/current:free", [])).toEqual(["openrouter/vendor-f/free-new:free", "openrouter/vendor-f/free-old:free"]);
  // A model already tried in this task isn't tried again.
  expect(targets("openrouter/vendor-c/current:free", listed, ["anthropic/claude-x", "openrouter/vendor-f/free-new:free"]))
    .toEqual(["openrouter/vendor-p/paid", "openrouter/vendor-f/free-old:free"]);
});

test("from anything but a free OpenRouter model only the models you listed are tried: a conversation never moves to a free model by itself", () => {
  for (const current of ["anthropic/claude-x", "openrouter/vendor-p/paid", "claude-subscription/claude-x"]) {
    expect(targets(current, [])).toEqual([]);
    expect(targets(current, ["openrouter/vendor-f/free-old:free"])).toEqual(["openrouter/vendor-f/free-old:free"]);
  }
  // A free OpenRouter model whose facts weren't read can't be told apart: only your list.
  expect(failoverTargets({ current: { provider: "openrouter", id: "vendor-c/current:free" }, listed: [], tried: new Set(), now: NOW,
    usable: (provider, id) => catalog.get(`${provider}/${id}`), facts: () => undefined, openRouter })).toEqual([]);
});

test("OpenRouter's list says when a model it is retiring stops", () => {
  const listed = { id: "vendor/old", supported_parameters: ["tools"], expiration_date: "2026-10-31" };
  expect(openRouterModelFacts(listed)).toMatchObject({ expires: day("2026-11-01") });
  expect(openRouterModelFacts({ ...listed, expiration_date: "soon" })).not.toHaveProperty("expires");
});

test("/model failover keeps your list in Casper's settings, of models the catalog has, once each; clear removes it", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-failover-")); dirs.push(home);
  const agent = path.join(home, ".casper", "agent");
  await mkdir(agent, { recursive: true });
  const known = new Map([["fixture/first", model("fixture", "first")], ["fixture/second", model("fixture", "second")]]);
  const runtime = { getModel: (provider: string, id: string) => known.get(`${provider}/${id}`), getModels: () => [...known.values()] } as unknown as ModelRuntime;
  const models = new PiModels(runtime, agent, home);
  const saved = async () => JSON.parse(await readFile(path.join(home, ".casper", "settings.json"), "utf8")) as { modelFailover?: string[] };
  expect(models.getFailover()).toEqual([]);
  expect(await models.setFailover(["fixture/second", "fixture/first", "fixture/second"])).toEqual(["fixture/second", "fixture/first"]);
  expect((await saved()).modelFailover).toEqual(["fixture/second", "fixture/first"]);
  expect(models.getFailover()).toEqual(["fixture/second", "fixture/first"]);
  await expect(models.setFailover(["fixture/nope"])).rejects.toThrow("fixture/nope is not a model Casper knows: use exact ids from /model (provider/id).");
  expect(models.getFailover()).toEqual(["fixture/second", "fixture/first"]);
  expect(await models.setFailover(undefined)).toEqual([]);
  expect(await saved()).not.toHaveProperty("modelFailover");
});

test("the engine still has the parts failover works through: a Pi update that renames one fails here, and failover stays off", () => {
  for (const part of ENGINE_PARTS) expect([part, typeof Reflect.get(AgentSession.prototype, part)]).toEqual([part, "function"]);
  const hooks = { listed: () => [], usable: () => undefined, switchTo: async () => {}, notice: () => {}, failed: () => {}, aborted: () => false };
  const bare = { _retryAttempt: 0, _isRetryableError: () => false };
  expect(new Failover(bare as unknown as AgentSession, hooks).install()).toBe(false);
  expect(Object.keys(bare)).toEqual(["_retryAttempt", "_isRetryableError"]);
});

test("a switch that fails is said, and the limit's error stands, so the task doesn't end as if it had worked", async () => {
  const model = (id: string) => ({ provider: "fixture", id, contextWindow: 128_000, maxTokens: 16_384 }) as unknown as Model<Api>;
  const notices: string[] = [];
  const failed: string[] = [];
  const engine = {
    model: model("first"), _retryAttempt: 0,
    sessionManager: { buildSessionProjection: () => ({ messages: [] }), getBranch: () => [] },
    settingsManager: { getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }) },
    _isRetryableError: () => false, _willRetryAfterAgentEnd: (_: unknown) => false, _prepareRetry: async (_: unknown) => false,
    _omitRecoveryAttempt: () => {}, _exceedsCompactionThreshold: () => false, _runAutoCompaction: async () => false,
  };
  const failover = new Failover(engine as unknown as AgentSession, {
    listed: () => ["fixture/second"], usable: (_, id) => model(id),
    switchTo: async () => { throw new Error("No API key found for fixture"); },
    notice: (message) => notices.push(message), failed: (message) => failed.push(message), aborted: () => false,
  });
  expect(failover.install()).toBe(true);
  const limit = { role: "assistant", stopReason: "error", errorMessage: "429 Rate limit exceeded: too many requests" };
  // The engine is told a retry follows, so Casper holds the error back...
  expect(engine._willRetryAfterAgentEnd({ messages: [limit] })).toBe(true);
  // ...and when the switch fails, it says why and the error stands.
  expect(await engine._prepareRetry(limit)).toBe(false);
  expect(notices).toEqual(["Couldn't switch to fixture/second: No API key found for fixture"]);
  expect(failed).toEqual(["429 Rate limit exceeded: too many requests"]);
  expect(failover.endTask()).toBe(false);
});
