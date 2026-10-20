import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { savePlan, readPlan, recentPlans, updatePlan, planQuestions, wantsSpec } from "../src/flows/plan-store";
import { PlanBuild } from "../src/flows/plan-build";
import { formatShortReceipt, formatTaskResult } from "../src/task/result";
import { editPlanFile } from "../src/tui/plan-editor";
import { removeTempDir } from "./support/temp-dir";

const plan = { title: "A board", goal: ["Find a task"], steps: ["Add the board", "Test it"], tests: ["the board loads"] };

test("saved Markdown is unique, round-trips all sections and request, revisions stay in the same file, recent order is newest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-plan-state-"));
  try {
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    const request = 'add a board\nwith "quotes"';
    const one = await savePlan(root, request, plan);
    const two = await savePlan(root, request, plan);
    expect(two.file).not.toBe(one.file);
    expect(spawnSync("git", ["-C", root, "check-ignore", "--quiet", ".casper/plans/" + path.basename(one.file)]).status).toBe(0);
    expect(spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).stdout).toBe("");
    expect((await readPlan(root, one.file))).toEqual(one);
    const revised = { ...one, plan: { ...plan, goal: ["Revised goal"], found: ["src/app.ts exists"], openQuestions: ["Which team?"] } };
    await updatePlan(root, revised);
    expect((await recentPlans(root))[0]).toEqual(revised);
    expect((await recentPlans(root))).toHaveLength(2);
    expect(await readFile(one.file, "utf8")).toContain("Done means:");
    await writeFile(one.file, "Goal: manual file\nScreens: board\nFirst version: add tasks\nDone means: board loads\n");
    const manual = await readPlan(root, one.file);
    expect(manual.request).toBe("manual file");
    expect(manual.plan.screens).toEqual(["board"]);
  } finally { await removeTempDir(root); }
});

test("plan state refuses a symlinked folder or file outside the project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-plan-links-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "casper-plan-outside-"));
  try {
    await symlink(outside, path.join(root, ".casper"), process.platform === "win32" ? "junction" : "dir");
    await expect(savePlan(root, "board", plan)).rejects.toThrow("leaves the project");
    const separate = path.join(outside, "separate"); await mkdir(separate);
    const saved = await savePlan(separate, "board", plan);
    const file = path.join(separate, ".casper/plans/2000-01-01-link.md");
    await symlink(saved.file, file, "file");
    await expect(readPlan(separate, file)).rejects.toThrow("Not a saved plan");
  } finally { await removeTempDir(root); await removeTempDir(outside); }
});

test("only empty projects or app/site/game creation request spec guidance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-plan-spec-"));
  try {
    expect(await wantsSpec(root, "add a board")).toBe(true);
    await mkdir(path.join(root, ".casper"));
    expect(await wantsSpec(root, "add a board")).toBe(true);
    await writeFile(path.join(root, "app.ts"), "export {};");
    expect(await wantsSpec(root, "fix the header")).toBe(false);
    for (const kind of ["app", "site", "game", "application", "website"]) expect(await wantsSpec(root, `make an ${kind}`)).toBe(true);
  } finally { await removeTempDir(root); }
});

test("question answer format enforces 1–3 questions with 2–4 options", () => {
  const question = { question: "Which screen?", options: [{ label: "Board" }, { label: "List" }] };
  for (const count of [1, 2, 3]) expect(planQuestions(JSON.stringify({ questions: Array(count).fill(question) }))).toHaveLength(count);
  for (const count of [0, 4]) expect(planQuestions(JSON.stringify({ questions: Array(count).fill(question) }))).toBeUndefined();
  for (const count of [0, 1, 5]) expect(planQuestions(JSON.stringify({ questions: [{ ...question, options: Array(count).fill({ label: "Board" }) }] }))).toBeUndefined();
  for (const count of [2, 3, 4]) expect(planQuestions(JSON.stringify({ questions: [{ ...question, options: Array(count).fill({ label: "Board" }) }] }))).toHaveLength(1);
  for (const text of ["not json", "null", '{"questions":[{}]}', '{"questions":[{"question":"","options":[]}]}']) expect(planQuestions(text)).toBeUndefined();
});

const unreportedSteps = () => new PlanBuild(plan, () => {}).finish("completed");

