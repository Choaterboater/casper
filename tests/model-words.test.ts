import { expect, test } from "bun:test";
import { matchModelWords, noModelMessage, type WordsModel } from "../src/runtime/model-words";
import { modelChangeRequest, namesModel } from "../src/app/model-words";

// Shaped like a real signed-in catalog: Anthropic directly, the same models under OpenRouter, and a local server.
const catalog: WordsModel[] = [
  { provider: "anthropic", id: "claude-opus-4-5" },
  { provider: "anthropic", id: "claude-opus-4-5-20251101" },
  { provider: "anthropic", id: "claude-opus-4-8" },
  { provider: "anthropic", id: "claude-opus-5" },
  { provider: "anthropic", id: "claude-opus-5-5" },
  { provider: "anthropic", id: "claude-opus-5-5-20260301" },
  { provider: "anthropic", id: "claude-sonnet-4-5" },
  { provider: "anthropic", id: "claude-sonnet-5" },
  { provider: "anthropic", id: "claude-3-7-sonnet-20250219" },
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "openrouter", id: "anthropic/claude-opus-5-5" },
  { provider: "openrouter", id: "anthropic/claude-sonnet-5" },
  { provider: "openrouter", id: "openai/gpt-5.5" },
  { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" },
  { provider: "ollama", id: "qwen3:8b" },
  { provider: "ollama", id: "qwen3:32b" },
  { provider: "ollama", id: "qwen2.5-coder:7b" },
];
const onAnthropic = { current: { provider: "anthropic", id: "claude-opus-4-8" } };
const one = (words: string, options = onAnthropic) => {
  const match = matchModelWords(words, catalog, options);
  return match.kind === "one" ? `${match.model.provider}/${match.model.id}` : match.kind;
};

test("loose words name the model the person means", () => {
  expect(one("opus 5.5")).toBe("anthropic/claude-opus-5-5");
  expect(one("Opus_5.5")).toBe("anthropic/claude-opus-5-5");
  expect(one("opus5.5")).toBe("anthropic/claude-opus-5-5");
  expect(one("claude opus 5.5")).toBe("anthropic/claude-opus-5-5");
  // The words end claude-opus-5; claude-opus-5-5 only starts with them.
  expect(one("opus 5")).toBe("anthropic/claude-opus-5");
  expect(one("sonnet 5")).toBe("anthropic/claude-sonnet-5");
  // A family alone: its newest version, never an older dated id.
  expect(one("opus")).toBe("anthropic/claude-opus-5-5");
  expect(one("sonnet")).toBe("anthropic/claude-sonnet-5");
  expect(one("haiku")).toBe("anthropic/claude-haiku-4-5");
  // A dated copy ranks below its undated alias.
  expect(one("opus 4.5")).toBe("anthropic/claude-opus-4-5");
  expect(one("opus 4.5 20251101")).toBe("anthropic/claude-opus-4-5-20251101");
  expect(one("qwen2.5 coder")).toBe("ollama/qwen2.5-coder:7b");
  expect(one("qwen3 8b")).toBe("ollama/qwen3:8b");
  expect(one("gpt 5.5")).toBe("openrouter/openai/gpt-5.5");
  expect(one("deepseek v4.1")).toBe("openrouter/deepseek/deepseek-v4.1-flash");
});

test("a leading provider narrows; the same id under two providers goes to the one in use, else it is several", () => {
  expect(one("openrouter opus 5.5")).toBe("openrouter/anthropic/claude-opus-5-5");
  expect(one("openrouter/opus 5.5")).toBe("openrouter/anthropic/claude-opus-5-5");
  expect(one("anthropic sonnet 5")).toBe("anthropic/claude-sonnet-5");
  expect(one("opus 5.5", { current: { provider: "openrouter", id: "openai/gpt-5.5" } })).toBe("openrouter/anthropic/claude-opus-5-5");
  const nowhere = matchModelWords("opus 5.5", catalog, { current: { provider: "ollama", id: "qwen3:8b" } });
  expect(nowhere).toEqual({ kind: "several", models: [{ provider: "anthropic", id: "claude-opus-5-5" }, { provider: "openrouter", id: "anthropic/claude-opus-5-5" }] });
});

