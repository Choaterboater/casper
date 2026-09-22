import { expect, test } from "bun:test";
import { initTheme, ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, truncateToWidth } from "@earendil-works/pi-tui";

/** These tests pin the exact Pi internals `src/runtime/pi-model-picker.ts` leans on, so a
 * dependency bump that changes them fails loudly here instead of silently degrading the
 * interactive model picker (PRE_RELEASE_REVIEW P3). Verified against 0.85.1. */

interface SnapshotModel { provider: string; id: string; name: string }

function fakeCatalog(models: SnapshotModel[]) {
  return {
    getAvailableSnapshot: () => models,
    getError: () => undefined,
    getModel: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
    refresh: async () => ({ errors: new Map() }),
  };
}

function fakeTui() {
  return { requestRender: () => {} };
}

const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

/** The adapter's slot render, mirrored from pickPiModel: the selector's lines plus Casper's hint. */
function withCasperHint(lines: string[], sessionOnly: boolean): string[] {
  const hint = sessionOnly
    ? "Enter: session only · Esc: cancel · /effort after selecting"
    : "Enter: remember globally · Ctrl+S: session only · Esc: cancel · /effort after selecting";
  return [...lines, truncateToWidth(hint, 100)];
}

test("the pinned ModelSelectorComponent lists models; the slot appends Casper's hint", () => {
  initTheme("dark", false);
  const picker = new ModelSelectorComponent(fakeTui() as never, undefined, fakeCatalog([
    { provider: "fixture", id: "fixture-model", name: "Fixture Model" },
  ]) as never, [], () => {}, () => {}, undefined, undefined, undefined);
  try {
    const lines = picker.render(100);
    // The selector itself renders no "Enter to select" footer in 0.85.1; the adapter must not
    // depend on Pi's footer wording (that match was silently dead before this pin).
    expect(lines.some(line => line.includes("Enter to select"))).toBe(false);
    expect(lines.some(line => stripAnsi(line).includes("fixture-model"))).toBe(true);
    const rendered = withCasperHint(lines, false);
    expect(rendered.at(-1)).toContain("Ctrl+S: session only");
  } finally { picker.dispose(); }
});

test("Enter selects the single search match with the model's provider and id", () => {
  initTheme("dark", false);
  const models = [
    { provider: "fixture", id: "fixture-model", name: "Fixture Model" },
    { provider: "other", id: "other-model", name: "Other Model" },
  ];
  let selected: { provider: string; id: string } | undefined;
  const picker = new ModelSelectorComponent(fakeTui() as never, undefined, fakeCatalog(models) as never, [],
    model => { selected = { provider: model.provider, id: model.id }; }, () => {}, "fixture-model", undefined, undefined);
  try {
    picker.handleInput("\r");
    expect(selected).toEqual({ provider: "fixture", id: "fixture-model" });
  } finally { picker.dispose(); }
});

test("the app.models.save session-only keybinding registers and restores", () => {
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS,
    "app.models.save": { defaultKeys: "ctrl+s", description: "Select for this session only" },
  }));
  try {
    expect(getKeybindings()).not.toBe(previous);
  } finally { setKeybindings(previous); }
});
