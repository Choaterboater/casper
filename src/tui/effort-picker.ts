import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import type { RuntimePickerView } from "../runtime/types";
import { choiceHint, keyChoice } from "./choices";
import { PickerList } from "./picker";
import { effortHint } from "./effort";
import { terminalText, tint } from "./format";

export async function pickEffort(view: RuntimePickerView, levels: string[], current?: string, signal?: AbortSignal, title = "Reasoning effort · auto or a supported fixed level"): Promise<{ level: string; persist: boolean } | undefined> {
  signal?.throwIfAborted();
  const accent = (text: string) => tint(text, "accent", view.color);
  const muted = (text: string) => tint(text, "muted", view.color);
  const border = (text: string) => tint(text, "border", view.color);
  // The one choice style: numbered rows, a digit picks and remembers, as Enter does.
  const list = new PickerList(levels.map(level => ({
    value: level, label: terminalText(level), description: effortHint(level),
  })), view.color);
  list.setSelectedIndex(Math.max(0, levels.indexOf(current ?? "")));
  const rule = { render: (width: number) => [border("─".repeat(width))], invalidate() {} };
  const panel = new Container();
  panel.addChild(rule);
  panel.addChild(new Text(accent(terminalText(title)), 0, 0));
  panel.addChild(list);
  panel.addChild(new Text(muted(choiceHint(levels.length, "Ctrl+S this session only", "Esc cancels")), 0, 0));
  panel.addChild(rule);
  const { promise, resolve } = Promise.withResolvers<{ level: string; persist: boolean } | undefined>();
  let settled = false;
  const finish = (value?: { level: string; persist: boolean }) => { if (!settled) { settled = true; resolve(value); } };
  const cancel = () => finish();
  const removeListener = view.tui.addInputListener(data => {
    const digit = keyChoice(data, levels.length);
    if (digit >= 0) { finish({ level: levels[digit]!, persist: true }); return { consume: true }; }
    if (matchesKey(data, "ctrl+s")) { const item = list.getSelectedItem(); if (item) finish({ level: item.value, persist: false }); return { consume: true }; }
    if (matchesKey(data, "ctrl+d")) { finish(); view.onEOF(); return { consume: true }; }
    if (matchesKey(data, "ctrl+c")) { finish(); return { consume: true }; }
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
