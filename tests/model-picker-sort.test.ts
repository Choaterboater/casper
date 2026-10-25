import { afterEach, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { forgetModelFacts, modelFacts, type ModelFacts } from "../src/runtime/model-facts";
import { forgetOpenRouterModels, openRouterModelFacts, OPENROUTER_MODELS_URL, OPENROUTER_ZDR_URL, startOpenRouterModels, type OpenRouterModel } from "../src/runtime/openrouter-models";
import { ModelBrowser, MODEL_SORTS, type ModelBrowserCatalog, type ModelSort } from "../src/runtime/pi-model-browser";
import { pickerMemory, pickPiModel } from "../src/runtime/pi-model-picker";
import type { RuntimePickerView } from "../src/runtime/types";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
const lifetimes: AbortController[] = [];
afterEach(async () => {
  for (const lifetime of lifetimes.splice(0)) lifetime.abort();
  forgetOpenRouterModels();
  forgetModelFacts();
  pickerMemory.sort = "usual";
  await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir)));
});

const CTRL_O = "\x0f";
const day = (date: string) => Date.parse(`${date}T00:00:00Z`);

function fakeModel(provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id, name: id, api: "openai-completions", provider, baseUrl: "http://127.0.0.1:9/v1",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000, maxTokens: 4_000, ...overrides,
  } as Model<Api>;
}
const priced = (input: number, output: number) => ({ cost: { input, output, cacheRead: 0, cacheWrite: 0 } });

// One catalog with every case: another provider's paid model, a plan, a free model on this computer, and OpenRouter's
// models with what its list says about them (free or not, a router's price that depends on the model it picks).
const models = [
  fakeModel("anthropic", "claude-x", { ...priced(3, 15), contextWindow: 200_000 }),
  fakeModel("claude-subscription", "claude-x", { ...priced(3, 15), contextWindow: 200_000 }),
  fakeModel("ollama", "qwen-local", { contextWindow: 0 }),
  fakeModel("openrouter", "vendor-z/old-free:free", { contextWindow: 32_768 }),
  // The engine's list prices a router at 0.
  fakeModel("openrouter", "vendor-e/router", { contextWindow: 2_000_000 }),
  fakeModel("openrouter", "vendor-d/pricey", { ...priced(3, 15), contextWindow: 1_048_576, reasoning: true, input: ["text", "image"] }),
  fakeModel("openrouter", "vendor-c/cheap", { ...priced(0.1, 0.4), contextWindow: 262_144 }),
  fakeModel("openrouter", "vendor-b/new-free:free", { contextWindow: 131_072 }),
];
const facts: Record<string, ModelFacts> = {
  "openrouter/vendor-z/old-free:free": { free: true, price: { input: 0, output: 0 }, contextWindow: 32_768, created: day("2026-01-01"), tools: true, intelligence: 20 },
  "openrouter/vendor-e/router": { free: false, contextWindow: 2_000_000, created: day("2025-05-01"), tools: true },
  "openrouter/vendor-d/pricey": { free: false, price: { input: 3, output: 15 }, contextWindow: 1_048_576, created: day("2026-09-01"), tools: true,
    intelligence: 55.1, coding: 57, agentic: 28.7, codingRank: 7 },
  "openrouter/vendor-c/cheap": { free: false, price: { input: 0.1, output: 0.4 }, contextWindow: 262_144, created: day("2026-06-01"), tools: true, intelligence: 30 },
  "openrouter/vendor-b/new-free:free": { free: true, price: { input: 0, output: 0 }, contextWindow: 131_072, created: day("2026-10-20"), tools: true },
};
const lookup = (provider: string, id: string) => facts[`${provider}/${id}`];

