import { fuzzyFilter, getKeybindings, Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { Api, Model, ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import { paint, terminalText } from "../tui/format";

/** The slice of ModelRuntime the browser consumes; `pi-model-picker.ts` passes a sanitized view
 * whose provider/id/name values are already control-character safe. */
export interface ModelBrowserCatalog {
  getAvailableSnapshot(): readonly Model<Api>[];
  refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
  getError(): string | undefined;
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

/** Model identity is provider + id within a catalog snapshot; full Model equality is unnecessary. */
function sameRef(a: ModelRef | undefined, b: ModelRef): boolean {
  return a !== undefined && a.provider === b.provider && a.id === b.id;
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
}

/** Casper's full-screen model browser in the spirit of omp's picker: a provider sidebar on the
 * left (Tab focuses it; Up/Down switch login groups), a search-backed model list on the right
 * with context/price/capability columns, and a summary + hint footer. No kind filters. Keys
 * flow through `getKeybindings()`; unbound keys edit the search input. */
export class ModelBrowser {
  private readonly searchInput = new Input();
  private readonly refreshAbortController = new AbortController();
  private refreshTimeout?: NodeJS.Timeout;
  private allModels: Item[] = [];
  private filteredModels: Item[] = [];
  private selectedIndex = 0;
  private current?: ModelRef;
  private readonly defaultModel?: ModelRef;
  private scope: string | undefined; // undefined = all providers
  private sidebarIndex = 0;
  private focus: "sidebar" | "main" = "main";
  private errorMessage?: string;
  private refreshStatusMessage = "Refreshing model catalogs…";
  private refreshStatusSuccess = false;
  private closed = false;
  private _focused = false;

  constructor(private readonly options: ModelBrowserOptions) {
    this.current = options.current;
    this.defaultModel = options.defaultModel;
    this.searchInput.onSubmit = () => {
      const item = this.filteredModels[this.selectedIndex];
      if (item) this.handleSelect(item.model);
    };
    this.loadModelsFromSnapshot();
    const query = options.initialQuery;
    if (query) {
      this.searchInput.setValue(query);
      this.filterModels(query);
    }
    options.tui.requestRender();
    void this.refreshModels();
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.searchInput.focused = value; }

  /** Component contract for the surface slot and `setFocus`; all width-dependent content
   * rebuilds inside `render`. */
  invalidate(): void {}

  private accent(text: string): string { return paint(text, "36", this.options.color); }
  private muted(text: string): string { return paint(text, "2", this.options.color); }
  private rule(width: number): string { return this.muted("─".repeat(width)); }

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
      lines.push(truncateToWidth(`${left}${this.muted(" │ ")}${main[i] ?? ""}`, width));
    }
    lines.push(this.rule(width));
    lines.push(truncateToWidth(this.summaryLine(), width));
    lines.push(truncateToWidth(this.hintLine(), width));
    lines.push(this.rule(width));
    return lines;
  }

  private hintLine(): string {
    return this.muted(`  Tab: provider groups · ${this.options.sessionOnly
      ? "Enter: session only · Esc/Ctrl+C: cancel · /effort after selecting"
      : "Enter: remember globally · Ctrl+S: session only · Esc/Ctrl+C: cancel · /effort after selecting"}`);
  }

  private statusSuffix(): string {
    if (this.errorMessage) return " " + paint(terminalText(this.errorMessage).replace(/\s+/g, " ").trim(), "31", this.options.color);
    if (this.refreshStatusMessage) return paint(` · ${this.refreshStatusMessage}`, this.refreshStatusSuccess ? "32" : "2", this.options.color);
    return "";
  }

  private loadModelsFromSnapshot(): void {
    this.allModels = this.sortModels(this.options.catalog.getAvailableSnapshot()
      .map(model => ({ model, provider: model.provider, id: model.id })));
    this.applyScope();
  }

  private sortModels(models: Item[]): Item[] {
    const sorted = [...models];
    // Current model first, Casper default second, then grouped by provider like omp's list.
    sorted.sort((a, b) => {
      const aCurrent = sameRef(this.current, a);
      const bCurrent = sameRef(this.current, b);
      if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
      const aDefault = sameRef(this.defaultModel, a);
      const bDefault = sameRef(this.defaultModel, b);
      if (aDefault !== bDefault) return aDefault ? -1 : 1;
      return a.provider.localeCompare(b.provider);
    });
    return sorted;
  }

  private sidebarEntries(): { label: string; provider?: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const item of this.allModels) counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
    const providers = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    return [{ label: "All models", provider: undefined, count: this.allModels.length },
      ...providers.map(provider => ({ label: provider, provider, count: counts.get(provider)! }))];
  }

  private sidebarWidth(width: number): number {
    const labelWidth = Math.max(...this.sidebarEntries().map(entry => visibleWidth(terminalText(entry.label))), 10);
    return Math.min(Math.max(14, labelWidth + 6), Math.max(14, Math.floor(width / 4)));
  }

  private sidebarLines(height: number, width: number): string[] {
    const entries = this.sidebarEntries();
    this.sidebarIndex = Math.min(this.sidebarIndex, Math.max(0, entries.length - 1));
    const windowRows = Math.max(1, height - 2);
    const windowStart = Math.max(0, Math.min(this.sidebarIndex - Math.floor(windowRows / 2), entries.length - windowRows));
    const lines: string[] = [this.accent("Models"), ""];
    for (let i = windowStart; i < Math.min(windowStart + windowRows, entries.length); i++) {
      const entry = entries[i]!;
      const label = truncateToWidth(entry.label, width - 4);
      const cursor = this.focus === "sidebar" && this.sidebarIndex === i ? this.accent("> ") : "  ";
      const active = this.scope === entry.provider ? this.accent(label) : label;
      lines.push(`${cursor}${active}${this.muted(String(entry.count).padStart(width - visibleWidth(label) - 2))}`);
    }
    return lines;
  }

  private applyScope(): void {
    const active = this.scope === undefined ? this.allModels : this.allModels.filter(item => item.provider === this.scope);
    this.filteredModels = active;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
  }

  private filterModels(query: string): void {
    if (!query) {
      this.applyScope();
      return;
    }
    const active = this.scope === undefined ? this.allModels : this.allModels.filter(item => item.provider === this.scope);
    const filtered = fuzzyFilter(active, query, item =>
      `${item.provider} ${item.provider}/${item.id} ${item.provider} ${item.id} ${item.model.name}` +
      (sameRef(this.defaultModel, item) ? " default" : ""));
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

  private mainLines(width: number, height: number): string[] {
    const header = this.scope === undefined
      ? this.accent("All models") + this.muted(` (${this.allModels.length})`)
      : this.accent(terminalText(this.scope)) + this.muted(` (${this.filteredModels.length})`);
    const lines = [header + this.statusSuffix(), ""];
    const searchLines = this.searchInput.render(width);
    lines.push(...searchLines, "");
    // One row reserved for the scroll cue so the window never overflows the pane.
    const maxVisible = Math.max(1, height - SEARCH_FURNITURE - 1);
    const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible));
    const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);
    for (let i = startIndex; i < endIndex; i++) {
      lines.push(this.rowText(this.filteredModels[i]!, i === this.selectedIndex, width));
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

  private metaText(item: Item, width: number): string {
    const model = item.model;
    const ctx = fmtTokens(model.contextWindow);
    const price = this.priceText(model);
    const tags = [model.reasoning ? "reasoning" : "", model.input?.includes("image") ? "vision" : ""].filter(Boolean).join(" · ");
    // Fixed-width segments keep the id column aligned across rows; empty segments pad with
    // spaces so every row's metadata occupies the same width.
    const ctxSegment = ctx ? `${ctx} ctx`.padStart(CTX_WIDTH) : "";
    const priceSegment = price.padStart(PRICE_WIDTH);
    const tagsSegment = tags ? truncateToWidth(tags, TAGS_WIDTH).padEnd(TAGS_WIDTH) : "";
    // Narrow panes drop the right-most columns first so ids stay readable.
    const segments = [
      ctxSegment,
      priceSegment && width >= 44 ? priceSegment : "",
      tagsSegment && width >= 72 ? tagsSegment : "",
    ].filter(segment => segment.trim() !== "");
    return segments.map(segment => this.muted(segment)).join(this.muted(" · "));
  }

  private priceText(model: Model<Api>): string {
    const cost = model.cost;
    if (!cost) return "";
    if (!cost.input && !cost.output) return "free";
    return `$${fmtPrice(cost.input)}/${fmtPrice(cost.output)}`;
  }

  private rowText(item: Item, selected: boolean, width: number): string {
    const cursor = selected ? this.accent("> ") : "  ";
    const marker = sameRef(this.current, item) ? this.accent("✓ ") : "  ";
    const id = this.muted(`${item.provider}/`) + (selected ? this.accent(item.id) : item.id);
    const badge = sameRef(this.defaultModel, item) ? this.muted(" · default") : "";
    const meta = this.metaText(item, width);
    const metaWidth = meta ? visibleWidth(meta) + 1 : 0;
    const leftWidth = Math.max(8, width - metaWidth);
    const left = truncateToWidth(cursor + marker + id + badge, leftWidth);
    const pad = Math.max(1, leftWidth - visibleWidth(left));
    return truncateToWidth(left + " ".repeat(pad) + meta, width);
  }

  private summaryLine(): string {
    const item = this.filteredModels[this.selectedIndex];
    if (!item) return this.muted("  No models available. Use /login to add providers.");
    const model = item.model;
    const parts: string[] = [terminalText(model.name || item.id), this.muted(`${item.provider}/${item.id}`)];
    const ctx = fmtTokens(model.contextWindow);
    const out = fmtTokens(model.maxTokens);
    const sizes = [ctx && `${ctx} ctx`, out && `${out} out`].filter(part => part !== "");
    if (sizes.length) parts.push(this.muted(sizes.join(" · ")));
    const price = this.priceText(model);
    if (price) parts.push(this.muted(price === "free" ? "free" : `${price} per M`));
    const tags = [model.reasoning ? "reasoning" : "", model.input?.includes("image") ? "vision" : ""].filter(Boolean).join(" · ");
    if (tags) parts.push(this.muted(tags));
    if (sameRef(this.current, item)) parts.push(this.accent("current"));
    if (sameRef(this.defaultModel, item)) parts.push(this.muted("default"));
    return "  " + parts.join(this.muted(" · "));
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.input.tab")) {
      this.focus = this.focus === "sidebar" ? "main" : "sidebar";
      this.options.tui.requestRender();
      return;
    }
    if (this.focus === "sidebar") {
      const entries = this.sidebarEntries();
      if (kb.matches(keyData, "tui.select.up") || kb.matches(keyData, "tui.select.down")) {
        const delta = kb.matches(keyData, "tui.select.up") ? -1 : 1;
        if (entries.length) {
          this.sidebarIndex = (this.sidebarIndex + delta + entries.length) % entries.length;
          this.scope = entries[this.sidebarIndex]!.provider;
          this.filterModels(this.searchInput.getValue());
        }
      } else if (kb.matches(keyData, "tui.select.confirm")) {
        this.focus = "main";
      } else {
        // Typing from the sidebar lands in the search field, like omp's unified filter.
        this.focus = "main";
        this.searchInput.handleInput(keyData);
        this.filterModels(this.searchInput.getValue());
      }
      this.options.tui.requestRender();
      return;
    }
    if (kb.matches(keyData, "tui.select.up")) {
      if (this.filteredModels.length) {
        this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
      }
    } else if (kb.matches(keyData, "tui.select.down")) {
      if (this.filteredModels.length) {
        this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
      }
    } else if (kb.matches(keyData, "tui.select.confirm")) {
      const item = this.filteredModels[this.selectedIndex];
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
      this.searchInput.handleInput(keyData);
      this.filterModels(this.searchInput.getValue());
    }
    this.options.tui.requestRender();
  }

  private handleSelect(model: Model<Api>): void {
    this.dispose();
    this.options.onSelect(model);
  }

  /** Background catalog refresh; the adapter's catalog view pins this to local-only sources. */
  private async refreshModels(): Promise<void> {
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
        this.errorMessage = "Model refresh timed out; showing cached models.";
      } else if (result.errors.size === 1) {
        this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
      } else if (result.errors.size > 1) {
        this.errorMessage = `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].map(name => terminalText(name)).join(", ")}); showing cached models.`;
      } else {
        this.errorMessage = this.options.catalog.getError();
        if (!this.errorMessage) {
          this.refreshStatusMessage = "Model catalogs refreshed.";
          this.refreshStatusSuccess = true;
        }
      }
      this.loadModelsFromSnapshot();
      this.filterModels(this.searchInput.getValue());
      this.options.tui.requestRender();
    } catch (error) {
      if (this.closed) return;
      this.errorMessage = timedOut
        ? "Model refresh timed out; showing cached models."
        : `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
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