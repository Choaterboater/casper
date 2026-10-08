import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { wordmarkHeader } from "../src/tui/banner";
import { markdownTheme, tint } from "../src/tui/format";
import { panelColor, renderCodeBlock, renderPanel } from "../src/tui/presentation";
import {
  activeThemeName, BUILT_IN_THEMES, colorCode, DEFAULT_THEME, registerTheme, roleCode, THEME_ROLES, themeNames, themeNote,
  unregisterTheme, useTheme, type Theme,
} from "../src/tui/theme";
import { parseThemeFile } from "../src/tui/theme-file";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { runSettings, settingRows, type SettingsHost } from "../src/app/settings";
import { checkConfig } from "../src/doctor/checks";
import { formatDoctorLines } from "../src/doctor/run";
import { CasperApp } from "../src/app";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => {
  for (const name of themeNames()) unregisterTheme(name);
  useTheme(undefined);
  await Promise.all(roots.splice(0).map((root) => removeTempDir(root)));
});

async function place() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-theme-")); roots.push(root);
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper", "agent"), { recursive: true }); await mkdir(project);
  return { home, project, config: path.join(home, ".casper", "config.yaml") };
}

const CORNERS = ["╭", "╮", "╰", "╯"] as const;

test("the default theme draws exactly the colours Casper drew before themes", () => {
  // The SGR codes each place used before roles existed: cyan structure, dim for what is secondary.
  const before: Record<(typeof THEME_ROLES)[number], string> = {
    accent: "36", muted: "2", border: "2", selection: "36", success: "32", warning: "33", error: "31", diffAdded: "32", diffRemoved: "31", diffHunk: "36",
  };
  expect(activeThemeName()).toBe("default");
  for (const role of THEME_ROLES) expect(tint("x", role, true)).toBe(`\x1b[${before[role]}mx\x1b[0m`);
  // Bold headings, the CASPER header and the writes badge keep bold first.
  expect(tint("x", "accent", true, "1")).toBe("\x1b[1;36mx\x1b[0m");
  expect(tint("x", "warning", true, "1")).toBe("\x1b[1;33mx\x1b[0m");
  const markdown = markdownTheme(true);
  expect([markdown.heading("h"), markdown.link("l"), markdown.linkUrl("u"), markdown.code("c"), markdown.codeBlockBorder("b"), markdown.quote("q"), markdown.hr("-"), markdown.listBullet("•"), markdown.bold("B")])
    .toEqual(["\x1b[1;36mh\x1b[0m", "\x1b[36ml\x1b[0m", "\x1b[2mu\x1b[0m", "\x1b[36mc\x1b[0m", "\x1b[2mb\x1b[0m", "\x1b[2mq\x1b[0m", "\x1b[2m-\x1b[0m", "\x1b[36m•\x1b[0m", "\x1b[1mB\x1b[0m"]);
  expect(["accent", "success", "warning", "error", "muted"].map((tone) => panelColor("t", tone as "accent", true)))
    .toEqual(["\x1b[36mt\x1b[0m", "\x1b[32mt\x1b[0m", "\x1b[33mt\x1b[0m", "\x1b[31mt\x1b[0m", "\x1b[2mt\x1b[0m"]);
  expect(renderPanel("Working", ["step"], 20, true, "accent", CORNERS)).toEqual([
    "\x1b[36m╭─ Working ────────╮\x1b[0m", "\x1b[36m│\x1b[0m step             \x1b[36m│\x1b[0m", "\x1b[36m╰──────────────────╯\x1b[0m",
  ]);
  expect(renderCodeBlock("ts", ["let a = 1;"], 12, true)).toEqual(["\x1b[2m── ts ──────\x1b[0m", "let a = 1;", "\x1b[2m────────────\x1b[0m"]);
  const art = wordmarkHeader(true).render(200);
  expect(art[1]).toBe("\x1b[1m ▄▄███▄▄ \x1b[0m  \x1b[36m ██████  █████  ███████ ██████  ███████ ██████ \x1b[0m");
  expect(wordmarkHeader(true).render(20)[0]).toStartWith("\x1b[1;36mCASPER ");
});

