import { initTheme, ModelSelectorComponent, type AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, TuiMainScreen, truncateToWidth } from "@earendil-works/pi-tui";
import { StreamTerminal } from "../tui/stream-terminal";
import { terminalText } from "../tui/format";
import type { RuntimePickerIO } from "./types";

type Pick = { provider: string; id: string; persist: boolean };

export async function pickPiModel(io: RuntimePickerIO, catalog: ModelRuntime, current: AgentSession["model"],
  defaultModel: { provider: string; id: string } | undefined, query: string | undefined, signal?: AbortSignal, sessionOnly = false): Promise<Pick | undefined> {
  signal?.throwIfAborted();
  const previousBindings = getKeybindings();
  setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS,
    "app.models.save": { defaultKeys: "ctrl+s", description: "Select for this session only" },
  }));
  let finish: (pick?: Pick) => void = () => {};
  let settled = false;
  const terminal = new StreamTerminal(io, () => { finish(); io.onEOF(); });
  const tui = new TuiMainScreen(terminal);
  tui.addInputListener(data => { if (data === "\x04") { finish(); io.onEOF(); return { consume: true }; } return undefined; });
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; tui.stop(); } };
  let picker: ModelSelectorComponent | undefined;
  const cancel = () => finish();
  // Preserve the actual Pi picker. Its refresh is explicitly local-only here,
  // and catalog text is sanitized before Pi adds its own renderer controls.
  const view = new Proxy(catalog, {
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
    return await new Promise<Pick | undefined>((resolve) => {
      finish = (pick) => {
        if (settled) return;
        settled = true;
        picker?.dispose();
        stop(); // Detach input now, not after more keys in the same chunk.
        resolve(pick);
      };
      picker = new ModelSelectorComponent(tui, current, view, [],
        (model) => finish({ provider: model.provider, id: model.id, persist: true }), cancel, query === undefined ? undefined : terminalText(query).replace(/[\r\n\t]/g, " "),
        (model) => finish({ provider: model.provider, id: model.id, persist: false }), defaultModel);
      tui.addChild({ render: width => picker!.render(width).map(line => line.includes("Enter to select")
        ? truncateToWidth(sessionOnly ? "Enter: session only · Esc: cancel · /effort after selecting" : "Enter: remember globally · Ctrl+S: session only · Esc: cancel · /effort after selecting", width) : line),
        invalidate: () => picker!.invalidate() });
      tui.setFocus(picker);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) finish(); else tui.start();
    });
  } finally {
    signal?.removeEventListener("abort", cancel);
    picker?.dispose(); stop();
    setKeybindings(previousBindings);
  }
}
