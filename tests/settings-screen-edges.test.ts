import { expect, test } from "bun:test";
import { SettingsScreen, showSettings, type ScreenSetting } from "../src/tui/settings-screen";
import type { RuntimePickerView } from "../src/runtime/types";

const browser: ScreenSetting = { label: "Browser tool", value: "on", question: "The AI's own browser opens pages.", keep: "Keep it on",
  choices: [{ label: "Turn it off", value: false }] };
const text = (screen: SettingsScreen) => screen.render(80).join("\n");

test("typing a multi-word search character by character never activates a result; Enter changes the match", async () => {
  const calls: [string, number][] = [];
  const screen = new SettingsScreen([browser], false, async (label, choice) => {
    calls.push([label, choice]); return { rows: [{ ...browser, value: "off" }], note: "Saved." };
  }, () => {}, () => {});
  text(screen);
  for (const char of "Browser tool") screen.handleInput(char);
  expect(calls).toEqual([]);
  expect(text(screen)).toContain("Search: Browser tool");
  expect(text(screen)).toContain("Enter change · Space in search");
  screen.handleInput("\r"); await Bun.sleep(0);
  expect(calls).toEqual([["Browser tool", 0]]);
  expect(text(screen)).toMatch(/❯ Browser tool +off/);
});

test("Space without a search changes the highlighted row; digit keys search, not old row numbers", async () => {
  const calls: number[] = [];
  const screen = new SettingsScreen([browser], false, async (_, choice) => {
    calls.push(choice); return { rows: [browser], note: "Saved." };
  }, () => {}, () => {});
  text(screen); screen.handleInput(" "); await Bun.sleep(0);
  expect(calls).toEqual([0]);
  screen.handleInput("1"); screen.handleInput("\r");
  expect(calls).toEqual([0]); expect(text(screen)).toContain("Search: 1");
});

test("a pack can add more than nine theme choices: numbers take Enter, arrows scroll, and every line fits", async () => {
  const theme: ScreenSetting = { label: "Theme", value: "default", question: "The screen's colours.", keep: "Keep default",
    choices: Array.from({ length: 15 }, (_, index) => ({ label: `Colour ${index}`, value: `colour-${index}` })) };
  const calls: number[] = [];
  const screen = new SettingsScreen([theme], false, async (_, choice) => {
    calls.push(choice); return { rows: [{ ...theme, value: theme.choices[choice]!.value as string }], note: "Saved." };
  }, () => {}, () => {});
  text(screen); screen.handleInput("Theme"); screen.handleInput("\r");
  expect(text(screen)).toContain("Type 1-16 + Enter");
  screen.handleInput("1"); screen.handleInput("2"); expect(calls).toEqual([]);
  screen.handleInput("\r"); await Bun.sleep(0);
  expect(calls).toEqual([10]); expect(text(screen)).toMatch(/❯ Theme +colour-10/);
  screen.handleInput("\r");
  for (let index = 0; index < 15; index++) screen.handleInput("\x1b[B");
  expect(text(screen)).toContain("❯ 16 Colour 14");
  expect(text(screen)).toContain("16/16");
  screen.handleInput("\x1b"); expect(calls).toEqual([10]);
});

test("abort unmounts a rich screen and further input cannot save; already-aborted signals never show it", async () => {
  let shown: SettingsScreen | undefined, calls = 0;
  const view = { color: false, show(component: SettingsScreen) { shown = component; }, onEOF() {},
    tui: { requestRender() {}, setFocus() {}, terminal: { rows: 24 } } } as unknown as RuntimePickerView;
  const change = async () => { calls++; return { rows: [browser], note: "Saved." }; };
  const abort = new AbortController();
  const running = showSettings(view, [browser], change, abort.signal);
  abort.abort(); await running;
  shown!.handleInput("\r"); expect(calls).toBe(0);
  shown = undefined;
  await showSettings(view, [browser], change, abort.signal);
  expect(shown).toBeUndefined(); expect(calls).toBe(0);
});

test("closing while a deliberate save runs waits for it and never starts a second save", async () => {
  const gate = Promise.withResolvers<{ rows: ScreenSetting[]; note: string }>();
  let shown: SettingsScreen | undefined, calls = 0, finished = false;
  const view = { color: false, show(component: SettingsScreen) { shown = component; }, onEOF() {},
    tui: { requestRender() {}, setFocus() {}, terminal: { rows: 24 } } } as unknown as RuntimePickerView;
  const running = showSettings(view, [browser], async () => { calls++; return gate.promise; }).then(() => { finished = true; });
  text(shown!); shown!.handleInput("\r"); shown!.handleInput("\r"); shown!.handleInput("\x1b");
  await Bun.sleep(0); expect(finished).toBe(false); expect(calls).toBe(1);
  gate.resolve({ rows: [{ ...browser, value: "off" }], note: "Saved." });
  await running; expect(finished).toBe(true);
});

test("EOF closes the picker and notifies its terminal; Esc closes without a save", () => {
  let closed = 0, eof = 0, saves = 0;
  const screen = new SettingsScreen([browser], false, async () => { saves++; return { rows: [browser], note: "Saved." }; },
    () => { closed++; }, () => {}, () => 24, () => { eof++; });
  screen.handleInput("\x04"); expect(closed).toBe(1); expect(eof).toBe(1); expect(saves).toBe(0);
  const escape = new SettingsScreen([browser], false, async () => { saves++; return { rows: [browser], note: "Saved." }; }, () => { closed++; }, () => {});
  escape.handleInput("\x1b"); escape.handleInput("\r"); expect(closed).toBe(2); expect(saves).toBe(0);
});
