import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { terminalText } from "../tui/format";
import { errorText } from "./model-errors";
import type { RuntimePickerView } from "./types";
import { ModelBrowser, type ModelView } from "./pi-model-browser";
import type { ListFreshness } from "./catalog-freshness";

type Pick = { provider: string; id: string; persist: boolean };
/** What the picker closed for: a model, or one of your model servers to add or forget (asked outside the picker). */
export type PickerResult = Pick | { action: "add" } | { action: "forget"; name: string };

/** The row under openrouter /model was last left on (free, cheapest, newest or smartest): the next /model opens on it,
 * until Casper quits. Tests put it back. */
export const pickerMemory: { view?: ModelView } = {};

/** Your model servers, for the left list: the rows, and opening on one (after adding it). */
export interface PickerServers {
  rows(): ReadonlyArray<{ name: string; address: string; problem?: string }>;
  initialScope?: string;
  /** What the add or forget just done said, shown when the picker opens again. */
  notice?: readonly string[];
}

/** Your plans' own model lists and how fresh each provider's list is (src/runtime/account-models.ts,
 * src/runtime/catalog-freshness.ts): read again after the catalog refresh, then asked by /model's header. */
export interface PickerLists {
  refresh(signal?: AbortSignal): Promise<void>;
  freshness(signal?: AbortSignal): Promise<readonly ListFreshness[]>;
}

/** The catalog as the picker sees it. Provider/id/name values must be control-character safe, and so are refresh
 * errors. Its refresh reads OpenRouter's own list after the provider catalogs (src/runtime/openrouter-models.ts), so
 * the rows the browser reloads have both. */
export function pickerCatalog(catalog: ModelRuntime, refreshLocal?: (signal?: AbortSignal) => Promise<string[]>,
  refreshOpenRouter?: (signal?: AbortSignal) => Promise<void>, lists?: PickerLists): ModelRuntime {
  return new Proxy(catalog, {
    get(target, key) {
      if (key === "getError") return () => {
        const error = target.getError();
        return error === undefined ? undefined : terminalText(error);
      };
      if (key === "refreshLocal") return refreshLocal && (async (options?: { signal?: AbortSignal }) =>
        (await refreshLocal(options?.signal)).map((line) => terminalText(line).replace(/\s+/g, " ")));
      if (key === "freshness") return lists && (async (options?: { signal?: AbortSignal }) =>
        (await lists.freshness(options?.signal)).map((list): ListFreshness => ({ ...list, provider: terminalText(list.provider),
          ...list.stale ? { stale: terminalText(list.stale).replace(/\s+/g, " ") } : {},
          ...list.unknown ? { unknown: list.unknown.map((id) => terminalText(id).replace(/\s+/g, " ")) } : {} })));
      if (key === "refresh") return async (options: Parameters<ModelRuntime["refresh"]>[0]) => {
        try {
          // The browser shows freshness status and keeps cached rows on failure, so live
          // catalog refresh (new provider models) is safe here, unlike startup paths. No
          // allowNetwork override: Pi's default fetches unless PI_OFFLINE is set.
          const result = await target.refresh(options);
          await refreshOpenRouter?.(options?.signal).catch(() => undefined);
          await lists?.refresh(options?.signal).catch(() => undefined);
          return { ...result, errors: new Map([...result.errors].map(([provider, error]) =>
            [terminalText(provider), new Error(terminalText(errorText(error)))])) };
        } catch (error) {
          throw new Error(terminalText(errorText(error)));
        }
      };
      if (key === "getAvailableSnapshot") return () => target.getAvailableSnapshot()
        .filter((model) => [model.provider, model.id].every((value) => terminalText(value) === value && !/[\r\n\t]/.test(value)))
        .map((model) => ({ ...model, name: terminalText(model.name).replace(/\s+/g, " ") }));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function pickPiModel(view: RuntimePickerView, catalog: ModelRuntime, current: AgentSession["model"],
  defaultModel: { provider: string; id: string } | undefined, query: string | undefined, signal?: AbortSignal, sessionOnly = false,
  /** Looks for the local model servers again (src/runtime/local-models.ts), next to the catalog refresh; resolves
   * with why the ones Casper was told about aren't there. */
  refreshLocal?: (signal?: AbortSignal) => Promise<string[]>, servers?: PickerServers,
  /** Reads OpenRouter's own model list again, after the catalog refresh (src/runtime/openrouter-models.ts). */
  refreshOpenRouter?: (signal?: AbortSignal) => Promise<void>, lists?: PickerLists): Promise<PickerResult | undefined> {
  signal?.throwIfAborted();
  const previousBindings = getKeybindings();
  setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS,
    "app.models.save": { defaultKeys: "ctrl+s", description: "Select for this session only" },
    "casper.models.forget": { defaultKeys: "ctrl+x", description: "Forget this model server" },
  }));
  let settled = false;
  const removeListener = view.tui.addInputListener(data => {
    if (data === "\x04") { finish(); view.onEOF(); return { consume: true }; }
    if (data === "\x03") { finish(); return { consume: true }; } // Ctrl+C cancels like Esc.
    return undefined;
  });
  let picker: ModelBrowser | undefined;
  const cancel = () => finish();
  const { promise, resolve } = Promise.withResolvers<PickerResult | undefined>();
  const finish = (pick?: PickerResult) => {
    if (settled) return;
    settled = true;
    picker?.dispose();
    removeListener(); // Detach now, not after more keys in the same chunk.
    resolve(pick);
  };
  const catalogView = pickerCatalog(catalog, refreshLocal, refreshOpenRouter, lists);
  try {
    picker = new ModelBrowser({
      tui: view.tui,
      catalog: catalogView,
      color: view.color,
      current: current ? { provider: current.provider, id: current.id } : undefined,
      defaultModel,
      initialQuery: query === undefined ? undefined : terminalText(query).replace(/[\r\n\t]/g, " "),
      sessionOnly,
      // Words to search for look through every model, whatever row was left.
      ...query === undefined && pickerMemory.view ? { view: pickerMemory.view } : {},
      onView: (view) => { pickerMemory.view = view; },
      onSelect: model => finish({ provider: model.provider, id: model.id, persist: true }),
      onSelectAsDefault: model => finish({ provider: model.provider, id: model.id, persist: false }),
      onCancel: cancel,
      ...(servers ? {
        servers: () => servers.rows().map((row) => ({ name: terminalText(row.name), address: terminalText(row.address), ...row.problem ? { problem: terminalText(row.problem) } : {} })),
        onAddServer: () => finish({ action: "add" }),
        onForgetServer: (name: string) => finish({ action: "forget", name }),
        ...(servers.initialScope ? { initialScope: servers.initialScope } : {}),
        ...(servers.notice?.length ? { notice: servers.notice.map((line) => terminalText(line)) } : {}),
      } : {}),
    });
    view.show(picker);
    view.tui.setFocus(picker);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) finish();
    return await promise;
  } finally {
    signal?.removeEventListener("abort", cancel);
    finish();
    setKeybindings(previousBindings);
  }
}