const ORDERS: Record<ModelSort, string[]> = {
  usual: ["anthropic/claude-x", "claude-subscription/claude-x", "ollama/qwen-local", "openrouter/vendor-z/old-free:free", "openrouter/vendor-e/router",
    "openrouter/vendor-d/pricey", "openrouter/vendor-c/cheap", "openrouter/vendor-b/new-free:free"],
  // Free ones newest first (one with no date after them), then the paid ones cheapest first; a plan and a router have no
  // price to sort by.
  free: ["openrouter/vendor-b/new-free:free", "openrouter/vendor-z/old-free:free", "ollama/qwen-local", "openrouter/vendor-c/cheap", "anthropic/claude-x",
    "openrouter/vendor-d/pricey", "claude-subscription/claude-x", "openrouter/vendor-e/router"],
  cheapest: ["ollama/qwen-local", "openrouter/vendor-z/old-free:free", "openrouter/vendor-b/new-free:free", "openrouter/vendor-c/cheap", "anthropic/claude-x",
    "openrouter/vendor-d/pricey", "claude-subscription/claude-x", "openrouter/vendor-e/router"],
  newest: ["openrouter/vendor-b/new-free:free", "openrouter/vendor-d/pricey", "openrouter/vendor-c/cheap", "openrouter/vendor-z/old-free:free", "openrouter/vendor-e/router",
    "anthropic/claude-x", "claude-subscription/claude-x", "ollama/qwen-local"],
  score: ["openrouter/vendor-d/pricey", "openrouter/vendor-c/cheap", "openrouter/vendor-z/old-free:free", "anthropic/claude-x", "claude-subscription/claude-x",
    "ollama/qwen-local", "openrouter/vendor-e/router", "openrouter/vendor-b/new-free:free"],
  context: ["openrouter/vendor-e/router", "openrouter/vendor-d/pricey", "openrouter/vendor-c/cheap", "anthropic/claude-x", "claude-subscription/claude-x",
    "openrouter/vendor-b/new-free:free", "openrouter/vendor-z/old-free:free", "ollama/qwen-local"],
};

function fakeCatalog(list: readonly Model<Api>[]): ModelBrowserCatalog {
  return { getAvailableSnapshot: () => list, getError: () => undefined, refresh: async () => ({ aborted: false, errors: new Map() }) };
}
const fakeTui = () => ({ requestRender() {}, terminal: { rows: 24, columns: 200 } }) as unknown as TUI;

/** Runs `body` with /model's keys as pickPiModel registers them. */
function withPickerKeys(body: () => void | Promise<void>) {
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, "casper.models.sort": { defaultKeys: "ctrl+o", description: "Change the order of the models" } }));
  return Promise.resolve().then(body).finally(() => setKeybindings(previous));
}

function browser(options: { sort?: ModelSort; onSort?: (sort: ModelSort) => void; query?: string; list?: readonly Model<Api>[] } = {}) {
  return new ModelBrowser({ tui: fakeTui(), catalog: fakeCatalog(options.list ?? models), color: false, sessionOnly: false, onSelect() {}, onCancel() {},
    facts: lookup, ...options.sort ? { sort: options.sort } : {}, ...options.onSort ? { onSort: options.onSort } : {},
    ...options.query ? { initialQuery: options.query } : {} });
}
const text = (picker: ModelBrowser, width = 200) => picker.render(width).join("\n");
/** The right side's rows, top to bottom, as provider/id. */
const rows = (picker: ModelBrowser, width = 200) => text(picker, width).split("\n")
  .map((line) => (line.split(" │ ")[1] ?? "").match(/^\s*(?:❯\s+)?\d+\.\s+(\S+)/)?.[1]).filter((label): label is string => Boolean(label));
/** The right side of the list row for `label`. */
const row = (picker: ModelBrowser, label: string, width = 200) => text(picker, width).split("\n").map((line) => line.split(" │ ")[1] ?? "")
  .find((line) => line.includes(` ${label} `)) ?? "";
const firstRow = (picker: ModelBrowser, width: number) => text(picker, width).split("\n").map((line) => line.split(" │ ")[1] ?? "")
  .find((line) => /^\s*(?:❯\s+)?1\.\s/.test(line)) ?? "";
