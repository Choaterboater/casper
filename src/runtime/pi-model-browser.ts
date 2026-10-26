import { fuzzyFilter, getKeybindings, Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { Api, Model, ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import { choiceHint, choiceNumber, KEY_PICK_MAX, keyChoice, typedChoice } from "../tui/choices";
import { pickerCursor, pickerOptionLines } from "../tui/picker";
import { stripVTControlCharacters } from "node:util";
import { terminalText, tint } from "../tui/format";
import { errorText, refreshFailure } from "./model-errors";
import { cantUseTools, NO_TOOLS } from "./local-models";
import { modelFacts, type ModelFacts } from "./model-facts";

/** The slice of ModelRuntime the browser consumes; `pi-model-picker.ts` passes a sanitized view
 * whose provider/id/name values are already control-character safe. */
export interface ModelBrowserCatalog {
  getAvailableSnapshot(): readonly Model<Api>[];
  refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
  getError(): string | undefined;
  /** Look for the local model servers again; resolves with why the ones Casper was told about aren't there. */
  refreshLocal?(options?: { signal?: AbortSignal }): Promise<string[]>;
}

type ModelRef = { provider: string; id: string };
type Item = { model: Model<Api>; provider: string; id: string };

/** Furniture below the two-pane area: bottom rule, summary, hint, bottom rule, plus the top
 * rule and the surface's own footer line. */
const FOOTER_ROWS = 4;
const PANE_SLACK = 2;
const MIN_PANE_ROWS = 8;
const SEARCH_FURNITURE = 4; // header, blank, search, blank
const TAGS_WIDTH = 18;
const PRICE_WIDTH = 12;
const CTX_WIDTH = 9;
const SCORE_WIDTH = 5;
/** The list's width from which each row also shows its score: below it the score is the first column to go. */
const SCORE_MIN_WIDTH = 90;

/** "a", "a and b", "a, b and c". */
function listWords(words: readonly string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** The header line for failed catalog refreshes: providers whose sign-in expired are told to /login, the rest get a
 * few plain words each (never the URL, body or stack), and the saved rows stay listed. */
export function refreshErrorMessage(errors: ReadonlyMap<string, Error>): string {
  const login: string[] = [];
  const other: Array<[string, string]> = [];
  for (const [provider, error] of errors) {
    const name = terminalText(provider);
    const cause = refreshFailure(terminalText(errorText(error)));
    if (cause === "login") login.push(name);
    else other.push([name, cause]);
  }
  const parts: string[] = [];
  if (login.length) parts.push(`Your ${listWords(login)} sign-in${login.length > 1 ? "s" : ""} expired. Run /login to sign in again`);
  if (other.length === 1) parts.push(`Could not refresh ${other[0]![0]} (${other[0]![1]})`);
  else if (other.length > 1) {
    const shown = other.slice(0, 3).map(([name, cause]) => `${name}: ${cause}`).join(", ") + (other.length > 3 ? `, ${other.length - 3} more` : "");
    parts.push(`Could not refresh ${other.length} model catalogs (${shown})`);
  }
  return `${parts.join(". ")}; showing saved models.`;
}

/** Model identity is provider + id within a catalog snapshot; full Model equality is unnecessary. */
function sameRef(a: ModelRef | undefined, b: ModelRef): boolean {
  return a !== undefined && a.provider === b.provider && a.id === b.id;
}

/** Keep the two Claude routes distinct without changing their actual provider ids. */
function providerLabel(provider: string): string {
  return provider === "claude-subscription" ? "Claude Code plan" : provider === "anthropic" ? "Anthropic API" : provider;
}

/** The words the picker's search matches a model by. */
function searchText(model: { provider: string; id: string; name?: string }, defaultModel: ModelRef | undefined): string {
  return `${model.provider} ${model.provider}/${model.id} ${providerLabel(model.provider)} ${model.id} ${model.name ?? ""}` + (sameRef(defaultModel, model) ? " default" : "");
}

/** Whether the picker's search for `query` would show any of these models: /model <id> that matches none is an
 * error line, not a picker that says "No matching models". */
export function anyModelMatches(models: readonly { provider: string; id: string; name?: string }[], query: string, defaultModel?: ModelRef): boolean {
  return fuzzyFilter([...models], query, model => searchText(model, defaultModel)).length > 0
    || (Boolean(defaultModel) && "default".startsWith(query.trim().toLowerCase()));
}

/** 1310720 → "1.3m", 262144 → "262k", 944000 → "944k"; empty for unknown sizes. */
function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : Number(m.toFixed(1))}m`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/** 0.15 → "0.15", 0.0025 → "0.0025", 10 → "10"; trailing zeros trimmed. */
function fmtPrice(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(n < 0.1 ? 4 : 2).replace(/0+$/, "").replace(/\.$/, "");
}

/** 55.12 → "55.1", 57 → "57". */
const fmtScore = (n: number) => String(Number(n.toFixed(1)));

/** The rows under openrouter in the left list: its models, only the free ones (newest first) or in another order.
 * OpenRouter's own list is where the prices, dates and scores come from (src/runtime/model-facts.ts). A model with
 * nothing to order by goes last; ties keep the usual order. */
export const MODEL_VIEWS = ["free", "cheapest", "newest", "smartest"] as const;
export type ModelView = typeof MODEL_VIEWS[number];
const VIEW_PROVIDER = "openrouter";
/** What the header says after the provider's name. */
const VIEW_TITLES: Record<ModelView, string> = { free: "free, newest first", cheapest: "cheapest first", newest: "newest first", smartest: "smartest first" };
const SCORE_LEGEND = "AA: Artificial Analysis Intelligence Index · higher is smarter · — not rated";
/** What the 🔒 and ⚠ marks mean. Display only: nothing restricts a request to those hosts, so 🔒 promises no more. */
const PRIVACY_LEGEND = "🔒 a host keeps nothing (OpenRouter may pick another) · ⚠ every host may keep your prompts";

/** Which columns a row has room for: a narrow list drops the score first, then the tags, then the price. The privacy mark
 * (two cells) stays. */
type Columns = { privacy: boolean; score: boolean; price: boolean; tags: boolean };

export interface ModelBrowserOptions {
  tui: TUI;
  catalog: ModelBrowserCatalog;
  color: boolean;
  /** Currently active model, highlighted and sorted first. */
  current?: ModelRef;
  /** Casper's startup default; badge, sort boost and the special "default" search. */
  defaultModel?: ModelRef;
  initialQuery?: string;
  /** Switches the footer hint to the session-only wording. */
  sessionOnly: boolean;
  onSelect(model: Model<Api>): void;
  onSelectAsDefault?(model: Model<Api>): void;
  onCancel(): void;
  /** Open on this provider's models, on the list (after adding a server). */
  initialScope?: string;
  /** The model servers you added: each shows in the left list even with no models (off), with why. */
  servers?(): ReadonlyArray<{ name: string; address: string; problem?: string }>;
  /** The `+ Add server` row at the bottom of the left list, and what Enter on it does. */
  onAddServer?(): void;
  /** Ctrl+X on one of your servers' rows. */
  onForgetServer?(name: string): void;
  /** What adding or forgetting a server just said, at the top of the right side until a key is pressed. */
  notice?: readonly string[];
  /** The row under openrouter to open on (the one /model was last left on), unless search words or a server just added
   * are given; and what to call when the left list moves to another row. */
  view?: ModelView;
  onView?(view: ModelView | undefined): void;
  /** What is known about a model beyond the catalog (src/runtime/model-facts.ts); tests pass their own. */
  facts?(provider: string, id: string): ModelFacts | undefined;
}

declare module "@earendil-works/pi-tui" {
  interface Keybindings {
    /** Forget one of your model servers (Ctrl+X on its row in /model). */
    "casper.models.forget": true;
  }
}

/** A row of the left list. A row under openrouter (`view`) shows no count unless it lists fewer models (free). */
type SidebarEntry = { label: string; provider?: string; view?: ModelView; count: number; kind: "all" | "provider" | "view" | "add";
  saved?: { address: string; problem?: string } };
const ADD_ROW = "+ Add server";

/** "ollama-192-0-2-11" in 14 columns: the start and the end, which tells two servers of one kind apart. */
function middleCut(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width < 5) return truncateToWidth(text, width, "");
  const tail = Math.ceil((width - 1) / 2);
  return `${text.slice(0, width - 1 - tail)}…${text.slice(-tail)}`;
}

/** Casper's full-screen model browser in the spirit of omp's picker: a provider sidebar on the
 * left (where it opens, unless search words were given; Up/Down pick whose models show), a
 * search-backed model list on the right with score/context/price/capability columns, and a summary +
 * hint footer. Tab, Enter or Right moves to the list. The rows under openrouter show its models free, cheapest,
 * newest or smartest first. No kind filters.
 * Keys flow through `getKeybindings()`; unbound keys edit the search input from either side. */
export class ModelBrowser {
  private readonly searchInput = new Input();
  private readonly refreshAbortController = new AbortController();
  private refreshTimeout?: NodeJS.Timeout;
  private allModels: Item[] = [];
  private filteredModels: Item[] = [];
  private selectedIndex = 0;
  private number = "";
  private current?: ModelRef;
  private readonly defaultModel?: ModelRef;
  private scope: string | undefined; // undefined = all providers
  private sidebarIndex = 0;
  private focus: "sidebar" | "main";
  /** The row under openrouter the list shows, if any. */
  private view: ModelView | undefined;
  /** Whether OpenRouter's own list was read: then a model it doesn't list has no price of its own (the engine's 0). */
  private openRouterRead = false;
  private readonly facts: (provider: string, id: string) => ModelFacts | undefined;
  private errorMessage?: string;
  private refreshStatusMessage = "Refreshing model catalogs…";
  private refreshStatusSuccess = false;
  /** Why model servers Casper was told about aren't listed (the local look's problems), shown under the header. */
  private localProblems: string[] = [];
  private notice: readonly string[];
  private closed = false;
  private _focused = false;

  constructor(private readonly options: ModelBrowserOptions) {
    this.current = options.current;
    this.defaultModel = options.defaultModel;
    this.facts = options.facts ?? modelFacts;
    // Words to search for (or a server just added) mean a model is wanted: Enter picks at once. Otherwise "where
    // from" comes first.
    this.focus = options.initialQuery || options.initialScope ? "main" : "sidebar";
    this.notice = options.notice ?? [];
    this.searchInput.onSubmit = () => {
      const item = this.filteredModels[this.selectedIndex];
      if (item) this.handleSelect(item.model);
    };
    this.loadModelsFromSnapshot();
    if (options.initialScope) {
      this.scope = options.initialScope; this.syncSidebar(); this.applyScope();
      // A server just added that has no models yet: its row, which says what to do on that computer.
      if (!this.filteredModels.length) this.focus = "sidebar";
    } else if (options.view && !options.initialQuery) {
      const index = this.sidebarEntries().findIndex((entry) => entry.view === options.view);
      if (index >= 0) { this.sidebarIndex = index; this.scope = VIEW_PROVIDER; this.view = options.view; this.applyScope(); }
    }
    const query = options.initialQuery;
    if (query) {
      this.searchInput.setValue(query);
      this.filterModels(query);
    }
    options.tui.requestRender();
    void this.refreshModels();
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.searchInput.focused = value && this.focus === "main"; }

  /** The search box shows its cursor only while the list side has the keys. */
  private setFocus(pane: "sidebar" | "main"): void {
    this.focus = pane;
    this.searchInput.focused = this._focused && pane === "main";
  }

  /** Component contract for the surface slot and `setFocus`; all width-dependent content
   * rebuilds inside `render`. */
  invalidate(): void {}

  private accent(text: string): string { return tint(text, "accent", this.options.color); }
  private muted(text: string): string { return tint(text, "muted", this.options.color); }
  private rule(width: number): string { return tint("─".repeat(width), "border", this.options.color); }

  /** Width-dependent panes rebuild per render; state changes only request one. */
  render(width: number): string[] {
    const rows = this.options.tui.terminal?.rows ?? 24;
    const paneRows = Math.max(MIN_PANE_ROWS, rows - FOOTER_ROWS - PANE_SLACK);
    const sidebarWidth = this.sidebarWidth(width);
    const mainWidth = Math.max(20, width - sidebarWidth - 3);
    const sidebar = this.sidebarLines(paneRows, sidebarWidth);
    const main = this.mainLines(mainWidth, paneRows);
    const lines = [this.rule(width)];
    for (let i = 0; i < paneRows; i++) {
      const entry = sidebar[i] ?? "";
      // Pad by visible width: ANSI-bearing sidebar lines must still align the divider column.
      const left = entry + " ".repeat(Math.max(0, sidebarWidth - visibleWidth(entry)));
      lines.push(truncateToWidth(`${left}${tint(" │ ", "border", this.options.color)}${main[i] ?? ""}`, width));
    }
    lines.push(this.rule(width));
    lines.push(truncateToWidth(this.summaryLine(), width));
    lines.push(truncateToWidth(this.hintLine(), width));
    lines.push(this.rule(width));
    return this.options.color ? lines : lines.map(line => stripVTControlCharacters(line));
  }

  private hintLine(): string {
    // The same words as every other picker's hint: "<key> <what it does>", joined by " · ".
    if (this.focus === "sidebar") {
      const entry = this.sidebarEntries()[this.sidebarIndex];
      if (entry?.kind === "add") return this.muted(choiceHint(1, "add a model server"));
      // Keep the shared primary hint first; server shortcuts precede the search hint.
      return this.muted(choiceHint(1, "Tab models", ...(entry?.saved && this.options.onForgetServer ? ["Ctrl+X forgets this server"] : []), "type to search"));
    }
    return this.muted(choiceHint(this.filteredModels.length, "Tab providers", this.options.sessionOnly ? "this session only" : "Ctrl+S this session only"));
  }

  private statusSuffix(): string {
    if (this.errorMessage) return " " + tint(terminalText(this.errorMessage).replace(/\s+/g, " ").trim(), "error", this.options.color);
    if (this.refreshStatusMessage) return tint(` · ${this.refreshStatusMessage}`, this.refreshStatusSuccess ? "success" : "muted", this.options.color);
    return "";
  }

  private loadModelsFromSnapshot(): void {
    this.allModels = this.sortModels(this.options.catalog.getAvailableSnapshot()
      .map(model => ({ model, provider: model.provider, id: model.id })));
    this.openRouterRead = this.allModels.some((item) => item.provider === VIEW_PROVIDER && this.factsOf(item) !== undefined);
    this.applyScope();
  }

  private sortModels(models: Item[]): Item[] {
    const sorted = [...models];
    // Current model first, Casper default second; then grouped by provider with the newest
    // versions on top. The catalog carries no release dates, so descending numeric-aware ids
    // (deepseek-v4 above deepseek-v3, gpt-5.6 above gpt-5.4) are the freshness proxy.
    sorted.sort((a, b) => {
      const aCurrent = sameRef(this.current, a);
      const bCurrent = sameRef(this.current, b);
      if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
      const aDefault = sameRef(this.defaultModel, a);
      const bDefault = sameRef(this.defaultModel, b);
      if (aDefault !== bDefault) return aDefault ? -1 : 1;
      const providerOrder = a.provider.localeCompare(b.provider);
      if (providerOrder !== 0) return providerOrder;
      return b.id.localeCompare(a.id, undefined, { numeric: true });
    });
    return sorted;
  }

  /** The rows in the order of the row under openrouter the list shows; rows that tie keep the order they came in (the
   * usual one, or the search's). */
  private ordered(items: readonly Item[]): Item[] {
    const view = this.view;
    if (!view) return [...items];
    const keys = new Map(items.map((item, index) => [item, [...this.sortKey(item, view), index] as const]));
    return [...items].sort((a, b) => {
      const [aGroup, aValue, aIndex] = keys.get(a)!;
      const [bGroup, bValue, bIndex] = keys.get(b)!;
      return aGroup - bGroup || aValue - bValue || aIndex - bIndex;
    });
  }

  /** Where a row under openrouter puts a model: by group, then by value, both ascending. A model with nothing to order
   * by is in a later group, so it goes last. The free row lists only free models, newest first. */
  private sortKey(item: Item, view: ModelView): [group: number, value: number] {
    const facts = this.factsOf(item);
    switch (view) {
      case "cheapest": { const price = this.priceOf(item); return price === undefined ? [1, 0] : [0, price]; }
      case "smartest": return facts?.intelligence === undefined ? [1, 0] : [0, -facts.intelligence];
      default: return facts?.created === undefined ? [1, 0] : [0, -facts.created];
    }
  }

  private factsOf(item: ModelRef): ModelFacts | undefined { return this.facts(item.provider, item.id); }

  /** Input and output dollars per million tokens together (0 for a free model), or none: a plan has no per-token price,
   * and a router's is that of the model it picks. */
  private priceOf(item: Item): number | undefined {
    if (item.provider === "claude-subscription") return undefined;
    const facts = this.factsOf(item);
    if (facts) return facts.free ? 0 : facts.price ? facts.price.input + facts.price.output : undefined;
    // A picture maker or a classifier the engine lists at 0 that OpenRouter's own list doesn't have: no per-token price.
    if (item.provider === VIEW_PROVIDER && this.openRouterRead) return undefined;
    const cost = item.model.cost;
    return cost ? (cost.input || 0) + (cost.output || 0) : undefined;
  }

  private sidebarEntries(): SidebarEntry[] {
    const counts = new Map<string, number>();
    for (const item of this.allModels) counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
    const servers = new Map((this.options.servers?.() ?? []).map((server) => [server.name, server]));
    // A server you added shows even with no models (it didn't answer): you can see why, and forget it.
    for (const name of servers.keys()) if (!counts.has(name)) counts.set(name, 0);
    const providers = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    return [{ label: "All models", provider: undefined, count: this.allModels.length, kind: "all" },
      ...providers.flatMap((provider): SidebarEntry[] => {
        const saved = servers.get(provider);
        return [{ label: providerLabel(provider), provider, count: counts.get(provider)!, kind: "provider", ...saved ? { saved: { address: saved.address, ...saved.problem ? { problem: saved.problem } : {} } } : {} },
          ...provider === VIEW_PROVIDER ? this.viewEntries() : []];
      }),
      ...this.options.onAddServer ? [{ label: ADD_ROW, count: -1, kind: "add" as const }] : []];
  }

  /** The rows under openrouter: each only when its models have something to order it by. */
  private viewEntries(): SidebarEntry[] {
    const listed = this.allModels.filter((item) => item.provider === VIEW_PROVIDER);
    const free = listed.filter((item) => this.priceOf(item) === 0).length;
    const has: Record<ModelView, boolean> = { free: free > 0, cheapest: listed.some((item) => this.priceOf(item) !== undefined),
      newest: listed.some((item) => this.factsOf(item)?.created !== undefined), smartest: listed.some((item) => this.factsOf(item)?.intelligence !== undefined) };
    return MODEL_VIEWS.filter((view) => has[view]).map((view) => ({ label: `  ${view}`, provider: VIEW_PROVIDER, view, count: view === "free" ? free : -1, kind: "view" }));
  }

  private sidebarWidth(width: number): number {
    const entries = this.sidebarEntries();
    const labelWidth = Math.max(...entries.map(entry => visibleWidth(terminalText(entry.label))), 10);
    // Your servers' names can be long ("ollama-192-0-2-10"): the list may then take a third of the width.
    const cap = entries.some((entry) => entry.saved) ? Math.floor(width / 3) : Math.floor(width / 4);
    return Math.min(Math.max(14, labelWidth + 6), Math.max(16, cap));
  }

  /** Keep the provider cursor on the row in scope after the rows change (a refresh adds or drops one); a row under
   * openrouter that is gone puts it on openrouter's own, and a provider that is gone back on "All models". */
  private syncSidebar(): void {
    const entries = this.sidebarEntries();
    // The add row keeps its place: what it shows doesn't depend on the providers.
    if (entries[this.sidebarIndex]?.kind === "add") { this.sidebarIndex = entries.length - 1; return; }
    const at = (view: ModelView | undefined) => entries.findIndex(entry => entry.kind !== "add" && entry.provider === this.scope && entry.view === view);
    let index = at(this.view);
    if (index < 0 && this.view) { this.view = undefined; index = at(undefined); }
    if (index >= 0) this.sidebarIndex = index;
    else { this.scope = undefined; this.view = undefined; this.sidebarIndex = 0; }
  }

  private sidebarLines(height: number, width: number): string[] {
    const entries = this.sidebarEntries();
    this.sidebarIndex = Math.min(this.sidebarIndex, Math.max(0, entries.length - 1));
    const windowRows = Math.max(1, height - 2);
    const windowStart = Math.max(0, Math.min(this.sidebarIndex - Math.floor(windowRows / 2), entries.length - windowRows));
    const lines: string[] = [this.accent("Models"), ""];
    for (let i = windowStart; i < Math.min(windowStart + windowRows, entries.length); i++) {
      const entry = entries[i]!;
      const cursor = pickerCursor(this.focus === "sidebar" && this.sidebarIndex === i, this.options.color);
      if (entry.kind === "add") { lines.push(`${cursor}${this.accent(middleCut(entry.label, width - 2))}`); continue; }
      // One of yours that didn't answer is "off"; one that answered with no models yet is 0. A row under openrouter
      // that lists them all has no count.
      const count = entry.count < 0 ? "" : entry.saved?.problem && !entry.count ? "off" : String(entry.count);
      const label = middleCut(entry.label, width - 3 - count.length);
      const shown = entry.kind !== "all" && this.scope === entry.provider && this.view === entry.view;
      const active = shown ? this.accent(label) : label;
      lines.push(`${cursor}${active}${this.muted(count.padStart(width - visibleWidth(label) - 2))}`);
    }
    return lines;
  }

  /** The models the left list's row stands for, in the usual order: all of them, one provider's, or OpenRouter's free
   * ones. */
  private inScope(): Item[] {
    const active = this.scope === undefined ? this.allModels : this.allModels.filter(item => item.provider === this.scope);
    return this.view === "free" ? active.filter((item) => this.priceOf(item) === 0) : active;
  }

  private applyScope(): void {
    this.filteredModels = this.ordered(this.inScope());
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
  }

  private filterModels(query: string): void {
    if (!query) {
      this.applyScope();
      return;
    }
    const active = this.inScope();
    const filtered = this.ordered(fuzzyFilter(active, query, item => searchText({ provider: item.provider, id: item.id, name: item.model.name }, this.defaultModel)));
    const normalized = query.trim().toLowerCase();
    if (normalized && "default".startsWith(normalized)) {
      // "default" is a selector, so boost the configured default ahead of fuzzy matches.
      const defaults = active.filter(item => sameRef(this.defaultModel, item));
      const defaultKeys = new Set<string>(defaults.map(item => `${item.provider}\0${item.id}`));
      this.filteredModels = [...defaults, ...filtered.filter(item => !defaultKeys.has(`${item.provider}\0${item.id}`))];
    } else {
      this.filteredModels = filtered;
    }
    this.selectedIndex = 0;
  }

  /** The right side for the add row, or one of your servers that has no models: what it is, and what to do. */
  private infoLines(width: number, height: number): string[] | undefined {
    if (this.focus !== "sidebar") return undefined;
    const entry = this.sidebarEntries()[this.sidebarIndex];
    const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(10, width - 2)).map((line) => `  ${line}`);
    let body: string[] | undefined;
    if (entry?.kind === "add") {
      body = [this.accent("Add a model server"), "", ...wrap("A model server here or on another computer: type its address and Casper detects what answers (Ollama, LM Studio, llama.cpp, vLLM, SGLang, MLX or another OpenAI-style server). If it can't tell, choose the server type. Its models show here."), "", ...wrap(this.muted("Enter starts."))];
    } else if (entry?.saved && !entry.count) {
      body = [this.accent(terminalText(entry.label)) + this.muted(entry.saved.problem ? " · off" : " · no models"), "", ...wrap(`At ${terminalText(entry.saved.address)}.`),
        ...entry.saved.problem ? ["", ...wrap(tint(terminalText(entry.saved.problem), "warning", this.options.color))]
          : ["", ...wrap("No models there yet. On that computer, add one: ollama pull qwen3, or download or load one in LM Studio, llama.cpp or vLLM.")],
        "", ...wrap(this.muted("Ctrl+X forgets it."))];
    }
    if (!body) return undefined;
    body.unshift(...this.noticeLines(width));
    while (body.length < height) body.push("");
    return body.slice(0, height);
  }

  /** What adding or forgetting a server just said, wrapped to the pane. */
  private noticeLines(width: number): string[] {
    return this.notice.flatMap((line) => wrapTextWithAnsi(line, Math.max(10, width - 2))).map((line) => tint(`  ${line}`, "success", this.options.color));
  }

  private mainLines(width: number, height: number): string[] {
    const info = this.infoLines(width, height);
    if (info) return info;
    const header = this.scope === undefined
      ? this.accent("All models") + this.muted(` (${this.allModels.length})`)
      : this.accent(terminalText(this.scope)) + this.muted(`${this.view ? ` · ${VIEW_TITLES[this.view]}` : ""} (${this.filteredModels.length})`);
    const columns = this.columns(width);
    // Why a server Casper was told about isn't listed: each reason wrapped to the pane, at most a third of it. Then,
    // when rows show a score, what it is: named once, here.
    const reasons = [...this.noticeLines(width), ...this.localProblems.flatMap((line) => wrapTextWithAnsi(line, Math.max(10, width - 2)))
      .map((line) => tint(`  ${line}`, "warning", this.options.color))].slice(0, Math.max(1, Math.floor(height / 3)));
    const notes = [...reasons, ...columns.privacy ? [this.muted(`  ${PRIVACY_LEGEND}`)] : [], ...columns.score ? [this.muted(`  ${SCORE_LEGEND}`)] : []];
    const lines = [header + this.statusSuffix(), ...notes.length ? notes : [""]];
    const searchLines = this.number ? [this.muted(`Number: ${this.number}`)] : this.searchInput.render(width);
    lines.push(...searchLines, "");
    // One row reserved for the scroll cue so the window never overflows the pane.
    const maxVisible = Math.max(1, height - SEARCH_FURNITURE - 1 - Math.max(0, notes.length - 1));
    const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible));
    const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);
    for (let i = startIndex; i < endIndex; i++) {
      lines.push(this.rowText(this.filteredModels[i]!, i === this.selectedIndex, width, i, columns));
    }
    if (startIndex > 0 || endIndex < this.filteredModels.length) {
      lines.push(this.muted(`  (${this.selectedIndex + 1}/${this.filteredModels.length})`));
    }
    if (!this.filteredModels.length) {
      lines.push(this.muted("  No matching models"));
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  /** The columns the list has room for. The score shows only where some row in the list has one (OpenRouter's models),
   * so another provider's list looks as it did. */
  private columns(width: number): Columns {
    return {
      privacy: this.filteredModels.some((item) => this.factsOf(item)?.privateHosts !== undefined),
      score: width >= SCORE_MIN_WIDTH && this.filteredModels.some((item) => this.factsOf(item)?.intelligence !== undefined),
      price: width >= 44,
      tags: width >= 72,
    };
  }

  /** "AA 55", or "—" for a model Artificial Analysis hasn't rated: unknown, never a low score. */
  private scoreText(item: Item): string {
    const score = this.factsOf(item)?.intelligence;
    return (score === undefined ? "—" : `AA ${String(Math.round(score)).padStart(2)}`).padStart(SCORE_WIDTH);
  }

  /** Two cells: "🔒" when a host keeps nothing of a request, "⚠" when every host may keep prompts, blank when unknown. */
  private privacyMark(item: Item): string {
    const hosts = this.factsOf(item)?.privateHosts;
    return hosts === undefined ? "  " : hosts.length ? "🔒" : "⚠ ";
  }

  private metaText(item: Item, columns: Columns): string {
    const model = item.model;
    const ctx = fmtTokens(model.contextWindow);
    const price = this.priceText(model);
    const tags = [cantUseTools(model) ? "no tools" : "", model.reasoning ? "reasoning" : "", model.input?.includes("image") ? "vision" : ""].filter(Boolean).join(" · ");
    // Fixed-width segments keep the id column aligned across rows; empty segments pad with
    // spaces so every row's metadata occupies the same width. The score is never empty ("—").
    const ctxSegment = ctx ? `${ctx} ctx`.padStart(CTX_WIDTH) : "";
    const priceSegment = price.padStart(PRICE_WIDTH);
    const tagsSegment = tags ? truncateToWidth(tags, TAGS_WIDTH).padEnd(TAGS_WIDTH) : "";
    // Narrow panes drop the score first, then the right-most columns, so ids stay readable.
    const segments = [
      columns.score ? this.scoreText(item) : "",
      ctxSegment,
      priceSegment && columns.price ? priceSegment : "",
      tagsSegment && columns.tags ? tagsSegment : "",
    ].filter(segment => segment.trim() !== "");
    const mark = columns.privacy ? `${this.privacyMark(item)} ` : "";
    if (!segments.length && !mark) return "";
    const composed = this.muted(mark) + segments.map(segment => this.muted(segment)).join(this.muted(" · "));
    // Rows missing tags (or price) pad with trailing spaces so every row's columns land at the
    // same offsets as fully-tagged rows instead of shifting toward the right edge.
    const classWidth = (columns.privacy ? 3 : 0) + (columns.score ? SCORE_WIDTH + 3 : 0)
      + (columns.tags ? CTX_WIDTH + PRICE_WIDTH + TAGS_WIDTH + 6 : columns.price ? CTX_WIDTH + PRICE_WIDTH + 3 : CTX_WIDTH);
    return composed + " ".repeat(Math.max(0, classWidth - visibleWidth(composed)));
  }

  private priceText(model: Model<Api>): string {
    if (model.provider === "claude-subscription") return "plan";
    // A router (openrouter/auto) costs what the model it picks costs: never "free".
    const facts = this.factsOf(model);
    if (facts && !facts.free && !facts.price) return "varies";
    // Not on OpenRouter's own list once it is read: no price to show, rather than the engine's 0 as "free".
    if (!facts && model.provider === VIEW_PROVIDER && this.openRouterRead) return "";
    const cost = model.cost;
    if (!cost) return "";
    if (!cost.input && !cost.output) return "free";
    return `$${fmtPrice(cost.input)}/${fmtPrice(cost.output)}`;
  }

  private rowText(item: Item, selected: boolean, width: number, index: number, columns: Columns): string {
    const meta = this.metaText(item, columns);
    const metaWidth = meta ? visibleWidth(meta) + 1 : 0;
    const leftWidth = Math.max(8, width - metaWidth);
    // In one provider's list the header names it, so the rows leave it out; the line under the list keeps the full id.
    const label = `${sameRef(this.current, item) ? "✓ " : ""}${this.scope === undefined ? `${item.provider}/` : ""}${item.id}${sameRef(this.defaultModel, item) ? " · default" : ""}`;
    const room = Math.max(1, leftWidth - 2 - visibleWidth(choiceNumber(index, this.filteredModels.length)));
    const left = pickerOptionLines([{ label: stripVTControlCharacters(truncateToWidth(label, room, "…")) }], 0,
      selected && this.focus === "main", leftWidth, this.options.color, { count: this.filteredModels.length, offset: index })[0]!;
    const pad = Math.max(1, leftWidth - visibleWidth(left));
    return truncateToWidth(left + " ".repeat(pad) + meta, width);
  }

  private summaryLine(): string {
    const item = this.filteredModels[this.selectedIndex];
    if (!item) {
      const saved = this.scope !== undefined && this.sidebarEntries().find((entry) => entry.provider === this.scope)?.saved;
      if (saved) return this.muted(`  No models on ${terminalText(this.scope!)} yet.`);
      return this.muted(this.options.onAddServer ? "  No models yet. Use /login to sign in, or add a model server." : "  No models available. Use /login to add providers.");
    }
    const model = item.model;
    const parts: string[] = [];
    if (item.provider === "claude-subscription" || item.provider === "anthropic") parts.push(providerLabel(item.provider));
    parts.push(terminalText(model.name || item.id), this.muted(`${item.provider}/${item.id}`));
    const ctx = fmtTokens(model.contextWindow);
    const out = fmtTokens(model.maxTokens);
    const sizes = [ctx && `${ctx} ctx`, out && `${out} out`].filter(part => part !== "");
    if (sizes.length) parts.push(this.muted(sizes.join(" · ")));
    const price = this.priceText(model);
    if (price && price !== "plan") parts.push(this.muted(price === "free" ? "free" : price === "varies" ? "price varies" : `${price} per M`));
    const facts = this.factsOf(item);
    if (facts) parts.push(...this.factsText(facts).map((part) => this.muted(part)));
    const tags = [cantUseTools(model) ? NO_TOOLS : "", model.reasoning ? "reasoning" : "", model.input?.includes("image") ? "vision" : ""].filter(Boolean).join(" · ");
    if (tags) parts.push(this.muted(tags));
    if (sameRef(this.current, item)) parts.push(this.accent("current"));
    if (sameRef(this.defaultModel, item)) parts.push(this.muted("default"));
    return "  " + parts.join(this.muted(" · "));
  }

  /** The highlighted model's hosts that keep nothing ("🔒 zero retention on …", or "⚠ no host promises zero retention"),
   * scores and the day its provider listed it: "AA 55.1 (coding 57, agentic 28.7)", "Design Arena coding #7", "added
   * 2026-09-01". A model Artificial Analysis hasn't rated says so, rather than showing no score. */
  private factsText(facts: ModelFacts): string[] {
    const more = [facts.coding === undefined ? "" : `coding ${fmtScore(facts.coding)}`, facts.agentic === undefined ? "" : `agentic ${fmtScore(facts.agentic)}`]
      .filter(Boolean).join(", ");
    const aa = facts.intelligence !== undefined ? `AA ${fmtScore(facts.intelligence)}${more ? ` (${more})` : ""}` : more ? `AA ${more}` : "AA not rated";
    const hosts = facts.privateHosts?.map((host) => terminalText(host));
    const privacy = hosts === undefined ? [] : hosts.length
      ? [`🔒 zero retention on ${hosts.slice(0, 3).join(", ")}${hosts.length > 3 ? ` +${hosts.length - 3} more` : ""}`]
      : ["⚠ no host promises zero retention"];
    return [...privacy, aa, ...facts.codingRank === undefined ? [] : [`Design Arena coding #${facts.codingRank}`],
      ...facts.created === undefined ? [] : [`added ${new Date(facts.created).toISOString().slice(0, 10)}`]];
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    this.notice = [];
    if (kb.matches(keyData, "tui.input.tab")) {
      this.setFocus(this.focus === "sidebar" ? "main" : "sidebar");
      this.options.tui.requestRender();
      return;
    }
    if (this.focus === "sidebar") {
      const entries = this.sidebarEntries();
      if (kb.matches(keyData, "tui.select.up") || kb.matches(keyData, "tui.select.down")) {
        const delta = kb.matches(keyData, "tui.select.up") ? -1 : 1;
        if (entries.length) {
          this.sidebarIndex = (this.sidebarIndex + delta + entries.length) % entries.length;
          const entry = entries[this.sidebarIndex]!;
          // The add row is no provider: the list behind it stays as it was.
          if (entry.kind !== "add") {
            this.scope = entry.provider;
            this.view = entry.view;
            this.options.onView?.(entry.view);
            // A new provider starts at its first model (the current one, when it is there).
            this.selectedIndex = 0;
            this.filterModels(this.searchInput.getValue());
          }
        }
      } else if (this.sidebarEntries()[this.sidebarIndex]?.kind === "add" && kb.matches(keyData, "tui.select.confirm")) {
        this.dispose();
        this.options.onAddServer?.();
        return;
      } else if (kb.matches(keyData, "casper.models.forget")) {
        const entry = this.sidebarEntries()[this.sidebarIndex];
        if (entry?.saved && entry.provider && this.options.onForgetServer) {
          this.dispose();
          this.options.onForgetServer(entry.provider);
          return;
        }
        this.refreshStatusMessage = "Only servers you added can be forgotten here.";
        this.refreshStatusSuccess = false;
      } else if (kb.matches(keyData, "tui.select.confirm") || matchesKey(keyData, "right")) {
        this.setFocus("main");
      } else if (kb.matches(keyData, "tui.select.cancel")) {
        this.dispose();
        this.options.onCancel();
        return;
      } else if (kb.matches(keyData, "app.models.save") && this.options.onSelectAsDefault) {
        // Ctrl+S picks the list's marked model for this session, the same from either side.
        const item = this.filteredModels[this.selectedIndex];
        if (item) {
          this.dispose();
          this.options.onSelectAsDefault(item.model);
        }
        return;
      } else {
        // Typing from the sidebar lands in the search field, like omp's unified filter.
        this.setFocus("main");
        this.searchInput.handleInput(keyData);
        this.filterModels(this.searchInput.getValue());
      }
      this.options.tui.requestRender();
      return;
    }
    const digit = !this.searchInput.getValue() && !this.number ? keyChoice(keyData, this.filteredModels.length) : -1;
    if (digit >= 0) { this.handleSelect(this.filteredModels[digit]!.model); return; }
    if (!this.searchInput.getValue() && this.filteredModels.length > KEY_PICK_MAX && /^\d$/.test(keyData)) {
      this.number = (this.number + keyData).slice(0, 3); this.options.tui.requestRender(); return;
    }
    if (this.number && matchesKey(keyData, "backspace")) {
      this.number = this.number.slice(0, -1); this.options.tui.requestRender(); return;
    }
    if (kb.matches(keyData, "tui.select.up")) {
      this.number = "";
      if (this.filteredModels.length) {
        this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
      }
    } else if (kb.matches(keyData, "tui.select.down")) {
      this.number = "";
      if (this.filteredModels.length) {
        this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
      }
    } else if (kb.matches(keyData, "tui.select.confirm")) {
      const index = this.number ? typedChoice(this.number, this.filteredModels.length) : this.selectedIndex;
      this.number = "";
      const item = this.filteredModels[index];
      if (item) this.handleSelect(item.model);
      return;
    } else if (kb.matches(keyData, "tui.select.cancel")) {
      this.dispose();
      this.options.onCancel();
      return;
    } else if (kb.matches(keyData, "app.models.save") && this.options.onSelectAsDefault) {
      const item = this.filteredModels[this.selectedIndex];
      if (item) {
        this.dispose();
        this.options.onSelectAsDefault(item.model);
      }
      return;
    } else {
      this.number = "";
      this.searchInput.handleInput(keyData);
      this.filterModels(this.searchInput.getValue());
    }
    this.options.tui.requestRender();
  }

  private handleSelect(model: Model<Api>): void {
    this.dispose();
    this.options.onSelect(model);
  }

  /** Rebuild the rows from the catalog after a refresh, keeping the highlight on the same model (by provider and id,
   * not position) so Enter still saves what the user was looking at. */
  private reload(): void {
    const highlighted = this.filteredModels[this.selectedIndex];
    this.loadModelsFromSnapshot();
    this.syncSidebar();
    this.filterModels(this.searchInput.getValue());
    const kept = highlighted ? this.filteredModels.findIndex(item => sameRef(highlighted, item)) : -1;
    if (kept >= 0) this.selectedIndex = kept;
    this.options.tui.requestRender();
  }

  /** The local model servers and the provider catalogs are looked at side by side; the rows reload after each, so a
   * server found here shows even when a catalog refresh fails or is slow. */
  private async refreshModels(): Promise<void> {
    const local = this.options.catalog.refreshLocal?.({ signal: this.refreshAbortController.signal }).then((problems) => {
      if (this.closed) return;
      this.localProblems = problems;
      this.reload();
    }, () => undefined);
    await Promise.all([local, this.refreshCatalogs()]);
  }

  /** Background catalog refresh: live provider catalogs unless PI_OFFLINE is set (the adapter's
   * catalog view keeps Pi's network default). Cached rows stay listed on failure. */
  private async refreshCatalogs(): Promise<void> {
    const timeoutMs = 15_000;
    let timedOut = false;
    this.refreshTimeout = setTimeout(() => {
      timedOut = true;
      this.refreshAbortController.abort();
    }, timeoutMs);
    try {
      const result = await this.options.catalog.refresh({ signal: this.refreshAbortController.signal });
      if (this.closed) return;
      if (result.aborted && timedOut) {
        this.errorMessage = "Model refresh timed out; showing saved models.";
      } else if (result.errors.size) {
        this.errorMessage = refreshErrorMessage(result.errors);
      } else {
        this.errorMessage = this.options.catalog.getError();
        if (!this.errorMessage) {
          this.refreshStatusMessage = "Model catalogs refreshed.";
          this.refreshStatusSuccess = true;
        }
      }
      this.reload();
    } catch (error) {
      if (this.closed) return;
      const cause = timedOut ? "timed out" : refreshFailure(terminalText(errorText(error)));
      this.errorMessage = cause === "login" ? "Your sign-in expired. Run /login to sign in again; showing saved models."
        : cause === "timed out" ? "Model refresh timed out; showing saved models."
        : `Could not refresh model catalogs (${cause}); showing saved models.`;
      this.options.tui.requestRender();
    } finally {
      clearTimeout(this.refreshTimeout);
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.refreshTimeout);
    this.refreshAbortController.abort();
  }
}