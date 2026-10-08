import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SuggestionController } from "../src/app/suggestions";
import { FULL_HELP_TEXT } from "../src/tui/help";
import { atAGlance, runSettings, settingRows, type SettingsHost } from "../src/app/settings";
import { planPages } from "../src/app/task-tools";
import type { CasperApp } from "../src/app";
import { loadConfiguration } from "../src/config/load";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { removeTempDir } from "./support/temp-dir";

/** /settings rows for suggestions, the prompt cache, page checks and the OpenRouter app name. */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

async function folders() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-settings-switches-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  return { home, project, config: path.join(home, ".casper", "config.yaml"), projectFile: path.join(project, ".casper", "project.yaml") };
}

function fakeHost(home: string, project: string, answers: (string | undefined)[]): SettingsHost & { asked: string[]; text: () => string } {
  let text = "";
  const asked: string[] = [];
  let context: Awaited<ReturnType<typeof loadProjectContext>> | undefined;
  return {
    output: { write: (chunk: string) => { text += chunk; } }, homeDir: () => home, canAsk: true,
    context: async () => context ??= await loadProjectContext(await inspectProject(project), { homeDir: home }),
    reload: async () => { context = await loadProjectContext(await inspectProject(project), { homeDir: home }); },
    ask: async (question, options) => {
      asked.push(`${question}\n${options.map((option, index) => `${index + 1} ${option.label}${option.description ? ` — ${option.description}` : ""}`).join("\n")}`);
      return answers.shift();
    },
    asked, text: () => text,
  };
}

const rowsFor = async (home: string, project: string) => settingRows(await loadProjectContext(await inspectProject(project), { homeDir: home }));
const valueOf = async (home: string, project: string, label: string) => (await rowsFor(home, project)).find((row) => row.label === label)!.value;

test("Suggestions row: 1 keeps them on, a pick writes suggestions: false, and it reads back off", async () => {
  const { home, project, config } = await folders();
  const host = fakeHost(home, project, ["Suggestions", "Keep them on", "Suggestions", "Turn them off", "Done"]);
  await runSettings(host);
  expect(host.asked[1]!.split("\n").slice(1)).toEqual(["1 Keep them on", "2 Turn them off"]);
  expect(await readFile(config, "utf8")).toBe("suggestions: false\n");
  expect((await host.context())!.suggestions).toBe(false);
  expect(await valueOf(home, project, "Suggestions")).toBe("off");
  expect(host.text()).toContain("[settings] Suggestions: off. Saved in ~/.casper/config.yaml.\n");
});

test("Prompt cache row: 1 keeps the value, then the other values with a few words each; off says it costs more", async () => {
  const { home, project, config } = await folders();
  const host = fakeHost(home, project, ["Prompt cache", "Keep auto", "Prompt cache", "Off", "Done"]);
  await runSettings(host);
  const [question, ...choices] = host.asked[1]!.split("\n");
  expect(question).toStartWith("Prompt cache: auto (");
  expect(choices[0]).toBe("1 Keep auto");
  expect(choices.slice(1).map((line) => line.split(" — ")[0])).toEqual(["2 Long", "3 Short", "4 Off"]);
  for (const line of choices.slice(1)) expect(line).toContain(" — ");
  expect(choices[3]).toContain("costs more");
  expect(await readFile(config, "utf8")).toBe("cache: off\n");
  expect(await valueOf(home, project, "Prompt cache")).toBe("off");
  // From off, 1 keeps off and the others follow.
  const again = fakeHost(home, project, ["Prompt cache", "Long", "Done"]);
  await runSettings(again);
  expect(again.asked[1]!.split("\n").slice(1).map((line) => line.split(" — ")[0])).toEqual(["1 Keep off", "2 Auto", "3 Long", "4 Short"]);
  expect(await readFile(config, "utf8")).toBe("cache: long\n");
  expect((await again.context())!.cache).toBe("long");
});

test("Page checks row: 1 keeps them on, a pick writes pages: off in your own config", async () => {
  const { home, project, config } = await folders();
  const host = fakeHost(home, project, ["Page checks", "Keep them on", "Page checks", "Turn them off", "Done"]);
  await runSettings(host);
  expect(host.asked[1]!.split("\n").slice(1)).toEqual(["1 Keep them on", "2 Turn them off"]);
  expect(await readFile(config, "utf8")).toBe("pages: false\n");
  const loaded = (await host.context())!;
  expect([loaded.pageChecks, loaded.pages]).toEqual([false, "off"]);
  expect(await valueOf(home, project, "Page checks")).toBe("off");
});

test("Packs row: 1 keeps them on, a pick writes packs: false in your own config, and it reads back off", async () => {
  const { home, project, config } = await folders();
  const host = fakeHost(home, project, ["Packs", "Keep them on", "Packs", "Turn them off", "Done"]);
  await runSettings(host);
  expect(host.asked[1]!.split("\n").slice(1)).toEqual(["1 Keep them on", "2 Turn them off"]);
  expect(host.asked[1]).toContain("cost no tokens until a request fits one");
  expect(await readFile(config, "utf8")).toBe("packs: false\n");
  expect((await host.context())!.packs).toBe(false);
  expect(await valueOf(home, project, "Packs")).toBe("off");
});

