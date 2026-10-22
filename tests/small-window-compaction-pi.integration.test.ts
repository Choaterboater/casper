import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanUpAfterEach, fixture, stream, type Payload } from "./support/phase8-pi";
import { childTestLimit } from "./support/limits";

cleanUpAfterEach();

type Sent = Payload & { max_tokens?: number; max_completion_tokens?: number };
const summarises = (payload: Payload) => JSON.stringify(payload.messages[0]?.content ?? "").includes("context summarization assistant");

/** Answers like a local server: a short reply, and the prompt's size (4 characters a token) as its usage. */
function reply(payload: Payload): Response {
  const prompt = Math.ceil(JSON.stringify({ messages: payload.messages, tools: payload.tools }).length / 4);
  const usage = { id: "phase8", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: prompt, completion_tokens: 20, total_tokens: prompt + 20 } };
  return new Response(stream({ role: "assistant", content: summarises(payload) ? "## Goal\nSynthetic summary." : "Noted." }, "stop")
    + `data: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

test("a 32k window compacts before the reply's room runs out, and the conversation goes on", async () => {
  const f = await fixture(reply);
  const file = path.join(f.agent, "models.json");
  const models = JSON.parse(await readFile(file, "utf8"));
  // What Casper gives a model Ollama serves with 32,768 tokens: a quarter of the window for the reply.
  Object.assign(models.providers.fixture.models[0], { contextWindow: 32_768, maxTokens: 8_192 });
  await writeFile(file, JSON.stringify(models));
  const run = await f.run([path.join(import.meta.dir, "fixtures/pi-small-window-compaction.ts"), f.project]);
  expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
  const { percents } = JSON.parse(run.stdout.split("SMALL_WINDOW_RESULT=")[1]!) as { percents: Array<number | null> };
  const sent = f.payloads as Sent[];
  // Pi summarised the older requests: with its usual 20,000 kept word for word, a 32k window had nothing older.
  expect(sent.some(summarises)).toBe(true);
  // Every request kept room for a reply. Pi trims max_tokens to the window less the context and 4,096: without
  // compaction it fell to 1 and the model could not answer.
  const replies = sent.filter((payload) => !summarises(payload)).map((payload) => payload.max_completion_tokens ?? payload.max_tokens ?? 0);
  expect(replies).toHaveLength(8);
  expect(Math.min(...replies)).toBeGreaterThanOrEqual(4_096);
  // The context never filled the window, and the request after the summary measured well under what it was before.
  const known = percents.filter((percent) => percent !== null);
  expect(Math.max(...known)).toBeLessThan(100);
  expect(percents.at(-1)).toBeLessThan(Math.max(...known));
}, childTestLimit());