/** The line under the list: the highlighted model's details. */
const details = (picker: ModelBrowser, width = 200) => picker.render(width).at(-3)!;

test("Ctrl+O steps through the orders from either side; the header names the order, and a model with nothing to sort by goes last", async () => {
  await withPickerKeys(() => {
    const told: ModelSort[] = [];
    const picker = browser({ onSort: (sort) => told.push(sort) });
    try {
      expect(rows(picker)).toEqual(ORDERS.usual);
      expect(text(picker)).not.toContain("sorted:");
      // The providers have the keys when it opens; the list's side takes the key too.
      expect(text(picker)).toContain("Tab models · type to search · Ctrl+O sort");
      const names: Record<ModelSort, string> = { usual: "", free: "free first", cheapest: "cheapest", newest: "newest", score: "AA score", context: "largest context" };
      for (const sort of MODEL_SORTS.slice(1)) {
        picker.handleInput(CTRL_O);
        expect(rows(picker)).toEqual(ORDERS[sort]);
        expect(text(picker)).toContain(`All models (8) · sorted: ${names[sort]}`);
        if (sort === "cheapest") {
          picker.handleInput("\t");
          expect(text(picker)).toContain("Tab providers · Ctrl+S this session only · Ctrl+O sort");
        }
      }
      picker.handleInput(CTRL_O);
      expect(rows(picker)).toEqual(ORDERS.usual);
      expect(text(picker)).not.toContain("sorted:");
      expect(told).toEqual([...MODEL_SORTS.slice(1), "usual"]);
    } finally { picker.dispose(); }
  });
});

test("each order starts at its top row, and search words keep the order among the models they match", async () => {
  await withPickerKeys(() => {
    // With no order chosen the best match comes first; with one, the matches follow it.
    const relevance = browser({ query: "vendor-c" });
    const newest = browser({ sort: "newest", query: "vendor-c" });
    const listed = browser({ sort: "newest" });
    try {
      expect(rows(relevance)).toEqual(["openrouter/vendor-c/cheap", "openrouter/vendor-d/pricey"]);
      expect(rows(newest)).toEqual(["openrouter/vendor-d/pricey", "openrouter/vendor-c/cheap"]);
      listed.handleInput("\t");
      listed.handleInput("\x1b[B");
      expect(text(listed)).toContain("❯ 2. openrouter/vendor-d/pricey");
      listed.handleInput(CTRL_O); // newest → AA score: the highlight goes back to the top.
      expect(text(listed)).toContain("❯ 1. openrouter/vendor-d/pricey");
      expect(rows(listed)).toEqual(ORDERS.score);
    } finally { relevance.dispose(); newest.dispose(); listed.dispose(); }
  });
});

test("each row shows the AA score, — for a model it hasn't rated (never a number), and the source is named once under the header", () => {
  const picker = browser({ sort: "score" });
  try {
    expect(row(picker, "openrouter/vendor-d/pricey")).toMatch(/AA 55 · +1m ctx/);
    expect(row(picker, "openrouter/vendor-c/cheap")).toMatch(/AA 30 · +262k ctx/);
    for (const label of ["anthropic/claude-x", "openrouter/vendor-b/new-free:free", "openrouter/vendor-e/router"]) {
      expect(row(picker, label)).toMatch(/ — · /);
      expect(row(picker, label)).not.toMatch(/AA\s+\d/);
    }
    const shown = text(picker);
    expect(shown.match(/Artificial Analysis/g)).toHaveLength(1);
    expect(shown).toContain("AA: Artificial Analysis Intelligence Index · higher is smarter · — not rated");
    // The columns stay in line: a row with no score has its — where the others have their number.
    expect(row(picker, "anthropic/claude-x").indexOf("—") + 1).toBe(row(picker, "openrouter/vendor-d/pricey").indexOf("AA 55") + "AA 55".length);
    // A provider with no scores shows no score column and no legend, as before.
    const plain = browser({ list: [fakeModel("anthropic", "claude-x", priced(3, 15))] });
    try {
      expect(text(plain)).not.toContain("—");
      expect(text(plain)).not.toContain("Artificial Analysis");
    } finally { plain.dispose(); }
  } finally { picker.dispose(); }
});

