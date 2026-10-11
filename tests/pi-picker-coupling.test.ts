import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelBrowser, refreshErrorMessage, type ModelBrowserCatalog } from "../src/runtime/pi-model-browser";
import { tint } from "../src/tui/format";
import { pickPiModel } from "../src/runtime/pi-model-picker";
import type { RuntimePickerView } from "../src/runtime/types";
import { removeTempDir } from "./support/temp-dir";

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
    // It opens on the providers on the left; Tab moves to the list, and each side has its own hint.
    expect(text).toContain("Up/Down providers · Enter or Tab models · type to search · Esc cancels");
    picker.handleInput("\t");
    expect(rendered(picker)).toContain("Tab providers · Enter remember · Ctrl+S this session only · Esc cancels · /effort after selecting");
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

test("search words open the picker on the model list; without them Esc cancels from the providers in one press", () => {
  const models = [fakeModel("alpha", "a-model"), fakeModel("beta", "b-model")];
  const queried = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false, initialQuery: "b-mod",
    onSelect: () => {}, onCancel: () => {},
  });
  try {
    const text = rendered(queried);
    expect(text).not.toContain("> All models");
    expect(text).toContain("Tab providers · Enter remember");
  } finally { queried.dispose(); }
  let cancelled = 0;
  const plain = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false,
    onSelect: () => {}, onCancel: () => { cancelled += 1; },
  });
  try {
    expect(rendered(plain)).toContain("> All models");
    plain.handleInput("\x1b"); // Esc
    expect(cancelled).toBe(1);
  } finally { plain.dispose(); }
});

test("Right moves from the providers to the list, and a new provider starts at its first model", () => {
  const models = [fakeModel("alpha", "a1"), fakeModel("alpha", "a2"), fakeModel("beta", "b1"), fakeModel("beta", "b2"), fakeModel("beta", "b3")];
  const picker = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false,
    onSelect: () => {}, onCancel: () => {},
  });
  try {
    picker.handleInput("\x1b[C"); // Right → the list.
    expect(rendered(picker)).toContain("Tab providers");
    for (let i = 0; i < 4; i++) picker.handleInput("\x1b[B"); // Down to the 5th row.
    expect(rendered(picker)).toContain("  b1 · beta/b1"); // Rows sort by provider, newest id first: the 5th is beta/b1.
    picker.handleInput("\t"); // Back to the providers.
    picker.handleInput("\x1b[B"); // alpha: its first model is marked, not the clamped 2nd row.
    expect(rendered(picker)).toContain("  a2 · alpha/a2");
  } finally { picker.dispose(); }
});

test("a refresh that adds a provider keeps the provider cursor on the same provider", async () => {
  const models = [fakeModel("alpha", "a-model"), fakeModel("beta", "b-model")];
  const refresh = pendingRefresh();
  const picker = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog(models, () => refresh.promise), color: false, sessionOnly: false,
    onSelect: () => {}, onCancel: () => {},
  });
  try {
    picker.handleInput("\x1b[B"); picker.handleInput("\x1b[B"); // All models → alpha → beta.
    expect(rendered(picker)).toContain("> beta");
    models.push(fakeModel("aardvark", "x-model")); // Sorts above beta, shifting its row.
    refresh.settle({ aborted: false, errors: new Map() });
    await refresh.promise; await Promise.resolve();
    const text = rendered(picker);
    expect(text).toContain("> beta");
    expect(text).toContain("beta/b-model");
    expect(text).not.toContain("aardvark/x-model");
  } finally { picker.dispose(); }
});

