import { matchesKey, SelectList, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import type { RuntimePickerIO } from "../runtime/types";
import { terminalText } from "./format";
import { Panel, panelColor } from "./presentation";
import { StreamTerminal } from "./stream-terminal";

export async function pickEffort(io: RuntimePickerIO, levels: string[], current?: string, signal?: AbortSignal, title = "Reasoning effort · supported by this model"): Promise<{ level: string; persist: boolean } | undefined> {
  signal?.throwIfAborted();
  let finish: (value?: { level: string; persist: boolean }) => void = () => {};
  const tui = new TuiMainScreen(new StreamTerminal(io, () => { finish(); io.onEOF(); }));
  const accent = (text: string) => panelColor(text, "accent", io.color);
  const muted = (text: string) => panelColor(text, "muted", io.color);
  const list = new SelectList(levels.map(level => ({ value: level, label: terminalText(level) })), 8,
    { selectedPrefix: accent, selectedText: accent, description: muted, scrollInfo: muted, noMatch: text => panelColor(text, "warning", io.color) });
  list.setSelectedIndex(Math.max(0, levels.indexOf(current ?? "")));
  const panel = new Panel(title, io.color);
  panel.addChild(new Text(muted("Up/Down: choose a supported level"), 0, 1));
  panel.addChild(list);
  panel.addChild(new Text(`${accent("Enter: remember")} · Ctrl+S: session only\nEsc / Ctrl+C: cancel`, 0, 1));
  tui.addChild(panel);
  tui.setFocus(list);
  const cancel = () => finish();
  tui.addInputListener(data => {
    if (matchesKey(data, "ctrl+s")) { const item = list.getSelectedItem(); if (item) finish({ level: item.value, persist: false }); return { consume: true }; }
    if (matchesKey(data, "ctrl+d")) { finish(); io.onEOF(); return { consume: true }; }
    return undefined;
  });
  try {
    return await new Promise(resolve => {
      let settled = false;
      finish = value => { if (!settled) { settled = true; tui.stop(); resolve(value); } };
      list.onSelect = item => finish({ level: item.value, persist: true });
      list.onCancel = cancel;
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel(); else tui.start();
    });
  } finally { signal?.removeEventListener("abort", cancel); tui.stop(); }
}
