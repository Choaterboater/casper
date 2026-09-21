import { matchesKey, SelectList, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import type { RuntimePickerIO } from "../runtime/types";
import { paint, terminalText } from "./format";
import { StreamTerminal } from "./stream-terminal";

export async function pickEffort(io: RuntimePickerIO, levels: string[], current?: string, signal?: AbortSignal, title = "Reasoning effort · supported by this model"): Promise<{ level: string; persist: boolean } | undefined> {
  signal?.throwIfAborted();
  let finish: (value?: { level: string; persist: boolean }) => void = () => {};
  const tui = new TuiMainScreen(new StreamTerminal(io, () => { finish(); io.onEOF(); }));
  const accent = (text: string) => paint(text, "36", io.color);
  const list = new SelectList(levels.map(level => ({ value: level, label: terminalText(level) })), 8,
    { selectedPrefix: accent, selectedText: accent, description: text => text, scrollInfo: text => text, noMatch: text => text });
  list.setSelectedIndex(Math.max(0, levels.indexOf(current ?? "")));
  tui.addChild(new Text(terminalText(title), 0, 1));
  tui.addChild(list);
  tui.addChild(new Text("Enter: remember · Ctrl+S: session only · Esc: cancel", 0, 1));
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