test("only the side that has the keys draws a bright cursor; the list's mark stays, muted", () => {
  const models = [fakeModel("alpha", "a-model"), fakeModel("beta", "b-model")];
  const picker = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog(models), color: true, sessionOnly: false,
    onSelect: () => {}, onCancel: () => {},
  });
  try {
    const bright = tint("> ", "selection", true);
    const muted = tint("> ", "muted", true);
    const onProviders = picker.render(120).join("\n");
    expect(onProviders.split(bright).length - 1).toBe(1); // The provider cursor only.
    expect(onProviders).toContain(muted); // The list's marked row: what Ctrl+S would pick.
    picker.handleInput("\t");
    const onList = picker.render(120).join("\n");
    expect(onList.split(bright).length - 1).toBe(1); // The list's row only.
    expect(onList).not.toContain(muted);
  } finally { picker.dispose(); }
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
    expect(rendered(failing)).toContain("Could not refresh fixture (boom); showing saved models.");
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

/** Pi's wording when a saved Anthropic sign-in can no longer be renewed (placeholder address, no token). */
const EXPIRED = 'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://example.invalid/v1/oauth/token; details=Error: HTTP request failed. status=400; body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}; stack=Error: HTTP request failed\n    at post (file:///example/x.js:1:1)';

test("a refresh failure says why in plain words: an expired sign-in asks for /login, never the URL or stack", async () => {
  expect(refreshErrorMessage(new Map([["anthropic", new Error(EXPIRED)]])))
    .toBe("Your anthropic sign-in expired. Run /login to sign in again; showing saved models.");
  expect(refreshErrorMessage(new Map([["anthropic", new Error("OAuth refresh failed for anthropic", { cause: new Error("invalid_grant") })]])))
    .toBe("Your anthropic sign-in expired. Run /login to sign in again; showing saved models.");
  expect(refreshErrorMessage(new Map([["anthropic", new Error(EXPIRED)], ["openai-codex", new Error("401 Unauthorized")], ["openrouter", new Error("HTTP request failed. status=503; url=https://example.invalid/models")]])))
    .toBe("Your anthropic and openai-codex sign-ins expired. Run /login to sign in again. Could not refresh openrouter (HTTP 503); showing saved models.");
  expect(refreshErrorMessage(new Map([["a", new Error("fetch failed")], ["b", new Error("Request timed out")], ["c", new Error("500 Internal")], ["d", new Error("boom")]])))
    .toBe("Could not refresh 4 model catalogs (a: can't reach it, b: timed out, c: HTTP 500, 1 more); showing saved models.");
  const refresh = pendingRefresh();
  const picker = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog([fakeModel("anthropic", "first")], () => refresh.promise),
    color: false, sessionOnly: false, onSelect: () => {}, onCancel: () => {},
  });
  try {
    refresh.settle({ aborted: false, errors: new Map([["anthropic", new Error(EXPIRED)]]) });
    await refresh.promise;
    const text = rendered(picker);
    expect(text).toContain("Your anthropic sign-in expired. Run /login");
    expect(text).not.toMatch(/example\.invalid|stack=|invalid_grant/);
    expect(text).toContain("anthropic/first");
  } finally { picker.dispose(); }
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
    picker.handleInput("\t"); // Tab → the model list.
    picker.handleInput("\x1b[B"); // Down past the window edge.
    picker.handleInput("\x1b[B");
    expect(rendered(picker)).toContain("(3/30)");
  } finally { picker.dispose(); }
});

test("with no search words the picker starts on the provider sidebar, where Up/Down switch providers", () => {
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
    expect(sidebar).toContain("> All models"); // No Tab needed: the providers have the keys.
    picker.handleInput("\x1b[B"); // Down → scope to alpha.
    expect(rendered(picker)).toContain("alpha (1)");
    expect(rendered(picker)).toContain("alpha/a-model");
    expect(rendered(picker)).not.toContain("beta/b-model");
    picker.handleInput("\x1b[B"); // Down → scope to beta.
    expect(rendered(picker)).toContain("beta (2)");
    expect(rendered(picker)).toContain("beta/b-model");
    picker.handleInput("\r"); // Enter → the model list.
    expect(rendered(picker)).not.toContain("> beta");
    picker.handleInput("\t"); // Tab → back to the providers, still on beta.
    expect(rendered(picker)).toContain("> beta");
  } finally { picker.dispose(); }
});