test("checklist progress reports done/not done and never treats an unreported or stopped step as done", async () => {
  const lines: (string | undefined)[] = [];
  const build = new PlanBuild(plan, line => lines.push(line));
  expect(lines[0]).toBe("Step 1 of 2 · Add the board");
  expect((await build.tool().execute({ step: 1, status: "done" })).isError).toBeUndefined();
  expect(lines.at(-1)).toBe("Step 2 of 2 · Test it");
  expect((await build.tool().execute({ step: 2, status: "not-done" })).isError).toBe(true);
  expect((await build.tool().execute({ step: 99, status: "done" })).isError).toBe(true);
  const steps = build.finish("cancelled");
  expect(steps).toEqual([{ title: "Add the board", status: "done" }, { title: "Test it", status: "not-done", reason: "build cancelled" }]);
  expect((await build.tool().execute({ step: 2, status: "done" })).isError).toBe(true);
  // /receipt lists every step; the screen after the task says the plan in one line, with the reason a step stopped.
  const full = formatTaskResult({ execution: "cancelled", planSteps: steps });
  expect(full).toContain("model report, not verification");
  expect(full).toContain("Add the board — done");
  expect(full).toContain("Test it — not done: build cancelled");
  const short = formatShortReceipt({ execution: "cancelled", planSteps: steps });
  expect(short).toContain("– Plan: 1 of 2 steps done (model report) — build cancelled; /receipt lists them");
  expect(short).not.toContain("Add the board — done");
  expect(formatShortReceipt({ execution: "completed", planSteps: unreportedSteps() })).toContain("– Plan: 0 of 2 steps done (model report); /receipt lists them");
  expect(formatShortReceipt({ execution: "completed", planSteps: steps.map(step => ({ ...step, status: "done" as const })) })).toContain("✓ Plan: all 2 steps done (model report)");
  const unreported = unreportedSteps();
  expect(unreported.every(step => step.status === "not-done" && step.reason === "not reported done by the model")).toBe(true);
  const spec = new PlanBuild({ steps: [], tests: [], firstVersion: ["- Add tasks", "- Save tasks"] }, () => {});
  expect(spec.steps.map(step => step.title)).toEqual(["Add tasks", "Save tasks"]);
});

// A plan for a Home Assistant prompt: its First version had an intro line, four bold sub-headings and nested bullets,
// and became 39 steps ("*MyQ garage opening**" among them); the finished prompt's receipt said "1 of 39 steps done".
test("a First version with sub-headings gives one step per heading; nested bullets are details, not steps", () => {
  const firstVersion = [
    "Deliver one researched, copy-ready prompt requiring the following.",
    "**Dashboard and app functionality**",
    "- Preserve working features in `build_dashboards.py`.",
    "- Cover every configured app:",
    "  - **Media:** Emby, Plex.",
    "  - **Automation:** Sonarr, Radarr.",
    "**MyQ garage opening**",
    "- Trigger from a physical opening.",
    "**“Alex is home!” announcement**",
    "- Require **more than 60 minutes** away.",
  ];
  expect(new PlanBuild({ steps: [], tests: [], firstVersion }, () => {}).steps.map(step => step.title))
    .toEqual(["Dashboard and app functionality", "MyQ garage opening", "“Alex is home!” announcement"]);
  // No headings: top-level bullets only; nested ones stay with their parent.
  expect(new PlanBuild({ steps: [], tests: [], firstVersion: ["- Board view", "  - drag and drop", "- **Save** tasks"] }, () => {}).steps.map(step => step.title))
    .toEqual(["Board view", "Save tasks"]);
  // Plain prose lines with no list still give steps.
  expect(new PlanBuild({ steps: [], tests: [], firstVersion: ["Create, edit and move a task."] }, () => {}).steps.map(step => step.title))
    .toEqual(["Create, edit and move a task."]);
});

test("VISUAL/EDITOR Markdown edit round-trip, missing editor and nonzero exit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-plan-editor-"));
  const visual = process.env.VISUAL, editor = process.env.EDITOR;
  try {
    const saved = await savePlan(root, "board", plan);
    const script = path.join(root, "editor.ts");
    await writeFile(script, 'await Bun.write(process.argv[2]!, "Title: Hand edited\\nSteps:\\n1. Add a calendar\\nDone means: the calendar loads\\n");');
    process.env.VISUAL = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    process.env.EDITOR = "this-editor-should-not-run";
    await editPlanFile(saved.file);
    expect((await readPlan(root, saved.file)).plan.steps).toEqual(["Add a calendar"]);
    process.env.EDITOR = process.env.VISUAL; delete process.env.VISUAL;
    await editPlanFile(saved.file);
    expect((await readPlan(root, saved.file)).plan.title).toBe("Hand edited");
    await writeFile(script, "process.exit(7)");
    await expect(editPlanFile(saved.file)).rejects.toThrow("exited with 7");
    delete process.env.EDITOR;
    await expect(editPlanFile(saved.file)).rejects.toThrow("Set VISUAL or EDITOR");
  } finally {
    if (visual === undefined) delete process.env.VISUAL; else process.env.VISUAL = visual;
    if (editor === undefined) delete process.env.EDITOR; else process.env.EDITOR = editor;
    await removeTempDir(root);
  }
});
