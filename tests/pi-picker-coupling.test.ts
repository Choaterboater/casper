import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import { ModelBrowser, type ModelBrowserCatalog } from "../src/runtime/pi-model-browser";

/** These tests pin the contract `src/runtime/pi-model-picker.ts` leans on: Casper's ModelBrowser
 * rows/footer/keys, the `app.models.save` session-only keybinding registration, and the
 * ModelsRefreshResult shape the adapter sanitizes. A dependency bump that breaks any of these
 * fails loudly here instead of silently degrading the interactive model picker. */

function fakeModel(provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id, name: id, api: "openai-completions", provider, baseUrl: "http://127.0.0.1:9/v1",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000, maxTokens: 4_000, ...overrides,
  } as Model<Api>;
}

function fakeCatalog(models: Model<Api>[], refresh?: () => Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>): ModelBrowserCatalog {
  return {
    getAvailableSnapshot: () => models,
    getError: () => undefined,
    refresh: refresh ?? (async () => ({ aborted: false, errors: new Map() })),
  };
}

function fakeTui(): TUI {
  return { requestRender() {}, terminal: { rows: 24, columns: 120 } } as unknown as TUI;
}

const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const rendered = (picker: ModelBrowser, width = 120) => picker.render(width).map(line => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")).join("\n");

/** Controllable refresh result; resolving it deterministically completes the browser's refresh path. */
function pendingRefresh() {
  const { promise, resolve } = Promise.withResolvers<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>();
  return { promise, settle: resolve };
}

test("the browser lists provider-prefixed rows with metadata and Casper's footer hint", () => {
  const models = [
    fakeModel("fixture", "first", { reasoning: true, input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072 }),
    fakeModel("other", "second"),
  ];
  const picker = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false,
    onSelect: () => {}, onCancel: () => {},
  });
  try {
    const text = rendered(picker);
    expect(text).toContain("All models (2)");
    expect(text).toContain("fixture/first");
    expect(text).toContain("131k ctx");
    expect(text).toContain("$3/15");
    expect(text).toContain("reasoning · vision");
    expect(text).toContain("other/second");
    expect(text).toContain("free");
    expect(text).toContain("first · fixture/first · 131k ctx · 4k out · $3/15 per M · reasoning · vision");
    expect(text).toContain("Enter: remember globally · Ctrl+S: session only · Esc/Ctrl+C: cancel · /effort after selecting");
  } finally { picker.dispose(); }
});

test("Enter selects the single search match with the model's provider and id", () => {
  const models = [
    fakeModel("fixture", "fixture-model"),
    fakeModel("other", "other-model"),
  ];
  let selected: { provider: string; id: string } | undefined;
  const picker = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false,
    initialQuery: "fixture-model",
    onSelect: model => { selected = { provider: model.provider, id: model.id }; },
    onCancel: () => {},
  });
  try {
    picker.handleInput("\r");
    expect(selected).toEqual({ provider: "fixture", id: "fixture-model" });
  } finally { picker.dispose(); }
});

test("Esc cancels and Ctrl+S selects session-only through app.models.save", () => {
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS,
    "app.models.save": { defaultKeys: "ctrl+s", description: "Select for this session only" },
  }));
  try {
    expect(getKeybindings()).not.toBe(previous);
    const models = [fakeModel("fixture", "first")];
    let cancelled = 0;
    let sessionPick: { provider: string; id: string } | undefined;
    const picker = new ModelBrowser({
      tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: true,
      onSelect: () => {}, onSelectAsDefault: model => { sessionPick = { provider: model.provider, id: model.id }; },
      onCancel: () => { cancelled += 1; },
    });
    try {
      picker.handleInput("\x13"); // Ctrl+S
      expect(sessionPick).toEqual({ provider: "fixture", id: "first" });
      picker.handleInput("\x1b"); // Esc
      expect(cancelled).toBe(1);
    } finally { picker.dispose(); }
  } finally { setKeybindings(previous); }
});

test("the default query boosts the configured default ahead of fuzzy matches", () => {
  const models = [fakeModel("alpha", "a-model"), fakeModel("beta", "b-model")];
  const picker = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false,
    defaultModel: { provider: "beta", id: "b-model" },
    initialQuery: "def", onSelect: () => {}, onCancel: () => {},
  });
  try {
    const text = rendered(picker);
    // "def" resolves the default selector: beta matches via the "default" alias, alpha does not,
    // and the boost is what surfaces beta as the (only) match.
    expect(text).toContain("beta/b-model");
    expect(text).toContain("· default");
    expect(text).not.toContain("alpha/a-model");
  } finally { picker.dispose(); }
});

