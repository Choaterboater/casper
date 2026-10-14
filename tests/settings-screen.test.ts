import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { groupedSettings, SETTINGS_AREAS, settingsArea } from "../src/app/settings-areas";
import { mcpSandboxRows, runSettings, settingRows, type SettingsHost } from "../src/app/settings";
import { SettingsScreen, SETTINGS_HINT } from "../src/tui/settings-screen";
import { useTheme } from "../src/tui/theme";
import type { RuntimePickerView } from "../src/runtime/types";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { removeTempDir } from "./support/temp-dir";
import { richApp } from "./support/app";

const roots: string[] = [];
afterEach(async () => { useTheme(undefined); await Promise.all(roots.splice(0).map(removeTempDir)); });
async function fixture(configText = "") {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-settings-screen-")); roots.push(root);
  const home = path.join(root, "home"), project = path.join(root, "project"), config = path.join(home, ".casper", "config.yaml");
  await mkdir(path.dirname(config), { recursive: true }); await mkdir(project);
  if (configText) await writeFile(config, configText);
  let context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  let component: Component | undefined;
  let output = "";
  const view = { color: false, show: (screen: Component) => { component = screen; }, onEOF() {},
    tui: { setFocus() {}, requestRender() {}, terminal: { rows: 24 } } } as unknown as RuntimePickerView;
  const host: SettingsHost = {
    homeDir: () => home, canAsk: true, output: { write: text => { output += text; } },
    context: async () => context, reload: async () => { context = await loadProjectContext(await inspectProject(project), { homeDir: home }); },
    picker: () => ({ mount: operation => operation(view), run: async () => { throw new Error("not a login"); } }),
    ask: async () => { throw new Error("Rich settings must stay in their own screen"); },
  };
  return { host, config, rows: settingRows(context), screen: () => component!, output: () => output };
}
const text = (screen: Component, width = 80) => Bun.stripANSI(screen.render(width).join("\n"));
const key = (screen: Component, data: string) => screen.handleInput!(data);
async function changed(f: Awaited<ReturnType<typeof fixture>>, expected: string) {
  // Up to 5 s: a save writes ~/.casper/config.yaml, which a busy Windows runner can take over a second to do.
  for (let i = 0; i < 1000 && !f.output().includes(expected); i++) await Bun.sleep(5);
  expect(f.output()).toContain(expected);
  // The receipt is written just before the callback re-reads the rows.
  await Bun.sleep(20);
}

 test("every current setting belongs to exactly one of seven areas; dynamic MCP sandbox rows belong to MCP", async () => {
  const f = await fixture();
  const labels: string[] = SETTINGS_AREAS.flatMap(area => [...area.labels]);
  expect(SETTINGS_AREAS).toHaveLength(7);
  expect(new Set(labels).size).toBe(labels.length);
  expect([...labels].sort()).toEqual(f.rows.map(row => row.label).sort());
  const grouped = groupedSettings(f.rows);
  expect(grouped).toHaveLength(f.rows.length);
  for (const row of f.rows) expect(grouped.filter(item => item.label === row.label)).toHaveLength(1);
  const dynamic = mcpSandboxRows({ status: () => [{ name: "example", sandbox: { state: "on" } }] as never, setSandbox: async () => undefined });
  expect(settingsArea(dynamic[0]!.label)).toBe(5);
});

 test("80-column screen: aligned columns, one row per setting, selected description and all keys, no repeated summary", async () => {
  const f = await fixture();
  const screen = new SettingsScreen(f.rows, false, async () => { throw new Error(); }, () => {}, () => {});
  const rendered = text(screen);
  expect(rendered).toContain(SETTINGS_HINT);
  expect(rendered).toContain("❯ Web lookups");
  expect(rendered).toContain("Web lookups are on (DuckDuckGo).");
  expect(rendered).not.toContain("Web lookups: on");
  expect(rendered).not.toContain("1 Done");
  const seen: string[] = [];
  for (let area = 0; area < SETTINGS_AREAS.length; area++) {
    const lines = screen.render(80);
    expect(visibleWidth(lines[2]!)).toBeLessThanOrEqual(80);
    const rows = f.rows.filter(row => settingsArea(row.label) === area);
    for (const row of rows) {
      const shown = lines.filter(line => line.startsWith(`  ${row.label} `) || line.startsWith(`❯ ${row.label} `));
      expect(shown).toHaveLength(1);
      expect(shown[0]!.slice(40)).toBe(row.value);
      seen.push(row.label);
    }
    key(screen, "\t");
  }
  expect(seen.sort()).toEqual(f.rows.map(row => row.label).sort());
});

 test("Up/Down selects a row; Enter and Space immediately flip its existing config key and redraw at the same row", async () => {
  const f = await fixture();
  const running = runSettings(f.host); await Bun.sleep(0);
  const screen = f.screen(); text(screen);
  key(screen, "\x1b[B");
  expect(text(screen)).toContain("❯ Browser tool");
  expect(text(screen)).toContain("The AI's own browser opens pages");
  key(screen, "\r"); await changed(f, "Browser tool: off.");
  expect(await readFile(f.config, "utf8")).toBe("browser: false\n");
  expect(text(screen)).toMatch(/❯ Browser tool +off/);
  key(screen, " "); await changed(f, "Browser tool: on.");
  expect(await readFile(f.config, "utf8")).toBe("browser: true\n");
  expect(text(screen)).toMatch(/❯ Browser tool +on/);
  key(screen, "\x1b[A"); expect(text(screen)).toContain("❯ Web lookups");
  key(screen, "\x1b"); await running;
});

 test("multiple values open the existing numbered Keep-first choices; choosing, keeping and Esc return to the same row", async () => {
  const f = await fixture();
  const running = runSettings(f.host); await Bun.sleep(0);
  const screen = f.screen(); text(screen);
  key(screen, "Work shown");
  expect(text(screen)).toContain("❯ Work shown");
  key(screen, "\r");
  expect(text(screen)).toContain("1 Keep normal");
  expect(text(screen)).toContain("2 Quiet");
  expect(text(screen)).toContain("3 Detailed");
  key(screen, "\x1b"); expect(text(screen)).toContain("❯ Work shown");
  key(screen, "\r"); key(screen, "1");
  await expect(stat(f.config)).rejects.toThrow();
  key(screen, "\r"); key(screen, "3"); await changed(f, "Work shown: detailed.");
  expect(await readFile(f.config, "utf8")).toBe("display: detailed\n");
  expect(text(screen)).toMatch(/❯ Work shown +detailed/);
  key(screen, "\x1b"); await running;
});

 test("Left/Right and Tab switch areas, search covers every area, Backspace clears, and Esc closes without saving", async () => {
  const f = await fixture();
  const running = runSettings(f.host); await Bun.sleep(0);
  const screen = f.screen(); text(screen);
  key(screen, "\x1b[C"); expect(text(screen)).toContain("Pages, pictures & diagrams");
  key(screen, "\t"); expect(text(screen)).toContain("Commands & checks");
  key(screen, "\x1b[D"); expect(text(screen)).toContain("Pages, pictures & diagrams");
  key(screen, "\x1b[Z"); expect(text(screen)).toContain("Tools & browser");
  key(screen, "Private ssh"); expect(text(screen)).toContain("❯ Private ssh passwords");
  expect(text(screen)).not.toMatch(/^  Browser tool/m);
  for (let i = 0; i < "Private ssh".length; i++) key(screen, "\x7f");
  expect(text(screen)).not.toContain("Search:");
  key(screen, "nomatch"); expect(text(screen)).toContain("No settings match");
  key(screen, "\r"); key(screen, "\x1b"); await running;
  await expect(stat(f.config)).rejects.toThrow(); expect(f.output()).toBe("");
});

 test("narrow windows start with an area list, then settings; all lines fit, including choices, search and NO_COLOR", async () => {
  const f = await fixture();
  for (const width of [79, 60, 40, 20]) {
    const screen = new SettingsScreen(f.rows, false, async () => { throw new Error(); }, () => {}, () => {});
    expect(text(screen, width)).toContain("Areas");
    for (const line of screen.render(width)) { expect(line).not.toContain("\x1b"); expect(visibleWidth(line)).toBeLessThanOrEqual(width); }
    key(screen, "\r");
    expect(text(screen, width)).not.toContain("Areas ·");
    expect(text(screen, width)).toContain(width >= 40 ? "❯ Web lookups" : "❯");
    key(screen, "Theme"); key(screen, "\r");
    for (const line of screen.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
  const old = process.env.NO_COLOR; process.env.NO_COLOR = "1";
  const oldTerm = process.env.TERM; process.env.TERM = "xterm-256color";
  try {
    const app = await richApp(() => ({ start: async () => { throw new Error("No model"); }, dispose: async () => {} }));
    try {
      await app.until(s => s.includes("idle")); app.input.write("/settings\r");
      await app.until(s => s.includes(SETTINGS_HINT));
      expect(app.app.terminal.color).toBe(false);
      app.input.write("\x1b"); app.input.end(); await app.interactive;
    } finally { await app.close(); }
  } finally {
    if (old === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = old;
    if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm;
  }
});

test("theme colours are read on every render, including light and dark, without changing layout", async () => {
  const f = await fixture();
  const screen = new SettingsScreen(f.rows, true, async () => { throw new Error(); }, () => {}, () => {});
  useTheme("default"); const dark = screen.render(80).join("\n"); expect(dark).toContain("\x1b[36m");
  useTheme("light"); const light = screen.render(80).join("\n"); expect(light).toContain("\x1b[34m");
  expect(Bun.stripANSI(light)).toBe(Bun.stripANSI(dark));
});

 test("rich save keeps nested provider keys and applies notes; write errors leave the row unchanged", async () => {
  const f = await fixture("web:\n  provider: brave\n"); f.host = { ...f.host, duringTask: true };
  const running = runSettings(f.host); await Bun.sleep(0);
  const screen = f.screen(); text(screen); key(screen, "\r"); await changed(f, "Web lookups: off.");
  const saved = await readFile(f.config, "utf8"); expect(saved).toContain("provider: brave"); expect(saved).toContain("enabled: false");
  expect(f.output()).toContain("The running task keeps what it had; your next request uses it.");
  key(screen, "\x1b"); await running;
  const step = await fixture(); step.host = { ...step.host, duringTask: true };
  const next = runSettings(step.host); await Bun.sleep(0); const stepScreen = step.screen(); text(stepScreen);
  key(stepScreen, "Private ssh passwords"); key(stepScreen, "\r"); await changed(step, "Private ssh passwords: off.");
  expect(await readFile(step.config, "utf8")).toBe("ssh_login: false\n");
  expect(step.output()).toContain("The running task uses it from its next step.");
  key(stepScreen, "\x1b"); await next;
  const failed = new SettingsScreen(f.rows, false, async () => { throw new Error("read only"); }, () => {}, () => {});
  text(failed); key(failed, "\r"); await Bun.sleep(0);
  expect(text(failed)).toContain("Not saved: read only"); expect(text(failed)).toMatch(/❯ Web lookups +on/);
});

test("rich MCP sandbox rows save through the server, stay in their area and never create a config key", async () => {
  const f = await fixture();
  let state: "on" | "off" = "on";
  const calls: [string, boolean][] = [];
  f.host = { ...f.host, mcp: () => ({
    status: () => [{ name: "example", sandbox: { state } }] as never,
    setSandbox: async (name, on) => { calls.push([name, on]); state = on ? "on" : "off"; return undefined; },
  }) };
  const running = runSettings(f.host); await Bun.sleep(0);
  const screen = f.screen(); text(screen); key(screen, "Sandbox for MCP"); key(screen, "\r");
  await changed(f, "Sandbox for MCP server example: off.");
  expect(calls).toEqual([["example", false]]);
  expect(text(screen)).toMatch(/❯ Sandbox for MCP server example +off/);
  expect(f.output()).toContain("Saved in ~/.casper/mcp-sandbox.json.");
  await expect(stat(f.config)).rejects.toThrow();
  key(screen, "\x1b"); await running;
});

test("named settings and one-shot runs keep working without the screen; unknown names never change anything", async () => {
  const f = await fixture();
  const asked: string[] = [];
  const host = { ...f.host, ask: async (_: string, options: { label: string }[]) => { asked.push(options[0]!.label); return "Detailed"; } };
  await runSettings(host, undefined, "work shown");
  expect(asked).toEqual(["Keep normal"]); expect(await readFile(f.config, "utf8")).toBe("display: detailed\n");
  await runSettings({ ...host, canAsk: false }, undefined, "Work shown"); expect(f.output()).toContain("Work shown: detailed");
  await runSettings({ ...host, canAsk: false });
  for (const area of SETTINGS_AREAS) expect(f.output()).toContain(`${area.name}:`);
  await runSettings(host, undefined, "not a setting"); expect(f.output()).toContain("No setting named not a setting");
});

 test("/settings <name> dispatches locally in a real app and never calls a model", async () => {
  const old = process.env.TERM; process.env.TERM = "xterm-256color";
  const app = await richApp(() => ({ start: async () => { throw new Error("No model"); }, dispose: async () => {} }));
  try {
    await app.until(s => s.includes("idle")); app.input.write("/settings Work shown\r");
    await app.until(s => s.includes("Keep normal")); app.input.write("3");
    await app.until(s => s.includes("[settings] Work shown: detailed."));
    expect(await readFile(path.join(app.home, ".casper", "config.yaml"), "utf8")).toBe("display: detailed\n");
    app.input.end(); await app.interactive;
  } finally { await app.close(); if (old === undefined) delete process.env.TERM; else process.env.TERM = old; }
});
