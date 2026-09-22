import { initTheme, ModelSelectorComponent, type AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, truncateToWidth } from "@earendil-works/pi-tui";
import { terminalText } from "../tui/format";
import type { RuntimePickerView } from "./types";

type Pick = { provider: string; id: string; persist: boolean };

export async function pickPiModel(view: RuntimePickerView, catalog: ModelRuntime, current: AgentSession["model"],
  defaultModel: { provider: string; id: string } | undefined, query: string | undefined, signal?: AbortSignal, sessionOnly = false): Promise<Pick | undefined> {
  signal?.throwIfAborted();
  const previousBindings = getKeybindings();
  setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS,
    "app.models.save": { defaultKeys: "ctrl+s", description: "Select for this session only" },
  }));
  let settled = false;
  const removeListener = view.tui.addInputListener(data => { if (data === "\x04") { finish(); view.onEOF(); return { consume: true }; } return undefined; });
  let picker: ModelSelectorComponent | undefined;
  const cancel = () => finish();
  const { promise, resolve } = Promise.withResolvers<Pick | undefined>();
  const finish = (pick?: Pick) => {
    if (settled) return;
    settled = true;
    picker?.dispose();
    removeListener(); // Detach now, not after more keys in the same chunk.
    resolve(pick);
  };
  // Preserve the actual Pi picker. Its refresh is explicitly local-only here,
  // and catalog text is sanitized before Pi adds its own renderer controls.
  const catalogView = new Proxy(catalog, {
    get(target, key) {
      if (key === "getError") return () => {
        const error = target.getError();
        return error === undefined ? undefined : terminalText(error);
      };
      if (key === "refresh") return async (options: Parameters<ModelRuntime["refresh"]>[0]) => {
        try {
          const result = await target.refresh({ ...options, allowNetwork: false });
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
    initTheme("dark", false);
    picker = new ModelSelectorComponent(view.tui, current, catalogView, [],
      (model) => finish({ provider: model.provider, id: model.id, persist: true }), cancel, query === undefined ? undefined : terminalText(query).replace(/[\r\n\t]/g, " "),
      (model) => finish({ provider: model.provider, id: model.id, persist: false }), defaultModel);
    const selector = picker;
    view.show({ render: width => selector.render(width).map(line => line.includes("Enter to select")
      ? truncateToWidth(sessionOnly ? "Enter: session only · Esc: cancel · /effort after selecting" : "Enter: remember globally · Ctrl+S: session only · Esc: cancel · /effort after selecting", width) : line),
      invalidate: () => selector.invalidate() });
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
