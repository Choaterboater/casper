import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { terminalText } from "../tui/format";
import type { RuntimePickerView } from "./types";
import { ModelBrowser } from "./pi-model-browser";

type Pick = { provider: string; id: string; persist: boolean };

export async function pickPiModel(view: RuntimePickerView, catalog: ModelRuntime, current: AgentSession["model"],
  defaultModel: { provider: string; id: string } | undefined, query: string | undefined, signal?: AbortSignal, sessionOnly = false): Promise<Pick | undefined> {
  signal?.throwIfAborted();
  const previousBindings = getKeybindings();
  setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS,
    "app.models.save": { defaultKeys: "ctrl+s", description: "Select for this session only" },
  }));
  let settled = false;
  const removeListener = view.tui.addInputListener(data => {
    if (data === "\x04") { finish(); view.onEOF(); return { consume: true }; }
    if (data === "\x03") { finish(); return { consume: true }; } // Ctrl+C cancels like Esc.
    return undefined;
  });
  let picker: ModelBrowser | undefined;
  const cancel = () => finish();
  const { promise, resolve } = Promise.withResolvers<Pick | undefined>();
  const finish = (pick?: Pick) => {
    if (settled) return;
    settled = true;
    picker?.dispose();
    removeListener(); // Detach now, not after more keys in the same chunk.
    resolve(pick);
  };
  // The catalog is sanitized before the browser renders it: provider/id/name values must be
  // control-character safe, and refresh stays explicitly local-only in this slot.
  const catalogView = new Proxy(catalog, {
    get(target, key) {
      if (key === "getError") return () => {
        const error = target.getError();
        return error === undefined ? undefined : terminalText(error);
      };
      if (key === "refresh") return async (options: Parameters<ModelRuntime["refresh"]>[0]) => {
        try {
          // The browser shows freshness status and keeps cached rows on failure, so live
          // catalog refresh (new provider models) is safe here, unlike startup paths.
          const result = await target.refresh({ ...options, allowNetwork: true });
          return { ...result, errors: new Map([...result.errors].map(([provider, error]) =>
            [terminalText(provider), new Error(terminalText(error.message))])) };
        } catch (error) {
          throw new Error(terminalText(error instanceof Error ? error.message : String(error)));
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