test("the line under the list adds the highlighted model's coding and agentic indexes, Design Arena coding rank and the day OpenRouter added it", () => {
  const scored = browser({ sort: "score" });
  const unrated = browser({ sort: "newest" });
  const router = browser({ sort: "context" });
  try {
    expect(details(scored)).toBe("  vendor-d/pricey · openrouter/vendor-d/pricey · 1m ctx · 4k out · $3/15 per M · AA 55.1 (coding 57, agentic 28.7) · "
      + "Design Arena coding #7 · added 2026-09-01 · reasoning · vision");
    expect(details(unrated)).toBe("  vendor-b/new-free:free · openrouter/vendor-b/new-free:free · 131k ctx · 4k out · free · AA not rated · added 2026-10-20");
    // A router's price is the model it picks: it never reads as free.
    expect(details(router)).toContain("2m ctx · 4k out · price varies · AA not rated");
    expect(row(router, "openrouter/vendor-e/router")).toContain("varies");
    expect(row(router, "openrouter/vendor-e/router")).not.toContain("free");
  } finally { scored.dispose(); unrated.dispose(); router.dispose(); }
});

test("a narrow terminal drops the score column first, then the tags, then the price; every line fits", () => {
  const picker = browser({ sort: "score" });
  try {
    // 120 columns: the list gets 95.
    expect(row(picker, "openrouter/vendor-d/pricey", 120)).toMatch(/AA 55 · +1m ctx · +\$3\/15 · reasoning · vision/);
    expect(text(picker, 120)).toContain("AA: Artificial Analysis");
    // 100 columns: the list gets 75, so the score goes; the tags stay.
    expect(firstRow(picker, 100)).toMatch(/openrouter\/vendor-d\/.*1m ctx · +\$3\/15 · reasoning · vision/);
    expect(firstRow(picker, 100)).not.toContain("AA");
    expect(text(picker, 100)).not.toContain("Artificial Analysis");
    expect(firstRow(picker, 70)).toMatch(/openrouter\/vendor-d.*1m ctx · +\$3\/15\s*$/);
    expect(firstRow(picker, 70)).not.toContain("AA");
    for (const width of [40, 60, 80, 100, 120, 160, 200]) {
      for (const line of picker.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  } finally { picker.dispose(); }
});

test("the order stays between /model opens until Casper quits", async () => {
  const shown: ModelBrowser[] = [];
  const tui = { addInputListener: () => () => {}, requestRender() {}, setFocus() {}, terminal: { rows: 24, columns: 160 } };
  const view = { tui, color: false, show(component: ModelBrowser) { shown.push(component); }, onEOF() {} } as unknown as RuntimePickerView;
  const catalog = fakeCatalog(models) as unknown as ModelRuntime;
  const first = pickPiModel(view, catalog, undefined, undefined, undefined);
  shown[0]!.handleInput(CTRL_O);
  shown[0]!.handleInput("\x1b");
  expect(await first).toBeUndefined();
  expect(pickerMemory.sort).toBe("free");
  const second = pickPiModel(view, catalog, undefined, undefined, undefined);
  expect(shown[1]!.render(160).join("\n")).toContain("sorted: free first");
  shown[1]!.handleInput("\x1b");
  expect(await second).toBeUndefined();
});

/** One model as OpenRouter's list has it (prices in US dollars per token, as text). */
const listed = (id: string, extra: Partial<OpenRouterModel> = {}): OpenRouterModel => ({
  id, name: id, context_length: 131_072, pricing: { prompt: "0.0000002", completion: "0.0000008" },
  architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["tools", "tool_choice"],
  top_provider: { context_length: 131_072, max_completion_tokens: 32_768 }, ...extra,
});
const benchmarks = (intelligence: number | null, coding: number | null, agentic: number | null, rank?: number): OpenRouterModel["benchmarks"] => ({
  artificial_analysis: { intelligence_index: intelligence, coding_index: coding, agentic_index: agentic },
  design_arena: [{ arena: "models", category: "website", elo: 1300, win_rate: 55, rank: 2 },
    ...rank ? [{ arena: "models", category: "codecategories", elo: 1349, win_rate: 60.1, rank }] : []],
});

test("what OpenRouter's list says about a model: free or its price, window, when it was added, tools, and its scores", () => {
  expect(openRouterModelFacts(listed("vendor-d/new", { created: 1_792_778_188, benchmarks: benchmarks(55.1, 57, null, 7) }))).toEqual({
    free: false, price: { input: 0.2, output: 0.8 }, contextWindow: 131_072, created: 1_792_778_188_000, tools: true, intelligence: 55.1, coding: 57, codingRank: 7,
  });
  expect(openRouterModelFacts(listed("vendor-d/new:free", { pricing: { prompt: "0", completion: "0" }, supported_parameters: ["reasoning"] }))).toEqual({
    free: true, price: { input: 0, output: 0 }, contextWindow: 131_072, tools: false,
  });
  // A router's price is whatever model it picks: none, and not free. A rank on another board isn't the coding rank.
  expect(openRouterModelFacts(listed("vendor-r/router", { pricing: { prompt: "-1", completion: "-1" }, benchmarks: benchmarks(null, null, null), created: -5 })))
    .toEqual({ free: false, contextWindow: 131_072, tools: true });
});

test("the score and the day added come from the same read of OpenRouter's list as the models it adds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-model-sort-")); dirs.push(dir);
  await writeFile(path.join(dir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-placeholder-0000" } }), { mode: 0o600 });
  const catalog = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json"), refreshOnCreate: false });
  await catalog.refresh({ providers: ["openrouter"], allowNetwork: false });
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    return Response.json({ data: [
      listed("vendor-d/older", { created: 1_700_000_000 }),
      listed("vendor-d/new-model", { created: 1_792_778_188, benchmarks: benchmarks(55.1, 57, null, 7) }),
    ] });
  };
  const lifetime = new AbortController(); lifetimes.push(lifetime);
  await startOpenRouterModels(catalog, lifetime.signal, { env: {}, fetch, freshMs: 0 }).ready;
  // The model list, and beside it the zero-data-retention list (a different question): no other request.
  expect(urls).toEqual([OPENROUTER_MODELS_URL, OPENROUTER_ZDR_URL]);
  expect(modelFacts("openrouter", "vendor-d/new-model")).toMatchObject({ intelligence: 55.1, created: 1_792_778_188_000 });
  // The engine's own catalog, as /model reads it, with no second request and no facts passed in.
  const picker = new ModelBrowser({ tui: fakeTui(), catalog: { ...fakeCatalog([]), getAvailableSnapshot: () => catalog.getAvailableSnapshot() },
    color: false, sessionOnly: false, onSelect() {}, onCancel() {}, initialScope: "openrouter", sort: "newest" });
  try {
    const order = rows(picker);
    expect(order.indexOf("openrouter/vendor-d/new-model")).toBe(0);
    expect(order.indexOf("openrouter/vendor-d/older")).toBe(1);
    expect(row(picker, "openrouter/vendor-d/new-model")).toMatch(/AA 55 · +131k ctx/);
    expect(row(picker, "openrouter/vendor-d/older")).toMatch(/ — · /);
    expect(details(picker)).toContain("AA 55.1 (coding 57) · Design Arena coding #7 · added 2026-10-23");
    expect(urls).toHaveLength(2);
  } finally { picker.dispose(); }
});