test("typing from the sidebar lands in the search field", () => {
  const models = [fakeModel("alpha", "a-model"), fakeModel("beta", "b-model")];
  const picker = new ModelBrowser({
    tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false,
    onSelect: () => {}, onCancel: () => {},
  });
  try {
    picker.handleInput("b"); // From the providers, an unbound key goes to the search input and the list.
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
test("a catalog refresh keeps the highlighted model by provider and id, with or without a query", async () => {
  for (const query of ["", "m"]) {
    const models = [fakeModel("a", "m1"), fakeModel("a", "m2"), fakeModel("a", "m3")];
    const refresh = pendingRefresh();
    let selected: string | undefined;
    const picker = new ModelBrowser({
      tui: fakeTui(), catalog: fakeCatalog(models, () => refresh.promise), color: false, sessionOnly: false,
      initialQuery: query || undefined, onSelect: model => { selected = `${model.provider}/${model.id}`; }, onCancel: () => {},
    });
    try {
      if (!query) picker.handleInput("\t"); // No search words: Tab from the providers to the list first.
      picker.handleInput("\x1b[B"); // Down: m3 → m2 (newest ids sort first).
      models.push(fakeModel("a", "m4")); // Sorts above the highlight, shifting its index.
      refresh.settle({ aborted: false, errors: new Map() });
      await refresh.promise; await Promise.resolve();
      expect(rendered(picker)).toContain("Model catalogs refreshed.");
      picker.handleInput("\r");
      expect({ query, selected }).toEqual({ query, selected: "a/m2" });
    } finally { picker.dispose(); }
  }
});

test("the /model live catalog refresh goes to the network only when PI_OFFLINE is unset", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-picker-offline-"));
  const savedOffline = process.env.PI_OFFLINE;
  const savedFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetched.push(String(url instanceof Request ? url.url : url));
    return new Response("{}", { status: 503 });
  }) as typeof fetch;
  try {
    await writeFile(path.join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "synthetic" } }), { mode: 0o600 });
    const run = async (offline: boolean) => {
      if (offline) process.env.PI_OFFLINE = "1"; else delete process.env.PI_OFFLINE;
      const runtime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json") });
      const before = fetched.length;
      const refreshed = Promise.withResolvers<void>();
      const refresh = runtime.refresh.bind(runtime);
      runtime.refresh = (options) => refresh(options).finally(() => refreshed.resolve());
      const abort = new AbortController();
      const tui = { addInputListener: () => () => {}, requestRender() {}, setFocus() {}, terminal: { rows: 24, columns: 100 } };
      const picked = pickPiModel({ tui, color: false, show() {}, onEOF() {} } as unknown as RuntimePickerView, runtime, undefined, undefined, undefined, abort.signal);
      await refreshed.promise;
      abort.abort();
      expect(await picked).toBeUndefined();
      return fetched.length - before;
    };
    expect(await run(false)).toBeGreaterThan(0);
    expect(await run(true)).toBe(0);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = savedOffline;
    await removeTempDir(dir);
  }
});

test("the local look runs next to the catalog refresh: its reasons show under the header, and its models show even when the catalog refresh fails", async () => {
  const models = [fakeModel("fixture", "first")];
  const refresh = pendingRefresh();
  const local = Promise.withResolvers<string[]>();
  const catalog: ModelBrowserCatalog = {
    ...fakeCatalog(models, () => refresh.promise.then(() => { throw new Error("HTTP 503"); })),
    refreshLocal: () => local.promise,
  };
  const picker = new ModelBrowser({ tui: fakeTui(), catalog, color: false, sessionOnly: false, onSelect: () => {}, onCancel: () => {} });
  try {
    models.push(fakeModel("ollama", "qwen3:8b")); // The local look registered a server.
    local.resolve(["Ollama at http://192.0.2.10:11434 (OLLAMA_HOST) didn't answer in 10 s."]);
    await local.promise; await Promise.resolve();
    let text = rendered(picker);
    expect(text).toContain("ollama/qwen3:8b");
    expect(text).toContain("Ollama at http://192.0.2.10:11434 (OLLAMA_HOST) didn't answer in 10 s.");
    refresh.settle({ aborted: false, errors: new Map() });
    await refresh.promise; await Promise.resolve(); await Promise.resolve();
    text = rendered(picker);
    expect(text).toContain("Could not refresh model catalogs");
    expect(text).toContain("ollama/qwen3:8b");
  } finally { picker.dispose(); }
});

