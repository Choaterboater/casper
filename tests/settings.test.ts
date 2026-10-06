import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { editUserConfig } from "../src/config/user-write";
import { runSettings, settingRows, type SettingsHost } from "../src/app/settings";
import { posixOnly } from "./support/platform";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function place() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-settings-")); roots.push(root);
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(project);
  return { home, project, config: path.join(home, ".casper", "config.yaml") };
}

posixOnly("editUserConfig keeps comments and other settings, replaces the one value, and makes a private file", async () => {
  const { home, config } = await place();
  await editUserConfig(home, ["display"], "detailed");
  expect(await readFile(config, "utf8")).toBe("display: detailed\n");
  expect((await stat(config)).mode & 0o777).toBe(0o600);
  await writeFile(config, "# mine\nweb:\n  provider: brave # my key\ndisplay: quiet\n");
  await editUserConfig(home, ["web", "enabled"], false);
  await editUserConfig(home, ["display"], "normal");
  expect(await readFile(config, "utf8")).toBe("# mine\nweb:\n  provider: brave # my key\n  enabled: false\ndisplay: normal\n");
  await writeFile(config, "display: [broken\n");
  await expect(editUserConfig(home, ["display"], "quiet")).rejects.toThrow("does not parse");
});

test("Playwright tests: off writes verification.e2e: false, and the found e2e check goes away", async () => {
  const { home, project, config } = await place();
  await writeFile(config, "verification:\n  e2e: false\n");
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  const row = settingRows(context).find((entry) => entry.label === "Playwright tests")!;
  expect(row.value).toBe("off");
  expect(row.choices.map((choice) => [choice.label, choice.keys, choice.value])).toEqual([["Turn them on", ["verification", "e2e"], true]]);
});

test("the settings list shows each switch and where it stands", async () => {
  const { home, project, config } = await place();
  await writeFile(config, "web: off\nupdates: false\nspend:\n  pauseAt: 5\n");
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  expect(settingRows(context).map((row) => `${row.label}: ${row.value}`)).toEqual([
    "Web lookups: off", "New-version notice: off", "Built-in skills: on", "Spend notes: at $1 a task", "Spend pause: at $5 a task", "Show the AI the pages: ask once a session",
    "Work shown: normal", "Untrusted-text reader: on", "Playwright tests: on",
  ]);
  expect(settingRows(context).at(-1)!.question).toBe("Casper runs a project's own Playwright tests (the e2e check) after each change, once they are installed. They are on.");
  const questions = settingRows(context).map((row) => row.question);
  expect(questions[3]).toStartWith("Spend notes come at $1 a task. ");
  expect(questions[4]).toStartWith("Spend pause comes at $5 a task. ");
  await writeFile(config, "spend:\n  noteAt: false\n  pauseAt: false\n");
  const off = settingRows(await loadProjectContext(await inspectProject(project), { homeDir: home })).map((row) => row.question);
  expect(off[3]).toStartWith("Spend notes are off. ");
  expect(off[4]).toStartWith("Spend pause is off. ");
});

function fakeHost(home: string, project: string, answers: string[]): SettingsHost & { text: () => string; asked: string[] } {
  let text = "";
  const asked: string[] = [];
  let context: Awaited<ReturnType<typeof loadProjectContext>> | undefined;
  return {
    output: { write: (chunk: string) => { text += chunk; } },
    homeDir: () => home,
    canAsk: true,
    context: async () => context ??= await loadProjectContext(await inspectProject(project), { homeDir: home }),
    reload: async () => { context = await loadProjectContext(await inspectProject(project), { homeDir: home }); },
    ask: async (question, options) => { asked.push(`${question}\n${options.map((option, index) => `${index + 1} ${option.label}`).join("\n")}`); return answers.shift(); },
    text: () => text, asked,
  };
}

test("/settings: 1 is Done, a pick asks with 1 Keep first, and the answer is saved for you", async () => {
  const { home, project, config } = await place();
  const host = fakeHost(home, project, ["Web lookups", "Turn them off", "Spend pause", "$5 a task", "Done"]);
  await runSettings(host);
  expect(host.asked[0]!.split("\n").slice(1, 3)).toEqual(["1 Done", "2 Web lookups"]);
  expect(host.asked[1]).toBe("Web lookups are on (DuckDuckGo).\n1 Keep them on\n2 Turn them off");
  expect(host.asked[3]).toStartWith("Spend pause is off. ");
  expect(host.asked[3]!.split("\n")[1]).toBe("1 Keep it off");
  expect(host.text()).toContain("[settings] Web lookups: off. Saved in ~/.casper/config.yaml.\n");
  expect(host.text()).toContain("[settings] Spend pause: at $5 a task. Saved in ~/.casper/config.yaml.\n");
  const saved = await readFile(config, "utf8");
  expect(saved).toContain("web: false");
  expect(saved).toContain("pauseAt: 5");
  // The list asked again after each change shows the new value.
  expect(host.asked[2]).toContain("2 Web lookups");
  expect((await host.context())!.web?.enabled).toBe(false);
});

test("/settings: showing the AI the pages is ask, always or never, saved as showPages", async () => {
  const { home, project, config } = await place();
  const host = fakeHost(home, project, ["Show the AI the pages", "Never show them", "Done"]);
  await runSettings(host);
  expect(host.asked[1]!.split("\n").slice(1)).toEqual(["1 Keep ask once a session", "2 Always show them", "3 Never show them"]);
  expect(await readFile(config, "utf8")).toBe("showPages: off\n");
  expect((await host.context())!.showPages).toBe("off");
  // A project can't turn it on at your cost.
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper", "project.yaml"), "showPages: on\n");
  await expect(loadProjectContext(await inspectProject(project), { homeDir: home })).rejects.toThrow("showPages is a user setting");
});

test("/settings: Keep and Esc change nothing", async () => {
  const { home, project, config } = await place();
  const host = fakeHost(home, project, ["Built-in skills", "Keep them on", undefined as never]);
  await runSettings(host);
  await expect(stat(config)).rejects.toThrow();
  expect(host.text()).toBe("");
});

test("/settings where Casper can't ask lists the settings and says how to change one", async () => {
  const { home, project } = await place();
  let output = "";
  const app = new CasperApp({ output: { write: (text) => { output += text; } }, runtimeFactory() { throw new Error("No model expected"); }, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }) });
  try {
    await app.runOnce("/settings", project);
    expect(output).toContain("Web lookups");
    expect(output).toContain("on (DuckDuckGo)");
    expect(output).toContain("Run /settings in a Casper session to change one by number.");
  } finally { await app.close(); }
});

test("/details <level> is remembered like /effort; --session keeps it to this session", async () => {
  const { home, project, config } = await place();
  let output = "";
  const app = new CasperApp({ output: { write: (text) => { output += text; } }, runtimeFactory() { throw new Error("No model expected"); }, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }) });
  try {
    await app.runOnce("/details detailed", project);
    expect(await readFile(config, "utf8")).toBe("display: detailed\n");
    expect(output).toContain("[details] detailed: every step, with a small diff under each edit. Saved; /details <level> --session changes only this session.\n");
    output = "";
    await app.runOnce("/details quiet --session", project);
    expect(await readFile(config, "utf8")).toBe("display: detailed\n");
    expect(output).toContain("[details] quiet: the model's words, failures and receipts. For this session only.\n");
  } finally { await app.close(); }
});