test("sizes of one family are several, never a silent guess", () => {
  const match = matchModelWords("qwen3", catalog, onAnthropic);
  expect(match.kind).toBe("several");
  expect(match.kind === "several" && match.models.map((model) => model.id)).toEqual(["qwen3:8b", "qwen3:32b"]);
});

// OpenRouter beside a local server and Anthropic, with the names that look like ordinary words.
const wide: WordsModel[] = [
  ...catalog,
  ...["anthropic/claude-3-haiku", "anthropic/claude-sonnet-4", "~anthropic/claude-opus-latest", "anthropic/claude-opus-4.1", "anthropic/claude-opus-4.1:batch",
    "qwen/qwen3.8-2.4t-a95b", "qwen/qwen3.8-flash", "qwen/qwen3-coder", "qwen/qwen3-coder-next", "relace/relace-search", "openai/gpt-realtime",
    "deepseek/deepseek-v3.2", "meta-llama/llama-3.3-70b-instruct", "cohere/command-r-08-2024", "stepfun/step-3.7-flash"]
    .map((id) => ({ provider: "openrouter", id })),
];
const ids = (words: string, current: { provider: string; id: string }, head = false) => {
  const match = matchModelWords(words, wide, { current, head });
  return match.kind === "one" ? `${match.model.provider}/${match.model.id}` : match.kind === "several" ? match.models.map((model) => `${model.provider}/${model.id}`) : match.kind;
};

test("a brand alone, a cloud model beside a local one, or a better match only elsewhere is several, never a silent guess", () => {
  const anthropic = onAnthropic.current;
  const local = { provider: "ollama", id: "qwen3:8b" };
  // `claude` names Opus, Sonnet and Haiku: the newest of each, never Claude 3 alone.
  expect(ids("claude", anthropic)).toEqual(["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5", "anthropic/claude-haiku-4-5", "anthropic/claude-3-7-sonnet-20250219"]);
  expect(ids("gpt", anthropic)).toEqual(["openrouter/openai/gpt-5.5", "openrouter/openai/gpt-realtime"]);
  // On the local server, its own qwen3 sizes; a 2.4T size is a size, not version 2.4.
  expect(ids("qwen3", local)).toEqual(["ollama/qwen3:8b", "ollama/qwen3:32b"]);
  expect(ids("qwen3", anthropic)).toEqual(["openrouter/qwen/qwen3.8-flash", "ollama/qwen3:8b", "ollama/qwen3:32b", "openrouter/qwen/qwen3-coder"]);
  // Sonnet 4 is only on OpenRouter; your provider has Sonnet 4.5: both, to pick from.
  expect(ids("sonnet 4", anthropic)).toEqual(["openrouter/anthropic/claude-sonnet-4", "anthropic/claude-sonnet-4-5"]);
  // An OpenRouter `~…-latest` alias is not another family.
  expect(ids("opus", anthropic)).toBe("anthropic/claude-opus-5-5");
  expect(ids("sonnet", anthropic)).toBe("anthropic/claude-sonnet-5");
});

test("for a typed line the words must start the model's name, after its vendor and claude-", () => {
  const anthropic = onAnthropic.current;
  expect(ids("next", anthropic)).toBe("openrouter/qwen/qwen3-coder-next");
  for (const words of ["next", "search", "realtime", "r", "v3", "70b", "image"]) expect([words, ids(words, anthropic, true)]).toEqual([words, "none"]);
  expect(ids("opus 5.5", anthropic, true)).toBe("anthropic/claude-opus-5-5");
  expect(ids("sonnet", anthropic, true)).toBe("anthropic/claude-sonnet-5");
  expect(ids("step", anthropic, true)).toBe("openrouter/stepfun/step-3.7-flash");
  // Old names: the family after claude- and its version.
  expect(matchModelWords("sonnet", [{ provider: "anthropic", id: "claude-3-7-sonnet-20250219" }], { head: true }).kind).toBe("one");
});

