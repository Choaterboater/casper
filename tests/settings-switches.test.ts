import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SuggestionController } from "../src/app/suggestions";
import { FULL_HELP_TEXT } from "../src/tui/help";
import { runSettings, settingRows, type SettingsHost } from "../src/app/settings";
import { SettingsScreen } from "../src/tui/settings-screen";
import { SETTINGS_AREAS, settingsArea } from "../src/app/settings-areas";
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

test("Updates row: auto by default, Keep first, and every mode saves as text and reloads", async () => {
  const { home, project, config } = await folders();
  const initial = (await rowsFor(home, project)).find((row) => row.label === "Updates")!;
  expect(initial.value).toBe("auto");
  expect(initial.keep).toBe("Keep auto");
  expect(initial.choices.map((choice) => [choice.label, choice.keys, choice.value])).toEqual([
    ["Notify only", ["updates"], "notify"], ["Off", ["updates"], "off"],
  ]);
  expect(initial.question).toContain("restart to use the update");
  expect(initial.question).toContain("CASPER_NO_UPDATE_CHECK=1 and CI");
  expect((await rowsFor(home, project)).some((row) => row.label === "New-version notice")).toBe(false);
  expect(SETTINGS_AREAS[settingsArea("Updates")]!.name).toBe("Display");
  const host = fakeHost(home, project, ["Updates", "Keep auto", "Done"]);
  await runSettings(host);
  expect(host.asked[1]!.split("\n").slice(1).map((line) => line.split(" — ")[0])).toEqual(["1 Keep auto", "2 Notify only", "3 Off"]);
  await expect(readFile(config, "utf8")).rejects.toThrow();
  for (const mode of ["notify", "off", "auto"] as const) {
    const shown = mode === "notify" ? "notify only" : mode;
    const choice = mode === "notify" ? "Notify only" : `${mode[0]!.toUpperCase()}${mode.slice(1)}`;
    const change = fakeHost(home, project, ["Updates", choice, "Done"]);
    await runSettings(change);
    expect(await readFile(config, "utf8")).toBe(`updates: ${mode}\n`);
    expect((await change.context())!.updates).toBe(mode);
    expect(await valueOf(home, project, "Updates")).toBe(shown);
    expect(change.text()).toContain(`[settings] Updates: ${shown}. Saved in ~/.casper/config.yaml.`);
  }
});

test("updates defaults to auto and normalizes every mode and the legacy boolean switch", async () => {
  const { home, project, config } = await folders();
  const load = () => loadConfiguration({ projectRoot: project, homeDir: home, profileName: "default" });
  expect((await load()).updates).toBe("auto");
  for (const [source, mode] of [["auto", "auto"], ["notify", "notify"], ["off", "off"], ["false", "off"], ["true", "auto"], ["on", "auto"]] as const) {
    await writeFile(config, `updates: ${source}\n`);
    const loaded = await load();
    expect(loaded.updates).toBe(mode);
    expect(loaded.warnings).toEqual([]);
    expect(await valueOf(home, project, "Updates")).toBe(mode === "notify" ? "notify only" : mode);
  }
  for (const invalid of ["sometimes", "[]", "{}", "1", '"false"']) {
    await writeFile(config, `updates: ${invalid}\n`);
    await expect(load()).rejects.toThrow("updates must be auto, notify or off");
  }
});

test("a project cannot set updates in any mode or with the legacy booleans", async () => {
  const { home, project, projectFile } = await folders();
  for (const value of ["auto", "notify", "off", "true", "false"]) {
    await writeFile(projectFile, `updates: ${value}\n`);
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("updates is a user setting");
  }
});

