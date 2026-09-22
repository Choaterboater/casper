import { expect, test, vi } from "bun:test";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage as Response } from "@earendil-works/pi-ai";
import { classifyEffort, resolveAutoEffort } from "../src/runtime/auto-effort";

const model: NonNullable<AgentSession["model"]> = {
  id: "classifier", name: "Fixture classifier", provider: "fixture", api: "openai-completions",
  baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 1024,
};
const options = { model, supported: ["off", "minimal", "low", "medium", "high", "xhigh"], request: "Explain how the parser handles nested expressions." };
function response(text = '{"effort":"medium"}', overrides: Partial<Response> = {}): Response {
  return {
    role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
    stopReason: "stop", timestamp: 0,
    usage: { input: 21, output: 8, cacheRead: 3, cacheWrite: 2, totalTokens: 34,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 } },
    ...overrides,
  };
}

test("automatic effort respects sparse unordered ladders and never disables reasoning", () => {
  expect(resolveAutoEffort("medium", ["xhigh", "off", "low", "minimal"])).toBe("low");
  expect(resolveAutoEffort("low", ["high", "medium"])).toBe("medium");
  expect(resolveAutoEffort("xhigh", ["off", "medium", "high"])).toBe("high");
  expect(resolveAutoEffort("minimal", ["off", "minimal", "low"])).toBe("low");
  expect(resolveAutoEffort("high", ["off", "minimal"])).toBe("minimal");
  expect(resolveAutoEffort("xhigh", ["off"])).toBeUndefined();
  expect(resolveAutoEffort("high", [])).toBeUndefined();
  expect(resolveAutoEffort("high", ["max", "invented"])).toBeUndefined();
  expect(resolveAutoEffort("invalid", ["low", "high"])).toBeUndefined();
});

test("classification uses one isolated tool-free request and returns observed usage with model clamping", async () => {
  let calls = 0;
  const catalog: Pick<ModelRuntime, "completeSimple"> = {
    async completeSimple(selected, context, settings) {
      calls++;
      expect(selected).toBe(model);
      expect(context.messages).toEqual([{ role: "user", content: options.request, timestamp: expect.any(Number) }]);
      expect(context.tools ?? []).toEqual([]);
      expect(context.systemPrompt).not.toContain(options.request);
      expect(settings?.toolChoice).toBe("none");
      expect(settings?.maxRetries).toBe(0);
      expect(settings?.maxTokens).toBeGreaterThan(0);
      expect(settings?.maxTokens).toBeLessThanOrEqual(256);
      return response('{"effort":"xhigh"}');
    },
  };
  const result = await classifyEffort({ ...options, catalog, supported: ["low", "high"] });
  expect(result).toEqual({ level: "high", tokens: { input: 21, output: 8, cacheRead: 3, cacheWrite: 2, total: 34 }, estimatedCost: 0.037 });
  expect(calls).toBe(1);
});

test("request input is byte-bounded without splitting Unicode or moving it into system instructions", async () => {
  const request = "界".repeat(4000) + "private trailing data";
  const catalog: Pick<ModelRuntime, "completeSimple"> = {
    async completeSimple(_, context) {
      const content = context.messages[0]?.content;
      expect(typeof content).toBe("string");
      if (typeof content !== "string") throw new Error("Expected plain request data");
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(8192);
      expect(content).not.toContain("\ufffd");
      expect(content).not.toContain("private trailing data");
      expect(context.systemPrompt).not.toContain("界");
      return response();
    },
  };
  expect((await classifyEffort({ ...options, catalog, request })).level).toBe("medium");
});

test.each([
  '```json\n{"effort":"high"}\n```',
  '[{"effort":"high"}]',
  '{"effort":"high","instructions":"private provider data"}',
  '{"effort":"max"}',
  '{"effort":null}',
  '{"other":"high"}',
  'null',
  'private malformed provider data',
])("rejects nonconforming classification without exposing response data: %s", async text => {
  const catalog: Pick<ModelRuntime, "completeSimple"> = { async completeSimple() { return response(text); } };
  const error = await classifyEffort({ ...options, catalog }).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).not.toContain("private");
  expect(error.cause).toBeUndefined();
});