test("light and high-contrast change only the colours; without colour every theme is plain text", () => {
  expect(themeNames()).toEqual(["default", "light", "high-contrast"]);
  expect(useTheme("light")).toBe(true);
  expect([roleCode("accent"), roleCode("warning"), roleCode("muted")]).toEqual(["34", "35", "2"]);
  expect(markdownTheme(true).heading("h")).toBe("\x1b[1;34mh\x1b[0m");
  expect(useTheme("high-contrast")).toBe(true);
  // Secondary text at full strength: no code at all, so nothing is added; bold alone stays bold.
  expect(tint("hint", "muted", true)).toBe("hint");
  expect(tint("hint", "muted", true, "1")).toBe("\x1b[1mhint\x1b[0m");
  expect(tint("✗ failed", "error", true)).toBe("\x1b[91m✗ failed\x1b[0m");
  for (const theme of BUILT_IN_THEMES) {
    useTheme(theme.name);
    for (const role of THEME_ROLES) expect(tint("plain", role, false, "1")).toBe("plain");
    expect(renderPanel("Box", ["a"], 12, false, "warning", CORNERS).join("\n")).not.toContain("\x1b");
  }
  // A name Casper has no theme for uses default, and says so in one line.
  expect(useTheme("sunset")).toBe(false);
  expect(activeThemeName()).toBe("default");
  expect(roleCode("accent")).toBe("36");
  expect(themeNote("sunset")).toBe("theme sunset is not one Casper has; using default. Themes: default, light, high-contrast");
  expect(themeNote("light")).toBeUndefined();
  expect(themeNote(undefined)).toBeUndefined();
});

test("a #rrggbb colour is 24-bit where the terminal says it draws it, else the nearest of 256", () => {
  expect(colorCode("#3366ff", { COLORTERM: "truecolor" })).toBe("38;2;51;102;255");
  expect(colorCode("#3366ff", { WT_SESSION: "1" })).toBe("38;2;51;102;255");
  expect(colorCode("#3366ff", {})).toBe("38;5;63");
  expect(colorCode("#808080", {})).toBe("38;5;244");
  expect(colorCode("#000000", {})).toBe("38;5;16");
  expect(colorCode("dim", {})).toBe("2");
  expect(colorCode("default", {})).toBe("");
});

test("a registered theme is offered by name; a taken name, a bad colour or a bad name is refused", () => {
  const parsed = parseThemeFile('name: ocean\ncolors:\n  accent: "#3366ff"\n  warning: bright-yellow\n');
  if (!("theme" in parsed)) throw new Error(parsed.error);
  registerTheme(parsed.theme);
  expect(themeNames()).toEqual(["default", "light", "high-contrast", "ocean"]);
  expect(useTheme("ocean", { COLORTERM: "24bit" })).toBe(true);
  expect(tint("x", "accent", true)).toBe("\x1b[38;2;51;102;255mx\x1b[0m");
  // A role the file left out takes the default theme's colour.
  expect(roleCode("error")).toBe("31");
  expect(() => registerTheme(parsed.theme)).toThrow("there is already a theme named ocean");
  expect(() => registerTheme({ ...DEFAULT_THEME })).toThrow("there is already a theme named default");
  expect(() => registerTheme({ name: "Bad Name", colors: DEFAULT_THEME.colors })).toThrow("lowercase letters");
  expect(() => registerTheme({ name: "sneaky", colors: { ...DEFAULT_THEME.colors, accent: "31m\x1b[2J" } })).toThrow("accent must be #rrggbb");
  expect(() => registerTheme({ name: "partial", colors: { accent: "red" } } as unknown as Theme)).toThrow("muted must be #rrggbb");
  // The theme kept is a frozen copy: changing the object handed in changes nothing.
  const mutable = { name: "copy", colors: { ...DEFAULT_THEME.colors } };
  registerTheme(mutable);
  mutable.colors.accent = "31m\x1b[2J";
  useTheme("copy");
  expect(roleCode("accent")).toBe("36");
  // Built-in themes can't be taken off the list.
  expect(unregisterTheme("default")).toBe(false);
  expect(unregisterTheme("ocean")).toBe(true);
  expect(themeNames()).not.toContain("ocean");
});