test("updates follows only a user-selected profile, never a profile chosen by the project", async () => {
  const { home, project, config, projectFile } = await folders();
  const previous = process.env.CASPER_PROFILE;
  try {
    delete process.env.CASPER_PROFILE;
    const profile = path.join(home, ".casper", "profiles", "fixture");
    const own = path.join(home, ".casper", "profiles", "default");
    await mkdir(profile, { recursive: true });
    await mkdir(own, { recursive: true });
    await writeFile(config, "updates: off\n");
    await writeFile(path.join(own, "config.yaml"), "updates: notify\n");
    await writeFile(projectFile, "profile: fixture\n");
    for (const mode of ["auto", "notify", "off"] as const) {
      await writeFile(path.join(profile, "config.yaml"), `updates: ${mode}\n`);
      expect((await loadConfiguration({ projectRoot: project, homeDir: home })).updates).toBe("notify");
      expect((await loadConfiguration({ projectRoot: project, homeDir: home, profileName: "fixture" })).updates).toBe(mode);
    }
    await writeFile(config, "profile: fixture\nupdates: auto\n");
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).updates).toBe("off");
  } finally {
    if (previous === undefined) delete process.env.CASPER_PROFILE; else process.env.CASPER_PROFILE = previous;
  }
});

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

test("/settings typed during a task says when the change reaches it: its next step, the next task, or nothing to add", async () => {
  const { home, project } = await folders();
  const host = { ...fakeHost(home, project, ["Private ssh passwords", "Turn it off", "Helpers that build", "Turn them on", "Web lookups", "Turn them off",
    "Suggestions", "Turn them off", "Prompt cache", "Off", "Done"]), duringTask: true };
  await runSettings(host);
  expect(host.text()).toContain("[settings] Private ssh passwords: off. Saved in ~/.casper/config.yaml. The running task uses it from its next step.\n");
  // Tools made once per task (helpers, web, the reader): the running task keeps them.
  expect(host.text()).toContain("[settings] Helpers that build: on. Saved in ~/.casper/config.yaml. The running task keeps what it had; your next request uses it.\n");
  expect(host.text()).toContain("[settings] Web lookups: off. Saved in ~/.casper/config.yaml. The running task keeps what it had; your next request uses it.\n");
  // Applies now, outside the task; and one whose question already says the next start.
  expect(host.text()).toContain("[settings] Suggestions: off. Saved in ~/.casper/config.yaml.\n");
  expect(host.text()).toContain("[settings] Prompt cache: off. Saved in ~/.casper/config.yaml.\n");
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

test("Hide old tool output: on by default, off persists, on resumes, and applies at the next step", async () => {
  const { home, project, config, projectFile } = await folders();
  const host = { ...fakeHost(home, project, ["Hide old tool output", "Keep it on", "Hide old tool output", "Turn it off", "Done"]), duringTask: true };
  await runSettings(host);
  expect(host.asked[1]!.split("\n").slice(1)).toEqual(["1 Keep it on", "2 Turn it off"]);
  expect(host.asked[1]).toContain("Off stops new hiding, not existing stubs");
  expect(await readFile(config, "utf8")).toBe("hide_tool_output: false\n");
  expect((await host.context())!.hideToolOutput).toBe(false);
  expect(host.text()).toContain("The running task uses it from its next step.");
  await runSettings(fakeHost(home, project, ["Hide old tool output", "Turn it on", "Done"]));
  expect(await valueOf(home, project, "Hide old tool output")).toBe("on");
  await writeFile(config, "hide_tool_output: maybe\n");
  await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("hide_tool_output must be on or off");
  await writeFile(config, "hide_tool_output: off\n");
  await writeFile(projectFile, "hide_tool_output: on\n");
  await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("hide_tool_output is a user setting");
});

test("Lean guidance: auto by default, keep first, off and auto persist, applies next step", async () => {
  const { home, project, config } = await folders();
  expect(await valueOf(home, project, "Lean guidance")).toBe("auto");
  const host = { ...fakeHost(home, project, ["Lean guidance", "Keep auto", "Lean guidance", "Off", "Done"]), duringTask: true };
  await runSettings(host);
  expect(host.asked[1]!.split("\n").slice(1)).toEqual(["1 Keep auto", "2 Off"]);
  expect(host.asked[1]).toContain("Same tools and abilities");
  expect(await readFile(config, "utf8")).toBe("lean_guidance: off\n");
  expect((await host.context())!.leanGuidance).toBe("off");
  expect(host.text()).toContain("The running task uses it from its next step.");
  const again = fakeHost(home, project, ["Lean guidance", "Keep off", "Lean guidance", "Auto", "Done"]);
  await runSettings(again);
  expect(again.asked[1]!.split("\n").slice(1)).toEqual(["1 Keep off", "2 Auto"]);
  expect(await readFile(config, "utf8")).toBe("lean_guidance: auto\n");
  expect(await valueOf(home, project, "Lean guidance")).toBe("auto");
  expect(FULL_HELP_TEXT).toContain("lean guidance");
});

test("lean guidance rejects invalid values and project files; only user-selected profiles apply", async () => {
  const { home, project, config, projectFile } = await folders();
  for (const value of ["maybe", "true", "false", "on", "[]", "null"]) {
    await writeFile(config, `lean_guidance: ${value}\n`);
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("lean_guidance must be auto or off");
  }
  await writeFile(config, "lean_guidance: off\n");
  for (const value of ["off", "auto"]) {
    await writeFile(projectFile, `lean_guidance: ${value}\n`);
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("lean_guidance is a user setting");
  }
  const profile = path.join(home, ".casper", "profiles", "fixture");
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "config.yaml"), "lean_guidance: auto\n");
  await writeFile(projectFile, "profile: fixture\n");
  expect((await loadConfiguration({ projectRoot: project, homeDir: home })).leanGuidance).toBe("off");
  expect((await loadConfiguration({ projectRoot: project, homeDir: home, profileName: "fixture" })).leanGuidance).toBe("auto");
});