test("on an 80-column terminal the reasons wrap under the header instead of being cut off", async () => {
  const local = Promise.withResolvers<string[]>();
  const tip = "On that computer the server must listen on the network: Ollama OLLAMA_HOST=0.0.0.0 ollama serve.";
  const catalog: ModelBrowserCatalog = { ...fakeCatalog([fakeModel("fixture", "first")]), refreshLocal: () => local.promise };
  const picker = new ModelBrowser({ tui: fakeTui(), catalog, color: false, sessionOnly: false, onSelect: () => {}, onCancel: () => {} });
  try {
    local.resolve(["LM Studio at http://192.0.2.10:1234 (LM_STUDIO_BASE_URL) didn't answer in 10 s.", tip]);
    await local.promise; await Promise.resolve();
    const lines = picker.render(80);
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
    // The right side only: what follows the divider on each row.
    const text = lines.map(stripAnsi).map((line) => line.split(" │ ")[1] ?? "").join(" ").replace(/\s+/g, " ");
    expect(text).toContain("(LM_STUDIO_BASE_URL) didn't answer in 10 s.");
    expect(text).toContain("OLLAMA_HOST=0.0.0.0 ollama serve.");
    expect(text).toContain("fixture/first");
  } finally { picker.dispose(); }
});

test("your servers: an offline one shows as off with why, the add row is last and fits at 80 columns, Ctrl+X asks to forget only yours", () => {
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, "casper.models.forget": { defaultKeys: "ctrl+x", description: "Forget this model server" } }));
  try {
    const models = [fakeModel("alpha", "a-model"), fakeModel("ollama-192-0-2-10", "qwen3:8b")];
    const actions: string[] = [];
    const picker = new ModelBrowser({
      tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false, onSelect: () => {}, onCancel: () => {},
      servers: () => [{ name: "ollama-192-0-2-10", address: "http://192.0.2.10:11434" },
        { name: "ollama-192-0-2-11", address: "http://192.0.2.11:11434", problem: "ollama-192-0-2-11 (Ollama at http://192.0.2.11:11434) didn't answer in 10 s." }],
      onAddServer: () => actions.push("add"), onForgetServer: (name) => actions.push(`forget ${name}`),
    });
    try {
      const left = picker.render(80).map(stripAnsi).map((line) => line.split(" │ ")[0]!);
      // At 80 columns the list widens for your servers' names; narrower, a name keeps its start and its end.
      expect(left.some((line) => line.includes("ollama-192-0-2-11") && line.trimEnd().endsWith("off"))).toBe(true);
      expect(left.findIndex((line) => line.includes("+ Add server"))).toBeGreaterThan(left.findIndex((line) => line.includes("ollama-192-0-2-11")));
      const narrow = picker.render(60).map(stripAnsi).map((line) => line.split(" │ ")[0]!);
      expect(narrow.some((line) => /ollama.*….*0-2-10/.test(line))).toBe(true);
      expect(narrow.some((line) => /ollama.*….*0-2-11/.test(line) && line.trimEnd().endsWith("off"))).toBe(true);
      picker.handleInput("\x18"); // Ctrl+X on "All models": not one of yours.
      expect(rendered(picker)).toContain("Only servers you added can be forgotten here.");
      picker.handleInput("\x1b[B"); picker.handleInput("\x1b[B"); picker.handleInput("\x1b[B"); // alpha → …10 → …11
      let text = rendered(picker, 80);
      expect(text).toContain("Ctrl+X forgets this server");
      expect(text).toContain("didn't answer in 10 s.");
      expect(text).toContain("Ctrl+X forgets it.");
      picker.handleInput("\x1b[B"); // The add row.
      text = rendered(picker, 80);
      expect(text).toContain("Add a model server");
      expect(text).toContain("Enter adds a model server");
      picker.handleInput("\r");
      expect(actions).toEqual(["add"]);
    } finally { picker.dispose(); }
    const forget = new ModelBrowser({
      tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false, onSelect: () => {}, onCancel: () => {},
      servers: () => [{ name: "ollama-192-0-2-10", address: "http://192.0.2.10:11434" }],
      onAddServer: () => actions.push("add"), onForgetServer: (name) => actions.push(`forget ${name}`),
    });
    try {
      forget.handleInput("\x1b[B"); forget.handleInput("\x1b[B"); // alpha → ollama-192-0-2-10
      forget.handleInput("\x18");
      expect(actions).toEqual(["add", "forget ollama-192-0-2-10"]);
    } finally { forget.dispose(); }
  } finally { setKeybindings(previous); }
});

