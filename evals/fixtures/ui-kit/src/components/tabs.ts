import { escapeHtml } from "../html";

export interface TabDefinition {
  readonly id: string;
  readonly label: string;
  readonly panel: string;
}

export interface TabsOptions {
  readonly tabs: readonly TabDefinition[];
  readonly selected?: string;
}

export interface Tabs {
  render(): string;
  select(id: string): void;
  key(key: string): void;
  readonly selected: string;
}

const ID = /^[a-z][a-z0-9-]*$/;

/** WAI-ARIA tabs with automatic activation: arrow keys move and select. */
export function createTabs(options: TabsOptions): Tabs {
  const tabs = [...options.tabs];
  if (!tabs.length) throw new Error("Tabs: at least one tab is required");
  const ids = new Set<string>();
  for (const tab of tabs) {
    if (!ID.test(tab.id)) throw new Error(`Tabs: invalid id ${JSON.stringify(tab.id)}`);
    if (ids.has(tab.id)) throw new Error(`Tabs: duplicate id ${JSON.stringify(tab.id)}`);
    ids.add(tab.id);
  }
  const indexOf = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) throw new Error(`Tabs: unknown tab ${JSON.stringify(id)}`);
    return index;
  };
  let current = options.selected === undefined ? 0 : indexOf(options.selected);
  return {
    render() {
      const buttons = tabs.map((tab, index) => {
        const active = index === current;
        return `<button type="button" role="tab" id="tab-${tab.id}" aria-selected="${active}" aria-controls="panel-${tab.id}" tabindex="${active ? 0 : -1}">${escapeHtml(tab.label)}</button>`;
      }).join("");
      const panels = tabs.map((tab, index) =>
        `<div role="tabpanel" id="panel-${tab.id}" aria-labelledby="tab-${tab.id}" tabindex="0"${index === current ? "" : " hidden"}>${escapeHtml(tab.panel)}</div>`,
      ).join("");
      return `<div class="tabs"><div role="tablist">${buttons}</div>${panels}</div>`;
    },
    select(id) { current = indexOf(id); },
    key(key) {
      if (key === "ArrowRight") current = (current + 1) % tabs.length;
      else if (key === "ArrowLeft") current = (current - 1 + tabs.length) % tabs.length;
      else if (key === "Home") current = 0;
      else if (key === "End") current = tabs.length - 1;
    },
    get selected() { return tabs[current]!.id; },
  };
}