test("history hiding follows only a profile the person chose, not one selected by the project", async () => {
  const { home, project, projectFile } = await folders();
  const profile = path.join(home, ".casper", "profiles", "fixture");
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "config.yaml"), "hide_tool_output: off\n");
  await writeFile(projectFile, "profile: fixture\n");
  expect((await loadConfiguration({ projectRoot: project, homeDir: home })).hideToolOutput).toBeUndefined();
  expect((await loadConfiguration({ projectRoot: project, homeDir: home, profileName: "fixture" })).hideToolOutput).toBe(false);
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

test("Page checks explains that off also disables final app smoke for app, server and API changes", async () => {
  const { home, project } = await folders();
  const host = fakeHost(home, project, ["Page checks", "Keep them on", "Done"]);
  await runSettings(host);
  expect(host.asked[1]).toContain("Turning them off also turns off the final app smoke for app, server and API changes.");
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

test("Private ssh passwords row: on by default, says what the box is, a pick writes ssh_login: false", async () => {
  const { home, project, config } = await folders();
  const label = "Private ssh passwords";
  const host = fakeHost(home, project, [label, "Keep it on", label, "Turn it off", "Done"]);
  await runSettings(host);
  expect(host.asked[1]!.split("\n").slice(1)).toEqual(["1 Keep it on", "2 Turn it off"]);
  expect(host.asked[1]).toContain("1 No, 2 Yes once, 3 Yes for this session");
  expect(host.asked[1]).toContain("The AI never sees what you type");
  expect(await readFile(config, "utf8")).toBe("ssh_login: false\n");
  expect((await host.context())!.sshLogin).toBe(false);
  expect(await valueOf(home, project, label)).toBe("off");
});

test("ssh_login: off loads from your own config; a project file can't set it", async () => {
  const { home, project, config, projectFile } = await folders();
  const load = () => loadConfiguration({ projectRoot: project, homeDir: home });
  expect((await load()).sshLogin).toBeUndefined();
  await writeFile(config, "ssh_login: off\n");
  expect((await load()).sshLogin).toBe(false);
  await writeFile(config, "ssh_login: on\n");
  expect((await load()).sshLogin).toBe(true);
  await writeFile(projectFile, "ssh_login: off\n");
  await expect(load()).rejects.toThrow("ssh_login is a user setting");
  await writeFile(projectFile, "");
  await writeFile(config, "ssh_login: maybe\n");
  await expect(load()).rejects.toThrow("ssh_login must be on or off");
});

test("Sign-ins from other tools row: on by default, says nothing is taken without a pick, a pick writes other_logins: false", async () => {
  const { home, project, config } = await folders();
  const label = "Sign-ins from other tools";
  const host = fakeHost(home, project, [label, "Keep it on", label, "Turn it off", "Done"]);
  await runSettings(host);
  expect(host.asked[1]!.split("\n").slice(1)).toEqual(["1 Keep it on", "2 Turn it off"]);
  expect(host.asked[1]).toContain("Claude Code, Codex CLI or GitHub CLI");
  expect(host.asked[1]).toContain("Nothing is taken without your pick");
  expect(await readFile(config, "utf8")).toBe("other_logins: false\n");
  expect((await host.context())!.otherLogins).toBe(false);
  expect(await valueOf(home, project, label)).toBe("off");
});

test("Notifications row: on by default, says it rings only when the terminal is not in front, a pick writes notifications: false", async () => {
  const { home, project, config, projectFile } = await folders();
  const host = fakeHost(home, project, ["Notifications", "Turn them off", "Done"]);
  await runSettings(host);
  expect(host.asked[1]!.split("\n").slice(1)).toEqual(["1 Keep them on", "2 Turn them off"]);
  expect(host.asked[1]).toContain("not in front");
  expect(await readFile(config, "utf8")).toBe("notifications: false\n");
  expect((await host.context())!.notifications).toBe(false);
  await writeFile(projectFile, "notifications: on\n");
  await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("notifications is a user setting");
});

test("other_logins: off loads from your own config; a project file can't set it", async () => {
  const { home, project, config, projectFile } = await folders();
  const load = () => loadConfiguration({ projectRoot: project, homeDir: home });
  expect((await load()).otherLogins).toBeUndefined();
  await writeFile(config, "other_logins: off\n");
  expect((await load()).otherLogins).toBe(false);
  await writeFile(projectFile, "other_logins: on\n");
  await expect(load()).rejects.toThrow("other_logins is a user setting");
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

test("plain settings include each row once with its area and current value, without a repeated summary", async () => {
  const { home, project, config } = await folders();
  await writeFile(config, "suggestions: false\ncache: short\npages: off\ntelemetry: off\n");
  const host = fakeHost(home, project, [undefined]);
  await runSettings(host);
  const first = host.asked[0]!;
  for (const row of await rowsFor(home, project)) {
    expect(first).toContain(`${row.label} — ${SETTINGS_AREAS[settingsArea(row.label)]!.name} · ${row.value}`);
    expect(first.split("\n").filter(line => line.includes(`${row.label} — `))).toHaveLength(1);
  }
  expect(first).not.toContain("Suggestions: off");
});

test("CONFIGURATION.md's /settings capture is the default 80-column screen, and docs explain every key and fallback", async () => {
  const { home, project } = await folders();
  const screen = new SettingsScreen(await rowsFor(home, project), false, async () => { throw new Error("no change"); }, () => {}, () => {});
  const doc = await readFile(path.join(import.meta.dir, "..", "docs", "CONFIGURATION.md"), "utf8");
  const sample = /```text\n([^]*?)\n```/.exec(doc)![1]!;
  expect(sample).toBe(screen.render(80).join("\n"));
  for (const phrase of ["Up/Down", "Enter or Space", "Left/Right or Tab", "Typing filters", "Backspace", "Esc closes", "Below 80 columns", "NO_COLOR", "TERM=dumb", "/settings <name>"]) expect(doc).toContain(phrase);
  const terminal = await readFile(path.join(import.meta.dir, "..", "docs", "TERMINAL_UX.md"), "utf8");
  expect(terminal).toContain("Up/Down moves; Enter/Space changes; Left/Right or Tab switches areas; type to search; Esc closes");
  const release = await readFile(path.join(import.meta.dir, "..", "docs", "RELEASE.md"), "utf8");
  expect(release.slice(0, release.indexOf("## v0.2.34:"))).toContain("`/settings` is one grouped screen");
  const roadmap = await readFile(path.join(import.meta.dir, "..", "site", "roadmap.html"), "utf8");
  expect(roadmap.slice(roadmap.indexOf('id="v0235"'), roadmap.indexOf('id="v0234"'))).toContain("seven areas, aligned labels and values");
});

test("every \"it writes `name: value`\" in CONFIGURATION.md is the line /settings writes when you turn that row off", async () => {
  const doc = await readFile(path.join(import.meta.dir, "..", "docs", "CONFIGURATION.md"), "utf8");
  const claims = [...doc.matchAll(/it\s+writes\s+`([A-Za-z]+): ([a-z]+)`/g)].map(([, key, value]) => ({ key: key!, value: value! }));
  expect(claims.map((claim) => claim.key)).toEqual(expect.arrayContaining(["web", "reader", "browser", "templates", "packs", "github", "visualize", "pages", "telemetry", "suggestions"]));
  for (const { key, value } of claims) {
    const { home, project, config } = await folders();
    const rows = await rowsFor(home, project);
    let found: { row: string; choice: string } | undefined;
    for (const row of rows) {
      for (const choice of row.choices) {
        const keys = typeof choice.keys === "function" ? await choice.keys(home) : choice.keys;
        if (keys?.join(".") === key && choice.value === false) found = { row: row.label, choice: choice.label };
      }
    }
    expect({ key, row: found?.row }).toEqual({ key, row: expect.any(String) });
    await runSettings(fakeHost(home, project, [found!.row, found!.choice, "Done"]));
    expect({ key, written: await readFile(config, "utf8") }).toEqual({ key, written: `${key}: ${value}\n` });
  }
});

test("CONFIGURATION.md's \"off works the same for every switch except …\" holds for every /settings row that turns something off", async () => {
  const doc = (await readFile(path.join(import.meta.dir, "..", "docs", "CONFIGURATION.md"), "utf8")).replace(/\s+/g, " ");
  const sentence = /`off` works the same for every switch except (.+?)\. /.exec(doc)?.[1];
  expect(sentence).toBeDefined();
  const except = [...sentence!.matchAll(/`([A-Za-z0-9.]+)`/g)].map(([, key]) => key!).filter((key) => !["true", "false", "off"].includes(key));
  const { home, project, config } = await folders();
  const switches = new Set<string>();
  for (const row of await rowsFor(home, project)) {
    for (const choice of row.choices) {
      const keys = typeof choice.keys === "function" ? await choice.keys(home) : choice.keys;
      if (keys && choice.value === false) switches.add(keys.join("."));
    }
  }
  expect([...switches]).toEqual(expect.arrayContaining(except));
  for (const key of switches) {
    const parts = key.split(".");
    await writeFile(config, parts.map((part, index) => `${"  ".repeat(index)}${part}:${index === parts.length - 1 ? " off" : ""}`).join("\n") + "\n");
    const loaded = await loadProjectContext(await inspectProject(project), { homeDir: home }).then(() => "loads", () => "refused");
    expect({ key, off: loaded }).toEqual({ key, off: except.includes(key) ? "refused" : "loads" });
  }
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
  const line = FULL_HELP_TEXT.split("\n").find((entry) => entry.trimStart().startsWith("/settings [name], /config [name] "))!.toLowerCase();
  for (const row of await rowsFor(home, project)) expect(line).toContain(row.label.toLowerCase());
});

test("Local models row: on by default, names the servers, a pick writes localModels: false", async () => {
  const { home, project, config } = await folders();
  const label = "Local models";
  const host = fakeHost(home, project, [label, "Keep them on", label, "Turn them off", "Done"]);
  await runSettings(host);
  expect(host.asked[1]!.split("\n").slice(1)).toEqual(["1 Keep them on", "2 Turn them off"]);
  expect(host.asked[1]).toContain("Ollama, LM Studio, llama.cpp and vLLM");
  expect(host.asked[1]).toContain("from the next start");
  expect(await readFile(config, "utf8")).toBe("localModels: false\n");
  expect((await host.context())!.localModels).toBe(false);
  expect(await valueOf(home, project, label)).toBe("off");
});

test("localModels: off loads from your own config; a project file can't set it", async () => {
  const { home, project, config, projectFile } = await folders();
  const load = () => loadConfiguration({ projectRoot: project, homeDir: home });
  expect((await load()).localModels).toBeUndefined();
  await writeFile(config, "localModels: off\n");
  expect((await load()).localModels).toBe(false);
  await writeFile(config, "localModels: on\n");
  expect((await load()).localModels).toBe(true);
  await writeFile(projectFile, "localModels: false\n");
  await expect(load()).rejects.toThrow("localModels is a user setting");
  await writeFile(projectFile, "");
  await writeFile(config, "localModels: maybe\n");
  await expect(load()).rejects.toThrow("localModels must be true or false");
});

test("Network server updates row: on by default, says how a release is checked, a pick writes network_updates: off", async () => {
  const { home, project, config } = await folders();
  const label = "Network server updates";
  const host = fakeHost(home, project, [label, "Turn it off", "Done"]);
  await runSettings(host);
  expect(host.asked[1]!.split("\n").slice(1)).toEqual(["1 Keep it on", "2 Turn it off"]);
  expect(host.asked[1]).toContain("hash lock after a check");
  expect(await readFile(config, "utf8")).toBe("network_updates: false\n");
  expect((await host.context())!.networkUpdates).toBe(false);
  expect(await valueOf(home, project, label)).toBe("off");
});

test("network_updates: off loads from your own config; a project file can't set it", async () => {
  const { home, project, config, projectFile } = await folders();
  const load = () => loadConfiguration({ projectRoot: project, homeDir: home });
  expect((await load()).networkUpdates).toBeUndefined();
  await writeFile(config, "network_updates: off\n");
  expect((await load()).networkUpdates).toBe(false);
  await writeFile(config, "network_updates: on\n");
  expect((await load()).networkUpdates).toBe(true);
  await writeFile(projectFile, "network_updates: on\n");
  await expect(load()).rejects.toThrow("network_updates is a user setting");
  await writeFile(projectFile, "");
  await writeFile(config, "network_updates: maybe\n");
  await expect(load()).rejects.toThrow("network_updates must be on or off");
});

test("Reasoning headline: on by default, off persists, on resumes, and a project file can't set it", async () => {
  const { home, project, config, projectFile } = await folders();
  const host = { ...fakeHost(home, project, ["Reasoning headline", "Turn it off", "Done"]), duringTask: true };
  await runSettings(host);
  expect(await readFile(config, "utf8")).toBe("reasoning_headline: false\n");
  expect((await host.context())!.reasoningHeadline).toBe(false);
  await runSettings(fakeHost(home, project, ["Reasoning headline", "Turn it on", "Done"]));
  expect(await valueOf(home, project, "Reasoning headline")).toBe("on");
  await writeFile(config, "reasoning_headline: maybe\n");
  await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("reasoning_headline must be on or off");
  await writeFile(config, "reasoning_headline: off\n");
  await writeFile(projectFile, "reasoning_headline: on\n");
  await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("reasoning_headline is a user setting");
});
