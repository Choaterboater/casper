import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CasperApp } from "../src/app";
import { autoModeRequest, judgeForApp, noteJudgeStep } from "../src/app/auto-mode";
import { loadConfiguration } from "../src/config/load";
import { settingRows } from "../src/app/settings";
import { TaskObservations } from "../src/task/observations";
import { loadProjectContext, type ProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** Just the parts of the app auto mode reads, with a side call that answers `text`. */
function fakeApp(options: { autoMode?: boolean; trusted?: boolean; interactive?: boolean; complete?: boolean; text?: string } = {}) {
  const asked: Array<{ user: string; effort?: string }> = [];
  const app = {
    projectContext: { autoMode: options.autoMode } as Partial<ProjectContext>,
    interactive: options.interactive ?? true,
    folderTrust: options.trusted === false ? { trusted: false, why: "new" } : { trusted: true, from: "/p" },
    commandActive: true,
    lastTaskRequest: "add a cart page",
    steeredInTask: ["and a checkout button"],
    judgeSteps: [] as string[],
    observations: new TaskObservations(),
    session: options.complete === false ? {} : {
      complete: async (input: { user: string; effort?: string }) => { asked.push(input); return { text: options.text ?? '{"verdict":"allow","reason":"builds the app"}', usage: { tokens: 90, estimatedCost: 0.0002 } }; },
    },
  };
  return { app: app as unknown as CasperApp, raw: app, asked };
}

test("the judge runs only when auto mode is on, someone can answer, the folder is trusted and a side call can be made", async () => {
  for (const [label, options] of [["auto mode off", { autoMode: false }], ["untrusted folder", { trusted: false }], ["a run that can't ask", { interactive: false }],
    ["no side call", { complete: false }]] as const) {
    const { app, asked } = fakeApp(options);
    expect({ label, result: await judgeForApp(app, "make serve") }).toEqual({ label, result: undefined });
    expect(asked).toEqual([]);
  }
  const { app, asked, raw } = fakeApp();
  expect(await judgeForApp(app, "make serve")).toMatchObject({ verdict: "allow", reason: "builds the app" });
  expect(asked[0]!.effort).toBe("low");
  // The request as it stands, lines typed during the task included; and the judge's tokens join the task's.
  expect(asked[0]!.user).toContain("add a cart page");
  expect(asked[0]!.user).toContain("- and a checkout button");
  expect(raw.observations.spent().tokens).toBe(90);
});

test("the judge sees the task's steps: edited files and commands run, newest last, at most eight", async () => {
  const { app, raw, asked } = fakeApp();
  noteJudgeStep(app, { type: "tool_start", toolName: "edit", input: { path: "package.json" } });
  noteJudgeStep(app, { type: "tool_start", toolName: "read", input: { path: "README.md" } });
  noteJudgeStep(app, { type: "tool_start", toolName: "bash", input: { command: "npm test" } });
  expect(raw.judgeSteps).toEqual(["edited package.json", "ran npm test"]);
  await judgeForApp(app, "npm install");
  expect(asked[0]!.user).toContain("Recent steps this task, oldest first:\n- edited package.json\n- ran npm test");
  for (let i = 0; i < 12; i++) noteJudgeStep(app, { type: "tool_start", toolName: "bash", input: { command: `step ${i}` } });
  expect(raw.judgeSteps).toHaveLength(8);
  expect(raw.judgeSteps.at(-1)).toBe("ran step 11");
});

test("auto mode on and off in plain words, as a whole short typed line; anything else goes to the AI", () => {
  for (const [line, expected] of [["auto mode off", "off"], ["Auto mode on", "on"], ["turn off auto mode", "off"], ["please turn auto-mode on.", "on"],
    ["automode off", "off"]] as const) expect({ line, request: autoModeRequest(line) }).toEqual({ line, request: expected });
  for (const line of ["what is auto mode", "add an auto mode off switch to the settings page", "auto mode", "auto mode off\nand fix the bug"])
    expect({ line, request: autoModeRequest(line) }).toEqual({ line, request: undefined });
  expect(autoModeRequest("auto mode off", ["auto mode off"])).toBeUndefined();
});

test("auto_mode is your own setting: on unless your config turns it off, never in a project file; /settings has its row", async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-auto-mode-config-")));
  cleanup.push(() => removeTempDir(base));
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  const load = () => loadConfiguration({ projectRoot: project, homeDir: home });
  expect((await load()).autoMode).toBeUndefined();
  await writeFile(path.join(home, ".casper", "config.yaml"), "auto_mode: off\n");
  expect(await load()).toMatchObject({ autoMode: false });
  const row = settingRows(await loadProjectContext(await inspectProject(project), { homeDir: home })).find(row => row.label === "Auto mode");
  expect(row?.value).toBe("off");
  expect(row?.choices[0]?.label).toBe("Turn it on");
  expect(row?.question).toContain("It never refuses on its own, and if it fails it asks.");
  await writeFile(path.join(project, ".casper", "project.yaml"), "auto_mode: on\n");
  await expect(load()).rejects.toThrow("auto_mode is a user setting");
});

test("the docs say what auto mode does and how to turn it off", async () => {
  const read = async (file: string) => (await readFile(new URL(`../${file}`, import.meta.url), "utf8")).replace(/\s+/g, " ");
  const decision = await read("docs/adr/0002/47-auto-mode-judge.md");
  for (const heading of ["# 47. Auto mode", "**What:**", "**Why:**", "**Guard rails:**", "**A finding:**"]) expect(decision).toContain(heading);
  expect(await read("docs/SECURITY.md")).toContain("**Auto mode.** With the sandbox off, in a folder you trust");
  expect(await read("docs/CONFIGURATION.md")).toContain("`auto_mode: off`");
  expect(await read("docs/TERMINAL_UX.md")).toContain("`✓ judge: runs the project's tests`");
  // The fixed list that never reaches the judge is named, and the real cost of a check.
  for (const file of ["docs/SECURITY.md", "docs/adr/0002/47-auto-mode-judge.md"]) {
    expect(await read(file)).toContain("src/sandbox/always-asks.ts");
    expect(await read(file)).toContain("a download run through a shell or interpreter");
  }
  expect(decision).toContain("input 2, output 52, cache 2,508");
});
