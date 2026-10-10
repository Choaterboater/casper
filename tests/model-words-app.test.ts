import { afterAll, expect, test } from "bun:test";
import type { AgentRuntime, RuntimeModelSelectionOptions, RuntimeStatus } from "../src/runtime/types";
import { matchModelWords, noModelMessage, type WordsModel } from "../src/runtime/model-words";
import { richApp } from "./support/app";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const catalog: WordsModel[] = [
  { provider: "anthropic", id: "claude-opus-4-8" },
  { provider: "anthropic", id: "claude-opus-5" },
  { provider: "anthropic", id: "claude-opus-5-5" },
  { provider: "anthropic", id: "claude-sonnet-5" },
  { provider: "ollama", id: "qwen3:8b" },
  { provider: "ollama", id: "qwen3:32b" },
];

/** A runtime whose selectModel keeps the real session's contract for words (src/runtime/pi-models.ts select()):
 * one match selects and says `from`, several ask `choose`, none is an error with the closest. Each prompt is counted. */
function wordsRuntime(working?: Promise<void>) {
  let status: RuntimeStatus = { provider: "anthropic", model: "claude-opus-4-8", auth: "configured" };
  const prompts: string[] = [];
  const started = Promise.withResolvers<void>();
  const runtime: AgentRuntime = {
    async start() {
      return {
        setTools: () => {},
        getStatus: () => status,
        getState: () => ({ cwd: "", isStreaming: working !== undefined }),
        subscribe: () => () => {},
        abort: async () => {},
        matchModel: async (words) => {
          const match = matchModelWords(words, catalog);
          return match.kind === "one" ? { kind: "one", model: match.model } : match.kind === "several" ? { kind: "several", models: match.models } : match;
        },
        selectModel: async (options: RuntimeModelSelectionOptions) => {
          const exact = catalog.find((model) => `${model.provider}/${model.id}` === options.query);
          let picked = exact; let from: string | undefined;
          if (!picked && options.query) {
            const match = matchModelWords(options.query, catalog);
            if (match.kind === "none") throw new Error(noModelMessage(options.query, match.closest));
            if (match.kind === "one") picked = match.model;
            else {
              const listed = match.models.map((model) => ({ ...model, name: model.id }));
              if (!options.choose) return { status, selected: false, savedDefault: false, candidates: listed };
              const chosen = await options.choose(listed);
              if (!chosen) return { status, selected: false, savedDefault: false };
              picked = chosen;
            }
            from = options.query;
          }
          status = { ...status, provider: picked!.provider, model: picked!.id };
          return { status, selected: true, savedDefault: options.persist !== false, ...(from ? { from } : {}) };
        },
        prompt: async (text: string) => { prompts.push(text); started.resolve(); await working; },
      };
    },
    async dispose() {},
  };
  return { runtime, prompts, started: started.promise };
}

test("/model <words> selects the one model they name and says which; several ask by number; none names the closest", async () => {
  const fake = wordsRuntime();
  const app = await richApp(() => fake.runtime);
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("/model opus 5.5\r");
    await app.until(text => text.includes('[model] anthropic/claude-opus-5-5 (from "opus 5.5")'));
    app.input.write("/model qwen3\r");
    await app.until(text => text.includes('"qwen3" names 2 models. Which one?'));
    app.input.write("2");
    await app.until(text => text.includes('[model] ollama/qwen3:32b (from "qwen3")'));
    app.input.write("/model opus 9\r");
    await app.until(text => text.includes('No model matches "opus 9"; closest:'));
    expect(app.screen()).toContain("/model to see all. Model unchanged.");
    expect(fake.prompts).toEqual([]);
  } finally { await app.close(); }
}, 30_000);

test("the owner's line \"change model to opus 5.5\" is done here with no model call; a coding request about a model goes to the AI", async () => {
  const fake = wordsRuntime();
  const app = await richApp(() => fake.runtime);
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("change model to opus 5.5\r");
    await app.until(text => text.includes('[model] anthropic/claude-opus-5-5 (from "opus 5.5")'));
    expect(app.screen()).toContain("[model] Handled here, no model call: /model opus 5.5 does the same.");
    expect(fake.prompts).toEqual([]);
    // Words that look alike but name no model, or are about code, are ordinary requests.
    app.input.write("change the model class in models.py to opus\r");
    await app.until(() => fake.prompts.length === 1);
    expect(fake.prompts[0]).toContain("change the model class in models.py to opus");
    // An ordinary word that only ends a model's name ("next" in qwen3-coder-next) is a request too.
    app.input.write("use next\r");
    await app.until(() => fake.prompts.length === 2);
    expect(fake.prompts[1]).toContain("use next");
    expect(app.screen().match(/Handled here/g)).toHaveLength(1);
  } finally { await app.close(); }
}, 30_000);

test("during a task: /model <words> and a typed \"switch to sonnet 5\" apply from the model's next step and never reach the AI", async () => {
  const gate = Promise.withResolvers<void>();
  const fake = wordsRuntime(gate.promise);
  const app = await richApp(() => fake.runtime);
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("write a poem\r");
    await fake.started;
    app.input.write("/model opus 5\r");
    await app.until(text => text.includes('[model] anthropic/claude-opus-5 (from "opus 5") from the model\'s next step; saved'));
    app.input.write("switch to sonnet 5\r");
    await app.until(text => text.includes('[model] anthropic/claude-sonnet-5 (from "sonnet 5") from the model\'s next step; saved'));
    expect(app.screen()).toContain("[model] Handled here, no model call: /model sonnet 5 does the same.");
    // Neither line went to the AI: not read at its next step, not queued as the next request.
    expect(fake.prompts).toHaveLength(1);
    expect(app.app.queuedLines).toEqual([]);
    expect(app.screen()).not.toMatch(/sent to Casper|queued · runs when/);
    gate.resolve();
  } finally { gate.resolve(); await app.close(); }
}, 30_000);