test("after an add the picker says what happened until a key is pressed; a new server with no models opens on its row, not an empty list", () => {
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, "casper.models.forget": { defaultKeys: "ctrl+x", description: "Forget this model server" } }));
  try {
    const picker = new ModelBrowser({
      tui: fakeTui(), catalog: fakeCatalog([fakeModel("alpha", "a-model")]), color: false, sessionOnly: false, onSelect: () => {}, onCancel: () => {},
      servers: () => [{ name: "ollama-box", address: "http://192.0.2.10:11434" }], initialScope: "ollama-box",
      notice: ["Added ollama-box, but it has no models yet. On that computer run ollama pull qwen3."],
      onAddServer: () => {}, onForgetServer: () => {},
    });
    try {
      const lines = picker.render(60).map(stripAnsi);
      const left = lines.map((line) => line.split(" │ ")[0]!);
      const right = lines.map((line) => line.split(" │ ")[1] ?? "").join(" ").replace(/\s+/g, " ");
      // It answered with none: 0, not off; its row says what to do, and the hint starts with Ctrl+X (a narrow screen cuts the end).
      expect(left.some((line) => line.startsWith("> ollama-box") && line.trimEnd().endsWith("0"))).toBe(true);
      expect(right).toContain("Added ollama-box, but it has no models yet.");
      expect(right).toContain("ollama-box · no models");
      expect(right).toContain("No models there yet.");
      expect(lines.some((line) => line.startsWith("  Ctrl+X forgets this server · Up/Down providers"))).toBe(true);
      expect(lines.join("\n")).not.toContain("Use /login to sign in");
      picker.handleInput("\x1b[A");
      expect(rendered(picker)).not.toContain("Added ollama-box");
    } finally { picker.dispose(); }
  } finally { setKeybindings(previous); }
});

test("with no server actions there is no add row, and a just-added server opens on its models, on the list", () => {
  const models = [fakeModel("alpha", "a-model"), fakeModel("ollama-box", "qwen3:8b")];
  const plain = new ModelBrowser({ tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false, onSelect: () => {}, onCancel: () => {} });
  try { expect(rendered(plain)).not.toContain("+ Add server"); } finally { plain.dispose(); }
  let selected = "";
  const scoped = new ModelBrowser({ tui: fakeTui(), catalog: fakeCatalog(models), color: false, sessionOnly: false, initialScope: "ollama-box",
    onSelect: (model) => { selected = `${model.provider}/${model.id}`; }, onCancel: () => {} });
  try {
    expect(rendered(scoped)).toContain("ollama-box (1)");
    scoped.handleInput("\r");
    expect(selected).toBe("ollama-box/qwen3:8b");
  } finally { scoped.dispose(); }
});