test("theme: is your own setting: a project file can't set it, a bad value is named, an unknown name loads as default", async () => {
  const { home, project, config } = await place();
  await writeFile(config, "theme: light\n");
  expect((await loadProjectContext(await inspectProject(project), { homeDir: home })).theme).toBe("light");
  await writeFile(config, "theme: 5\n");
  await expect(loadProjectContext(await inspectProject(project), { homeDir: home })).rejects.toThrow("~/.casper/config.yaml: theme must be a theme's name");
  await writeFile(config, "theme: sunset\n");
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  expect(context.theme).toBe("sunset");
  expect(context.warnings ?? []).toEqual([]);
  expect(settingRows(context).find((row) => row.label === "Theme")!.value).toBe("default");
  // casper doctor names it as worth knowing, not as something to fix.
  const doctor = await checkConfig({ homeDir: home, projectRoot: project, env: {}, platform: process.platform, currentVersion: "0.0.0",
    install: { kind: "binary", executable: path.join(home, "casper") }, agentDir: path.join(home, ".casper", "agent") });
  expect(formatDoctorLines(doctor.lines)).toBe("! theme sunset is not one Casper has; using default. Themes: default, light, high-contrast\n");
  await mkdir(path.join(project, ".casper"));
  await writeFile(path.join(project, ".casper", "project.yaml"), "theme: high-contrast\n");
  await expect(loadProjectContext(await inspectProject(project), { homeDir: home })).rejects.toThrow("theme is a user setting");
});

test("/settings: Theme lists every theme by name, 1 keeps it, and a pick is saved as theme:", async () => {
  const { home, project, config } = await place();
  const asked: string[] = [];
  const answers = ["Theme", "High-contrast", "Done"];
  let output = "";
  let context: Awaited<ReturnType<typeof loadProjectContext>> | undefined;
  const host: SettingsHost = {
    output: { write: (text) => { output += text; } }, homeDir: () => home, canAsk: true,
    context: async () => context ??= await loadProjectContext(await inspectProject(project), { homeDir: home }),
    reload: async () => { context = await loadProjectContext(await inspectProject(project), { homeDir: home }); },
    ask: async (question, options) => { asked.push(`${question}\n${options.map((option, index) => `${index + 1} ${option.label}${option.description ? ` · ${option.description}` : ""}`).join("\n")}`); return answers.shift(); },
  };
  await runSettings(host);
  expect(asked[1]).toBe("Theme: default. It changes the colours only, from now on; NO_COLOR still turns colour off.\n1 Keep default\n2 Light · for a light terminal background\n3 High-contrast · bright colours, no faint text");
  expect(await Bun.file(config).text()).toBe("theme: high-contrast\n");
  expect(output).toContain("[settings] Theme: high-contrast. Saved in ~/.casper/config.yaml.\n");
  expect(asked[2]).toContain("Theme: high-contrast");
});

test("Casper starts in your theme, and names a theme it doesn't have once with the [config] lines", async () => {
  const { home, project, config } = await place();
  await writeFile(config, "theme: sunset\n");
  let output = "";
  useTheme("light");
  const app = new CasperApp({ output: { write: (text) => { output += text; } }, runtimeFactory() { throw new Error("No model expected"); }, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }) });
  try {
    await app.start(project);
    expect(activeThemeName()).toBe("default");
    expect(output.split("\n").filter((line) => line.includes("sunset"))).toEqual(["[config] theme sunset is not one Casper has; using default. Themes: default, light, high-contrast"]);
  } finally { await app.close(); }
  await writeFile(config, "theme: light\n");
  const again = new CasperApp({ output: { write: () => {} }, runtimeFactory() { throw new Error("No model expected"); }, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }) });
  try {
    await again.start(project);
    expect(activeThemeName()).toBe("light");
  } finally { await again.close(); }
});