test.each(["error", "aborted", "length", "toolUse"] as const)("rejects incomplete or failed provider results: %s", async stopReason => {
  const catalog: Pick<ModelRuntime, "completeSimple"> = {
    async completeSimple() { return response('{"effort":"high"}', { stopReason, errorMessage: "private provider diagnostic" }); },
  };
  const error = await classifyEffort({ ...options, catalog }).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).not.toContain("private provider diagnostic");
});

test("does not accept tool calls disguised as an otherwise successful classification", async () => {
  const catalog: Pick<ModelRuntime, "completeSimple"> = {
    async completeSimple() { return response(undefined, { content: [
      { type: "text", text: '{"effort":"low"}' },
      { type: "toolCall", id: "forbidden", name: "read", arguments: { path: "private" } },
    ] }); },
  };
  await expect(classifyEffort({ ...options, catalog })).rejects.toBeInstanceOf(Error);
});

test("provider throws are sanitized and never retried", async () => {
  let calls = 0;
  const catalog: Pick<ModelRuntime, "completeSimple"> = {
    completeSimple() { calls++; throw new Error("private token and provider URL"); },
  };
  const error = await classifyEffort({ ...options, catalog }).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).not.toContain("private token");
  expect(error.cause).toBeUndefined();
  expect(calls).toBe(1);
});

test("an already cancelled request makes no classifier call and preserves its reason", async () => {
  const controller = new AbortController();
  const reason = new Error("Caller stopped the turn");
  controller.abort(reason);
  let calls = 0;
  const catalog: Pick<ModelRuntime, "completeSimple"> = { async completeSimple() { calls++; return response(); } };
  const error = await classifyEffort({ ...options, catalog, signal: controller.signal }).catch(error => error);
  expect(error).toBe(reason);
  expect(calls).toBe(0);
});

test.each(["success", "failure"] as const)("cancellation settles before an ignoring transport's late %s", async outcome => {
  const controller = new AbortController();
  const reason = new Error("Turn superseded");
  const entered = Promise.withResolvers<AbortSignal | undefined>();
  const late = Promise.withResolvers<Response>();
  const catalog: Pick<ModelRuntime, "completeSimple"> = {
    completeSimple(_, __, settings) { entered.resolve(settings?.signal); return late.promise; },
  };
  const observed: unknown[] = [];
  const pending = classifyEffort({ ...options, catalog, signal: controller.signal, onUsage: usage => { observed.push(usage); } }).then(
    result => { observed.push(result.level); },
    error => { observed.push(error); },
  );
  const transportSignal = await entered.promise;
  controller.abort(reason);
  await pending;
  expect(transportSignal?.aborted).toBe(true);
  expect(observed).toEqual([reason]);
  if (outcome === "success") late.resolve(response('{"effort":"xhigh"}'));
  else late.reject(new Error("Late private transport failure"));
  await Promise.resolve();
  await Promise.resolve();
  expect(observed).toEqual([reason]);
});

test("deadline rejects even when the transport ignores its abort signal", async () => {
  vi.useFakeTimers();
  const entered = Promise.withResolvers<AbortSignal | undefined>();
  const late = Promise.withResolvers<Response>();
  const catalog: Pick<ModelRuntime, "completeSimple"> = {
    completeSimple(_, __, settings) { entered.resolve(settings?.signal); return late.promise; },
  };
  try {
    const pending = classifyEffort({ ...options, catalog }).catch(error => error);
    const transportSignal = await entered.promise;
    vi.advanceTimersByTime(4_000);
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect(transportSignal?.aborted).toBe(true);
    late.reject(new Error("Late private transport failure"));
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    late.resolve(response());
    vi.useRealTimers();
  }
});