test("refresh failures and success surface in the header while cached rows stay listed", async () => {
  const failingRefresh = pendingRefresh();
  const failing = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog([fakeModel("fixture", "first")], () => failingRefresh.promise),
    color: false, sessionOnly: false, onSelect: () => {}, onCancel: () => {},
  });
  try {
    failingRefresh.settle({ aborted: false, errors: new Map([["fixture", new Error("boom")]]) });
    await failingRefresh.promise;
    expect(rendered(failing)).toContain("Could not refresh fixture; showing cached models.");
    expect(rendered(failing)).toContain("fixture/first");
  } finally { failing.dispose(); }
  const succeedingRefresh = pendingRefresh();
  const succeeding = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog([fakeModel("fixture", "first")], () => succeedingRefresh.promise),
    color: false, sessionOnly: false, onSelect: () => {}, onCancel: () => {},
  });
  try {
    succeedingRefresh.settle({ aborted: false, errors: new Map() });
    await succeedingRefresh.promise;
    expect(rendered(succeeding)).toContain("Model catalogs refreshed.");
  } finally { succeeding.dispose(); }
});

test("the scroll cue reports the visible window position in long catalogs", () => {
  const models = Array.from({ length: 30 }, (_, index) => fakeModel("fixture", `model-${index}`));
  const picker = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false,
    onSelect: () => {}, onCancel: () => {},
  });
  try {
    const text = rendered(picker);
    expect(text).toContain("(1/30)");
    picker.handleInput("\x1b[B"); // Down past the window edge.
    picker.handleInput("\x1b[B");
    expect(rendered(picker)).toContain("(3/30)");
  } finally { picker.dispose(); }
});

test("Tab focuses the provider sidebar and Up/Down switch login groups", () => {
  const models = [fakeModel("alpha", "a-model"), fakeModel("beta", "b-model"), fakeModel("beta", "b-model-2")];
  const picker = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false,
    onSelect: () => {}, onCancel: () => {},
  });
  try {
    const sidebar = rendered(picker);
    expect(sidebar).toContain("Models");
    expect(sidebar).toContain("All models");
    expect(sidebar).toContain("alpha");
    expect(sidebar).toContain("beta");
    picker.handleInput("\t"); // Tab → sidebar focus.
    expect(rendered(picker)).toContain("> All models");
    picker.handleInput("\x1b[B"); // Down → scope to alpha.
    expect(rendered(picker)).toContain("alpha (1)");
    expect(rendered(picker)).toContain("alpha/a-model");
    expect(rendered(picker)).not.toContain("beta/b-model");
    picker.handleInput("\x1b[B"); // Down → scope to beta.
    expect(rendered(picker)).toContain("beta (2)");
    expect(rendered(picker)).toContain("beta/b-model");
    picker.handleInput("\r"); // Enter → back to the model list.
    expect(rendered(picker)).not.toContain("> All models");
  } finally { picker.dispose(); }
});

test("typing from the sidebar lands in the search field", () => {
  const models = [fakeModel("alpha", "a-model"), fakeModel("beta", "b-model")];
  const picker = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false,
    onSelect: () => {}, onCancel: () => {},
  });
  try {
    picker.handleInput("\t"); // Tab → sidebar focus.
    picker.handleInput("b"); // Unbound key → search input, focus returns to the list.
    const text = rendered(picker);
    expect(text).toContain("> b");
    expect(text).toContain("beta/b-model");
    expect(text).not.toContain("alpha/a-model");
  } finally { picker.dispose(); }
});

test("rows within a provider sort newest-version first using numeric-aware ids", () => {
  const models = [fakeModel("fixture", "v9"), fakeModel("fixture", "v24"), fakeModel("fixture", "v10")];
  const picker = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false,
    onSelect: () => {}, onCancel: () => {},
  });
  try {
    const text = rendered(picker);
    expect(text.indexOf("fixture/v24")).toBeLessThan(text.indexOf("fixture/v10"));
    expect(text.indexOf("fixture/v10")).toBeLessThan(text.indexOf("fixture/v9"));
  } finally { picker.dispose(); }
});

test("rows missing capability tags keep the same ctx and price columns", () => {
  const models = [
    fakeModel("fixture", "tagged", { reasoning: true, input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072 }),
    fakeModel("fixture", "plain", { cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072 }),
  ];
  const picker = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false,
    onSelect: () => {}, onCancel: () => {},
  });
  try {
    const lines = rendered(picker).split("\n");
    const tagged = lines.find(line => line.includes("fixture/tagged") && line.includes("vision"));
    const plain = lines.find(line => line.includes("fixture/plain") && !line.includes("vision"));
    expect(tagged).toBeDefined();
    expect(plain).toBeDefined();
    // Prices are right-aligned: different token lengths start at different columns but the
    // right edges match, which is what keeps the columns visually straight.
    expect(plain!.indexOf("$1/5") + "$1/5".length).toBe(tagged!.indexOf("$3/15") + "$3/15".length);
    expect(plain!.indexOf("131k ctx")).toBe(tagged!.indexOf("131k ctx"));
  } finally { picker.dispose(); }
});