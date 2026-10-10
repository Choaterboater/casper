import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { terminalText } from "../tui/format";
import { errorText } from "./model-errors";
import type { RuntimePickerView } from "./types";
import { ModelBrowser } from "./pi-model-browser";

type Pick = { provider: string; id: string; persist: boolean };
/** What the picker closed for: a model, or one of your model servers to add or forget (asked outside the picker). */
export type PickerResult = Pick | { action: "add" } | { action: "forget"; name: string };

/** Your model servers, for the left list: the rows, and opening on one (after adding it). */
export interface PickerServers {
  rows(): ReadonlyArray<{ name: string; address: string; problem?: string }>;
  initialScope?: string;
  /** What the add or forget just done said, shown when the picker opens again. */
  notice?: readonly string[];
}

export async function pickPiModel(view: RuntimePickerView, catalog: ModelRuntime, current: AgentSession["model"],
  defaultModel: { provider: string; id: string } | undefined, query: string | undefined, signal?: AbortSignal, sessionOnly = false,
  /** Looks for the local model servers again (src/runtime/local-models.ts), next to the catalog refresh; resolves
   * with why the ones Casper was told about aren't there. */
  refreshLocal?: (signal?: AbortSignal) => Promise<string[]>, servers?: PickerServers): Promise<PickerResult | undefined> {
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
  // The catalog is sanitized before the browser renders it: provider/id/name values must be
  // control-character safe, and so are refresh errors.
  const catalogView = new Proxy(catalog, {
    get(target, key) {
      if (key === "getError") return () => {
        const error = target.getError();
        return error === undefined ? undefined : terminalText(error);
      };
      if (key === "refreshLocal") return refreshLocal && (async (options?: { signal?: AbortSignal }) =>
        (await refreshLocal(options?.signal)).map((line) => terminalText(line).replace(/\s+/g, " ")));
      if (key === "refresh") return async (options: Parameters<ModelRuntime["refresh"]>[0]) => {
        try {
          // The browser shows freshness status and keeps cached rows on failure, so live
          // catalog refresh (new provider models) is safe here, unlike startup paths. No
          // allowNetwork override: Pi's default fetches unless PI_OFFLINE is set.
          const result = await target.refresh(options);
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
  try {
    picker = new ModelBrowser({
      tui: view.tui,
      catalog: catalogView,
      color: view.color,
      current: current ? { provider: current.provider, id: current.id } : undefined,
      defaultModel,
      initialQuery: query === undefined ? undefined : terminalText(query).replace(/[\r\n\t]/g, " "),
      sessionOnly,
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