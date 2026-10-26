import { afterEach, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { forgetModelFacts, modelFacts, setModelFacts, type ModelFacts } from "../src/runtime/model-facts";
import { forgetOpenRouterModels, openRouterModelFacts, OPENROUTER_MODELS_URL, OPENROUTER_ZDR_URL, startOpenRouterModels, type OpenRouterModel } from "../src/runtime/openrouter-models";
import { ModelBrowser, MODEL_VIEWS, type ModelBrowserCatalog, type ModelView } from "../src/runtime/pi-model-browser";
import { pickerMemory, pickPiModel } from "../src/runtime/pi-model-picker";
import type { RuntimePickerView } from "../src/runtime/types";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
const lifetimes: AbortController[] = [];
afterEach(async () => {
  for (const lifetime of lifetimes.splice(0)) lifetime.abort();
  forgetOpenRouterModels();
  forgetModelFacts();
  pickerMemory.view = undefined;
  await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir)));
});

const CTRL_O = "\x0f";
const [UP, DOWN, ESC, BACKSPACE] = ["\x1b[A", "\x1b[B", "\x1b", "\x7f"];
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

/** OpenRouter's models in each of its rows in the left list, top to bottom; "usual" is the openrouter row's own order. */
const ORDERS: Record<ModelView | "usual", string[]> = {
  usual: ["vendor-z/old-free:free", "vendor-e/router", "vendor-d/pricey", "vendor-c/cheap", "vendor-b/new-free:free"],
  // Only the free ones, newest first.
  free: ["vendor-b/new-free:free", "vendor-z/old-free:free"],
  // Free ones cost nothing (a tie keeps the usual order); a router has no price of its own, so it goes last.
  cheapest: ["vendor-z/old-free:free", "vendor-b/new-free:free", "vendor-c/cheap", "vendor-d/pricey", "vendor-e/router"],
  newest: ["vendor-b/new-free:free", "vendor-d/pricey", "vendor-c/cheap", "vendor-z/old-free:free", "vendor-e/router"],
  // Not rated goes last, in the usual order: never read as a low score.
  smartest: ["vendor-d/pricey", "vendor-c/cheap", "vendor-z/old-free:free", "vendor-e/router", "vendor-b/new-free:free"],
};

function fakeCatalog(list: readonly Model<Api>[]): ModelBrowserCatalog {
  return { getAvailableSnapshot: () => list, getError: () => undefined, refresh: async () => ({ aborted: false, errors: new Map() }) };
}
const fakeTui = () => ({ requestRender() {}, terminal: { rows: 24, columns: 200 } }) as unknown as TUI;

function browser(options: { view?: ModelView; onView?: (view: ModelView | undefined) => void; query?: string; list?: readonly Model<Api>[];
  facts?: (provider: string, id: string) => ModelFacts | undefined } = {}) {
  return new ModelBrowser({ tui: fakeTui(), catalog: fakeCatalog(options.list ?? models), color: false, sessionOnly: false, onSelect() {}, onCancel() {},
    facts: options.facts ?? lookup, ...options.view ? { view: options.view } : {}, ...options.onView ? { onView: options.onView } : {},
    ...options.query ? { initialQuery: options.query } : {} });
}
const text = (picker: ModelBrowser, width = 200) => picker.render(width).join("\n");
/** The right side's rows, top to bottom, as they read: provider/id in All models, id in one provider's list. */
const rows = (picker: ModelBrowser, width = 200) => text(picker, width).split("\n")
  .map((line) => (line.split(" │ ")[1] ?? "").match(/^\s*(?:❯\s+)?\d+\.\s+(\S+)/)?.[1]).filter((label): label is string => Boolean(label));
/** The right side of the list row for `label`. */
const row = (picker: ModelBrowser, label: string, width = 200) => text(picker, width).split("\n").map((line) => line.split(" │ ")[1] ?? "")
  .find((line) => line.includes(` ${label} `)) ?? "";
const firstRow = (picker: ModelBrowser, width: number) => text(picker, width).split("\n").map((line) => line.split(" │ ")[1] ?? "")
  .find((line) => /^\s*(?:❯\s+)?1\.\s/.test(line)) ?? "";
/** The line under the list: the highlighted model's details. */
const details = (picker: ModelBrowser, width = 200) => picker.render(width).at(-3)!;
/** The right side's first line: what the list is. */
const header = (picker: ModelBrowser) => text(picker).split("\n")[1]!.split(" │ ")[1]!;
/** The left list, top to bottom, as it reads ("openrouter 5", "free 2"), without the cursor. */
const sidebar = (picker: ModelBrowser) => picker.render(200).slice(1, -4).map((line) => line.split(" │ ")[0]!.replace(/^❯ /, "").trim().replace(/\s+/g, " "))
  .filter((line) => line && line !== "Models");

