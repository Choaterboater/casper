import { afterEach, expect, test } from "bun:test";
import { complete } from "@earendil-works/pi-ai/compat";

/** Pi (patched, see patches/) takes the charge OpenRouter reports in usage.cost over the catalog price. */
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function chunk(body: unknown): string { return `data: ${JSON.stringify(body)}\n\n`; }

async function costFor(usage: Record<string, unknown>): Promise<number> {
  const base = { id: "cost", object: "chat.completion.chunk", created: 1, model: "fixture" };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    await request.json();
    return new Response(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: "stop" }] })
      + chunk({ ...base, choices: [], usage }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  servers.push(server);
  // $1 per million of everything: 1M cached tokens is $1 by the catalog.
  const model = { id: "fixture", name: "fixture", api: "openai-completions", provider: "openrouter", baseUrl: `http://127.0.0.1:${server.port}/v1`,
    reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, contextWindow: 100_000, maxTokens: 1000 };
  const message = await complete(model as never, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { apiKey: "local-fixture-not-a-secret" });
  return message.usage.cost.total;
}

const tokens = { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 1_000_000 } };

test("the reported charge replaces the catalog estimate", async () => {
  expect(await costFor({ ...tokens, cost: 0.0421 })).toBeCloseTo(0.0421, 10);
});

test("with your own provider key, the provider's charge is added to OpenRouter's fee", async () => {
  expect(await costFor({ ...tokens, cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: 0.04 } })).toBeCloseTo(0.041, 10);
});

test("no reported charge, or one that is not a number, keeps the catalog estimate", async () => {
  expect(await costFor(tokens)).toBeCloseTo(1, 10);
  expect(await costFor({ ...tokens, cost: null })).toBeCloseTo(1, 10);
  expect(await costFor({ ...tokens, cost: "0.5" })).toBeCloseTo(1, 10);
});