test("Send Casper's name to OpenRouter row: 1 keeps it on, says what it sends, a pick writes telemetry: false", async () => {
  const { home, project, config } = await folders();
  const label = "Send Casper's name to OpenRouter";
  const host = fakeHost(home, project, [label, "Keep it on", label, "Turn it off", "Done"]);
  await runSettings(host);
  expect(host.asked[1]!.split("\n").slice(1)).toEqual(["1 Keep it on", "2 Turn it off"]);
  expect(host.asked[1]).toContain("the app name and site");
  expect(host.asked[1]).toContain("nothing about your code");
  expect(await readFile(config, "utf8")).toBe("telemetry: false\n");
  expect((await host.context())!.telemetry).toBe(false);
  expect(await valueOf(home, project, label)).toBe("off");
});

test("page checks off in your config: no page check after a UI change, and a project file can't turn them back on", async () => {
  const { home, project, config, projectFile } = await folders();
  await writeFile(path.join(project, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, dependencies: { react: "18", vite: "5" } }));
  await writeFile(path.join(project, "bun.lock"), "");
  await mkdir(path.join(project, "node_modules")); await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "src", "App.tsx"), "export default function App() { return null; }\n");
  const app = { activeWorkspaceRoot: () => project } as unknown as CasperApp;
  const load = async () => loadProjectContext(await inspectProject(project), { homeDir: home });
  // On by default: a UI change plans a page check.
  expect(await planPages(app, await load(), ["src/App.tsx"])).toMatchObject({ pages: { open: ["/"] } });
  await writeFile(config, "pages: off\n");
  expect(await planPages(app, await load(), ["src/App.tsx"])).toBeUndefined();
  // A project file listing pages to always open doesn't turn them back on.
  await writeFile(projectFile, "pages: [/dashboard]\n");
  const listed = await load();
  expect(listed.pages).toBe("off");
  expect(await planPages(app, listed, ["src/App.tsx"])).toBeUndefined();
  // Nor does a profile the project picks.
  await mkdir(path.join(home, ".casper", "profiles", "lab"), { recursive: true });
  await writeFile(path.join(home, ".casper", "profiles", "lab", "config.yaml"), "pages: on\n");
  await writeFile(projectFile, "profile: lab\npages: [/dashboard]\n");
  expect((await load()).pages).toBe("off");
  // Your own config takes on or off only; a list of pages stays a project setting.
  await writeFile(projectFile, "");
  await writeFile(config, "pages: [/home]\n");
  await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("a list of pages is a project setting");
  // A project file can still turn them off for itself.
  await writeFile(config, "pages: on\n");
  await writeFile(projectFile, "pages: off\n");
  expect((await load()).pages).toBe("off");
});

test("telemetry: off loads from your own config; a project file can't set it", async () => {
  const { home, project, config, projectFile } = await folders();
  const load = () => loadConfiguration({ projectRoot: project, homeDir: home });
  expect((await load()).telemetry).toBeUndefined();
  await writeFile(config, "telemetry: off\n");
  expect((await load()).telemetry).toBe(false);
  await writeFile(config, "telemetry: on\n");
  expect((await load()).telemetry).toBe(true);
  await writeFile(projectFile, "telemetry: on\n");
  await expect(load()).rejects.toThrow("telemetry is a user setting");
  await writeFile(projectFile, "");
  await writeFile(config, "telemetry: maybe\n");
  await expect(load()).rejects.toThrow("telemetry must be on or off");
});

test("the at-a-glance list includes the new rows and stays within 80 columns", async () => {
  const { home, project, config } = await folders();
  await writeFile(config, "suggestions: false\ncache: short\npages: off\ntelemetry: off\n");
  const host = fakeHost(home, project, [undefined]);
  await runSettings(host);
  const first = host.asked[0]!;
  for (const item of ["Suggestions: off", "Prompt cache: short", "Page checks: off", "Send Casper's name to OpenRouter: off"]) expect(first).toContain(item);
  const glance = first.slice(0, first.indexOf("\n1 Done"));
  for (const line of glance.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  const rows = await rowsFor(home, project);
  for (const line of atAGlance(rows).split("\n")) expect(line.length).toBeLessThanOrEqual(80);
});

test("CONFIGURATION.md's /settings sample is what a default config prints: the lines at a glance and the numbered list", async () => {
  const { home, project } = await folders();
  const host = fakeHost(home, project, [undefined]);
  await runSettings(host);
  const [question, ...options] = host.asked[0]!.split("\nPick one to change:\n");
  const doc = await readFile(path.join(import.meta.dir, "..", "docs", "CONFIGURATION.md"), "utf8");
  const sample = /```text\n(Settings \(saved in[^]*?)\n```/.exec(doc)![1]!.split("\nPick one to change:\n");
  expect(sample[0]).toBe(question!);
  // The numbered list as the picker lays it out: number, label, then the value.
  const listed = sample[1]!.split("\n").map((line) => line.trim().replace(/\s{2,}/g, " — "));
  expect(listed).toEqual(options.join("").split("\n"));
});

test("suggestions: false from /settings applies in the session without a restart", async () => {
  const { home, project, config } = await folders();
  const controller = new SuggestionController(() => {}, () => home);
  const load = async () => loadProjectContext(await inspectProject(project), { homeDir: home });
  expect((await controller.state(await load()))!.allOff).toBe(false);
  await writeFile(config, "suggestions: false\n");
  const off = (await controller.state(await load()))!;
  expect([off.allOff, off.offByConfig]).toEqual([true, true]);
});

test("the long help's /settings line lists every switch", async () => {
  const { home, project } = await folders();
  const line = FULL_HELP_TEXT.split("\n").find((entry) => entry.trimStart().startsWith("/settings "))!.toLowerCase();
  for (const row of await rowsFor(home, project)) expect(line).toContain(row.label.toLowerCase());
});