test("under openrouter the left list has free, cheapest, newest and smartest: Down onto one shows OpenRouter's models that way, and the header says so", () => {
  const picker = browser();
  try {
    expect(sidebar(picker)).toEqual(["All models 8", "Anthropic API 1", "Claude Code plan 1", "ollama 1", "openrouter 5", "free 2", "cheapest", "newest", "smartest"]);
    // Set in under openrouter: they order its models, they are no provider of their own.
    expect(text(picker).split("\n").map((line) => line.split(" │ ")[0]!).find((left) => left.trim().startsWith("free"))).toMatch(/^ {4}free +2$/);
    for (let i = 0; i < 4; i++) picker.handleInput(DOWN);
    expect(header(picker)).toStartWith("openrouter (5)");
    expect(rows(picker)).toEqual(ORDERS.usual);
    // The list's second row is marked; a row under openrouter starts again at its top.
    picker.handleInput("\t"); picker.handleInput(DOWN); picker.handleInput("\t");
    expect(details(picker)).toContain("openrouter/vendor-e/router");
    const titles: Record<ModelView, string> = { free: "openrouter · free, newest first (2)", cheapest: "openrouter · cheapest first (5)",
      newest: "openrouter · newest first (5)", smartest: "openrouter · smartest first (5)" };
    for (const view of MODEL_VIEWS) {
      picker.handleInput(DOWN);
      expect([view, rows(picker)]).toEqual([view, ORDERS[view]]);
      expect(header(picker)).toStartWith(titles[view]);
      expect(text(picker)).toMatch(new RegExp(`❯ {3}${view}\\b`));
      expect(details(picker)).toContain(`openrouter/${ORDERS[view][0]}`);
    }
    for (let i = 0; i < 4; i++) picker.handleInput(UP);
    expect(header(picker)).toStartWith("openrouter (5)");
    expect(rows(picker)).toEqual(ORDERS.usual);
    expect(text(picker)).toContain("Tab models · type to search\n");
    // No key to learn: Ctrl+O orders nothing now and types nothing (a key typed on the left goes to the search, so the
    // list side has the keys), and no hint names it.
    picker.handleInput(CTRL_O);
    expect(rows(picker)).toEqual(ORDERS.usual);
    expect(text(picker)).toContain("Tab providers · Ctrl+S this session only\n");
    expect(text(picker)).not.toContain("Ctrl+O");
    expect(text(picker)).not.toContain("sorted:");
  } finally { picker.dispose(); }
});

test("a row shows only when OpenRouter's list has something to order by, and only OpenRouter gets them", () => {
  // OpenRouter's list not read yet (offline): the engine's own prices still tell free and cheap apart; dates and scores
  // come only from OpenRouter's list. A router the engine prices at 0 counts as free until that list says otherwise.
  const unread = browser({ facts: () => undefined });
  const others = browser({ list: models.filter((model) => model.provider !== "openrouter") });
  try {
    expect(sidebar(unread)).toEqual(["All models 8", "Anthropic API 1", "Claude Code plan 1", "ollama 1", "openrouter 5", "free 3", "cheapest"]);
    expect(sidebar(others)).toEqual(["All models 3", "Anthropic API 1", "Claude Code plan 1", "ollama 1"]);
  } finally { unread.dispose(); others.dispose(); }
});

test("once OpenRouter's list is read, a model the engine lists that it doesn't (a picture maker priced 0) is not free and has no price", () => {
  const picture = fakeModel("openrouter", "vendor-i/picture-maker", { contextWindow: 0, input: ["text", "image"] });
  const picker = browser({ list: [...models, picture] });
  try {
    expect(sidebar(picker)).toContain("free 2");
    expect(row(picker, "openrouter/vendor-i/picture-maker")).not.toContain("free");
    picker.handleInput("\t");
    for (let i = 0; i < 4; i++) picker.handleInput(DOWN);
    expect(details(picker)).toContain("openrouter/vendor-i/picture-maker");
    expect(details(picker)).not.toContain("free");
    picker.handleInput("\t");
    for (let i = 0; i < 6; i++) picker.handleInput(DOWN); // All models → … → openrouter → free → cheapest
    expect(header(picker)).toStartWith("openrouter · cheapest first (6)");
    // No price to order by: last, with the router, in the usual order.
    expect(rows(picker)).toEqual([...ORDERS.cheapest.slice(0, 4), "vendor-i/picture-maker", "vendor-e/router"]);
    picker.handleInput(UP);
    expect(rows(picker)).toEqual(ORDERS.free);
  } finally { picker.dispose(); }
});