test("an effort suffix stays with the words", () => {
  expect(matchModelWords("opus 5.5:high", catalog, onAnthropic)).toEqual({ kind: "one", model: { provider: "anthropic", id: "claude-opus-5-5" }, effort: "high" });
});

test("words that name nothing list the closest few", () => {
  const match = matchModelWords("opus 9", catalog, onAnthropic);
  expect(match.kind).toBe("none");
  expect(match.kind === "none" && match.closest.length).toBe(3);
  expect(match.kind === "none" && match.closest.every((model) => model.id.includes("opus"))).toBe(true);
  // The newest of the family first, one per name, no ~alias or :batch copy; a number alone is near nothing.
  const far = matchModelWords("opus 9", wide, onAnthropic);
  expect(far.kind === "none" && far.closest.map((model) => `${model.provider}/${model.id}`))
    .toEqual(["anthropic/claude-opus-5-5", "anthropic/claude-opus-5", "anthropic/claude-opus-4-8"]);
  expect(matchModelWords("vue 3", wide, onAnthropic)).toEqual({ kind: "none", closest: [] });
  expect(matchModelWords("secon", catalog)).toEqual({ kind: "none", closest: [] });
  // Part of a word is no word: the /model browser opens on it instead.
  expect(matchModelWords("son", catalog).kind).toBe("none");
  expect(noModelMessage("opus 9", [{ provider: "anthropic", id: "claude-opus-5-5" }]))
    .toBe('No model matches "opus 9"; closest: anthropic/claude-opus-5-5. /model to see all. Model unchanged.');
  expect(noModelMessage("zzz", [])).toBe('No model matches "zzz". /model to see all. Model unchanged.');
});

test("a typed line that only asks to change the model is read; coding requests about a model are not", () => {
  expect(modelChangeRequest("change model to opus 5.5")).toBe("opus 5.5");
  expect(modelChangeRequest("Change the model to Opus 5.5.")).toBe("Opus 5.5");
  expect(modelChangeRequest("switch to sonnet 5")).toBe("sonnet 5");
  expect(modelChangeRequest("use opus")).toBe("opus");
  expect(modelChangeRequest("use the opus model")).toBe("opus");
  expect(modelChangeRequest("set model to anthropic/claude-opus-5-5")).toBe("anthropic/claude-opus-5-5");
  expect(modelChangeRequest("please switch model to qwen3:8b")).toBe("qwen3:8b");
  for (const line of [
    "change the model class in models.py to use a dataclass",
    "change the model in src/models.py to opus",
    "change model to `Opus`",
    "use models.py",
    "switch to the main branch and fix the tests",
    "use flash",
    "switch to auto",
    "use the latest",
    "change model to opus 5.5 and then fix the failing test in the parser",
    "change model to opus 5.5\nand explain why",
    "rename the model to Opus",
    "can you change model to opus 5.5 after this",
    // Ordinary coding words: without "model" in the line, a bare word must be a model family or carry a version.
    "use next", "switch to next", "use search", "use image", "use realtime", "use batch", "use step", "use command",
    "switch to main", "use bun", "use the 70b model", "use 70b", "switch to v3", "use r", "use x",
  ]) expect([line, modelChangeRequest(line)]).toEqual([line, undefined]);
  expect(modelChangeRequest("use the step model")).toBe("step");
  expect(modelChangeRequest("use claude")).toBe("claude");
  expect(modelChangeRequest("switch to qwen3")).toBe("qwen3");
  // A pasted piece never counts.
  expect(modelChangeRequest("change model to opus 5.5", ["opus 5.5"])).toBeUndefined();
});

test("the typed-line check asks for words that start a model's name, and during a task does not wait for local servers", async () => {
  const asked: unknown[] = [];
  const session = { matchModel: async (words: string, options?: unknown) => { asked.push([words, options]); return { kind: "none" as const, closest: [] }; } };
  expect(await namesModel(session, "opus")).toBe(false);
  expect(await namesModel(session, "opus", false)).toBe(false);
  expect(asked).toEqual([["opus", { head: true }], ["opus", { head: true, wait: false }]]);
});
