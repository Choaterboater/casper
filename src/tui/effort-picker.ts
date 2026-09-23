import { Container, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import type { RuntimePickerView } from "../runtime/types";
import { effortHint } from "./effort";
import { paint, terminalText } from "./format";

export async function pickEffort(view: RuntimePickerView, levels: string[], current?: string, signal?: AbortSignal, title = "Reasoning effort · auto or a supported fixed level"): Promise<{ level: string; persist: boolean } | undefined> {
  signal?.throwIfAborted();
  const accent = (text: string) => paint(text, "36", view.color);
  const muted = (text: string) => paint(text, "2", view.color);
  const list = new SelectList(levels.map(level => ({
    value: level, label: terminalText(level), description: effortHint(level),
  })), 8,
    { selectedPrefix: accent, selectedText: accent, description: muted, scrollInfo: muted, noMatch: muted });
  list.setSelectedIndex(Math.max(0, levels.indexOf(current ?? "")));
  const rule = { render: (width: number) => [muted("─".repeat(width))], invalidate() {} };
  const panel = new Container();
  panel.addChild(rule);
  panel.addChild(new Text(accent(terminalText(title)), 0, 0));
  panel.addChild(list);
  panel.addChild(new Text(muted("Enter: remember · Ctrl+S: session only · Esc: cancel"), 0, 0));
  panel.addChild(rule);
  const { promise, resolve } = Promise.withResolvers<{ level: string; persist: boolean } | undefined>();
  let settled = false;
  const finish = (value?: { level: string; persist: boolean }) => { if (!settled) { settled = true; resolve(value); } };
  const cancel = () => finish();
  const removeListener = view.tui.addInputListener(data => {
    if (matchesKey(data, "ctrl+s")) { const item = list.getSelectedItem(); if (item) finish({ level: item.value, persist: false }); return { consume: true }; }
    if (matchesKey(data, "ctrl+d")) { finish(); view.onEOF(); return { consume: true }; }
    return undefined;
  });
  list.onSelect = item => finish({ level: item.value, persist: true });
  list.onCancel = cancel;
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) cancel(); else { view.show(panel); view.tui.setFocus(list); }
    return await promise;
  } finally { signal?.removeEventListener("abort", cancel); removeListener(); }
}