test("words typed on a row search its models, in its order; words given with /model search every model", () => {
  const picker = browser({ view: "free" });
  try {
    expect(header(picker)).toStartWith("openrouter · free, newest first (2)");
    for (const key of "old") picker.handleInput(key);
    expect(rows(picker)).toEqual(["vendor-z/old-free:free"]);
    expect(header(picker)).toStartWith("openrouter · free, newest first (1)");
    for (let i = 0; i < 3; i++) picker.handleInput(BACKSPACE);
    expect(rows(picker)).toEqual(ORDERS.free);
  } finally { picker.dispose(); }
  const asked = browser({ view: "free", query: "vendor-c" });
  try {
    expect(header(asked)).toStartWith("All models (8)");
    expect(rows(asked)).toEqual(["openrouter/vendor-c/cheap", "openrouter/vendor-d/pricey"]);
  } finally { asked.dispose(); }
});

test("/model opens on the row under openrouter you left it on, until Casper quits; leaving it on another row forgets it", async () => {
  // As Casper has them after reading OpenRouter's list.
  setModelFacts("openrouter", new Map(Object.entries(facts).map(([key, value]) => [key.slice("openrouter/".length), value])));
  const shown: ModelBrowser[] = [];
  const tui = { addInputListener: () => () => {}, requestRender() {}, setFocus() {}, terminal: { rows: 24, columns: 160 } };
  const view = { tui, color: false, show(component: ModelBrowser) { shown.push(component); }, onEOF() {} } as unknown as RuntimePickerView;
  const catalog = fakeCatalog(models) as unknown as ModelRuntime;
  /** Opens /model, presses `keys`, then Esc; what it showed when it opened. */
  const open = async (keys: string[], query?: string) => {
    const pick = pickPiModel(view, catalog, undefined, undefined, query);
    const picker = shown.at(-1)!;
    const opened = picker.render(160).join("\n");
    for (const key of keys) picker.handleInput(key);
    picker.handleInput(ESC);
    expect(await pick).toBeUndefined();
    return opened;
  };
  expect(await open([DOWN, DOWN, DOWN, DOWN, DOWN])).toContain("All models (8)");
  expect(pickerMemory.view).toBe("free");
  const again = await open([UP]);
  expect(again).toContain("openrouter · free, newest first (2)");
  expect(again).toMatch(/❯ {3}free/);
  expect(pickerMemory.view).toBeUndefined();
  expect(await open([])).toContain("All models (8)");
  // Words to search for look through every model, whatever row was left.
  pickerMemory.view = "free";
  const asked = await open([], "vendor-c");
  expect(asked).toContain("All models (8)");
  expect(asked).toContain("openrouter/vendor-c/cheap");
});

test("one provider's own list leaves its name off the rows, since the header says it; the line under the list keeps the full id", () => {
  const picker = browser();
  try {
    expect(rows(picker)).toContain("openrouter/vendor-c/cheap");
    for (let i = 0; i < 3; i++) picker.handleInput(DOWN); // All models → Anthropic API → Claude Code plan → ollama
    expect(header(picker)).toStartWith("ollama (1)");
    expect(rows(picker)).toEqual(["qwen-local"]);
    expect(details(picker)).toContain("ollama/qwen-local");
  } finally { picker.dispose(); }
});

test("each row shows the AA score, — for a model it hasn't rated (never a number), and the source is named once under the header", () => {
  const picker = browser();
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
  const scored = browser({ view: "smartest" });
  const unrated = browser({ view: "newest" });
  const router = browser({ query: "vendor-e" });
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
  const picker = browser({ view: "smartest" });
  try {
    // 120 columns: the list gets 95.
    expect(row(picker, "vendor-d/pricey", 120)).toMatch(/AA 55 · +1m ctx · +\$3\/15 · reasoning · vision/);
    expect(text(picker, 120)).toContain("AA: Artificial Analysis");
    // 100 columns: the list gets 75, so the score goes; the tags stay.
    expect(firstRow(picker, 100)).toMatch(/vendor-d\/pricey.*1m ctx · +\$3\/15 · reasoning · vision/);
    expect(firstRow(picker, 100)).not.toContain("AA");
    expect(text(picker, 100)).not.toContain("Artificial Analysis");
    expect(firstRow(picker, 70)).toMatch(/vendor-d.*1m ctx · +\$3\/15\s*$/);
    expect(firstRow(picker, 70)).not.toContain("AA");
    for (const width of [40, 60, 80, 100, 120, 160, 200]) {
      for (const line of picker.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  } finally { picker.dispose(); }
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
    color: false, sessionOnly: false, onSelect() {}, onCancel() {}, view: "newest" });
  try {
    const order = rows(picker);
    expect(order.indexOf("vendor-d/new-model")).toBe(0);
    expect(order.indexOf("vendor-d/older")).toBe(1);
    expect(row(picker, "vendor-d/new-model")).toMatch(/AA 55 · +131k ctx/);
    expect(row(picker, "vendor-d/older")).toMatch(/ — · /);
    expect(details(picker)).toContain("AA 55.1 (coding 57) · Design Arena coding #7 · added 2026-10-23");
    expect(urls).toHaveLength(2);
  } finally { picker.dispose(); }
});
