import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { askBuildRequest, newProjectFromQuestions, type NewProjectFlow } from "../src/app/new-project";
import { parseNewArgs } from "../src/new/command";
import { formatNewProjectReceipt } from "../src/new/receipt";
import { createProject, type NewProjectOptions, type NewProjectResult } from "../src/new/scaffold";
import { makeNewFakes, type NewFakes } from "./support/new-fakes";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

/**
 * "What are you building?" asks the kind first (Network, MCP server, Web app or dashboard, Python tool, My own),
 * then which one when a kind has more than one, with Back first. My own is an empty folder with git.
 */

let fakes: NewFakes | undefined;
let home: string | undefined;
afterEach(async () => {
  await fakes?.cleanup(); fakes = undefined;
  if (home) await removeTempDir(home); home = undefined;
});

/** A flow that answers each question from `answers` in turn (by label), and records what it was asked. */
async function scripted(answers: Array<string | undefined>) {
  home = await mkdtemp(path.join(os.tmpdir(), "casper-new-kinds-"));
  const asked: Array<{ question: string; labels: string[] }> = [];
  const created: NewProjectOptions[] = [];
  const flow: NewProjectFlow = {
    homeDir: home,
    write: () => {},
    pick: async (question, options) => {
      asked.push({ question, labels: options.map((option) => option.label) });
      const answer = answers.shift();
      return answer === "" ? options[0]?.label : answer;
    },
    create: async (options) => {
      created.push(options);
      return { status: "ready", exitCode: 0, dir: path.join(options.parent, options.name), displayDir: options.name, name: options.name, checks: [], notes: [], kept: [] } satisfies NewProjectResult;
    },
  };
  return { flow, asked, created };
}

test("casper new <name> asks nothing and makes an empty project of that name", async () => {
  const s = await scripted([]);
  const result = await newProjectFromQuestions(s.flow, { name: "lab-notes" });
  expect(s.asked).toEqual([]);
  expect(s.created.map(({ template, name }) => ({ template, name }))).toEqual([{ template: "empty", name: "lab-notes" }]);
  expect(result?.status).toBe("ready");
});

test("casper new <name> when that folder exists opens it, with no question and nothing built; a taken default moves to the next free name", async () => {
  const s = await scripted([]);
  const projects = path.join(s.flow.homeDir, "Projects");
  await mkdir(path.join(projects, "sglang"), { recursive: true });
  await writeFile(path.join(projects, "sglang", "notes.md"), "mine\n");
  const opened = await newProjectFromQuestions(s.flow, { name: "sglang" });
  expect(s.asked).toEqual([]);
  expect(s.created).toEqual([]);
  expect(opened?.dir).toBe(path.join(projects, "sglang"));
  await mkdir(path.join(projects, "my-project"), { recursive: true });
  await writeFile(path.join(projects, "my-project", "x"), "x");
  await newProjectFromQuestions(s.flow, {});
  expect(s.asked).toEqual([]);
  expect(s.created.map(({ name }) => name)).toEqual(["my-project-2"]);
});

test("no name: the first free default name, no question; a named template still builds that template", async () => {
  const unnamed = await scripted([]);
  await newProjectFromQuestions(unnamed.flow, {});
  expect(unnamed.asked).toEqual([]);
  expect(unnamed.created.map(({ template }) => template)).toEqual(["empty"]);
  const chosen = await scripted([]);
  await newProjectFromQuestions(chosen.flow, { template: "web-app", name: "inventory" });
  expect(chosen.asked).toEqual([]);
  expect(chosen.created.map(({ template, name }) => ({ template, name }))).toEqual([{ template: "web-app", name: "inventory" }]);
});

test("My own at a build request makes an empty project named from the request", async () => {
  const s = await scripted(["Other kind", "My own", ""]);
  const answer = await askBuildRequest(s.flow, "build a tool that lists Mist APs per site");
  expect(s.asked[1]!.labels).toEqual(["Use this folder", "My own", "Network", "MCP server", "Web app or dashboard", "Python tool"]);
  expect(s.asked[2]!.question).toBe("Name it? (Enter for mist-aps)");
  expect(s.created.map(({ template, name }) => ({ template, name }))).toEqual([{ template: "empty", name: "mist-aps" }]);
  expect(answer).toHaveProperty("result");
});

test("casper new empty <name> is the command-line way", () => {
  expect(parseNewArgs(["empty", "lab-notes"])).toEqual({ template: "empty", name: "lab-notes", list: false });
});

posixOnly("My own: an empty folder with git, no template, no packages, no commit", async () => {
  fakes = await makeNewFakes();
  const result = await createProject({ parent: fakes.parent, name: "lab-notes", template: "empty", env: fakes.env(), homeDir: fakes.home });
  const dir = path.join(fakes.parent, "lab-notes");
  expect(result.status).toBe("ready");
  expect(result.empty).toBe(true);
  expect(result.template).toBeUndefined();
  expect(await readdir(dir)).toEqual([".git"]);
  expect((await fakes.calls()).join("\n")).not.toMatch(/\b(uv|bun) (init|add)\b/);
  expect(formatNewProjectReceipt(result)).toEqual([
    "Ready: ~/Projects/lab-notes · empty folder · git started · no template",
    "Next: tell Casper what to build, or run: casper ~/Projects/lab-notes",
  ]);
});

posixOnly("My own inside someone's repository: no second git", async () => {
  fakes = await makeNewFakes();
  execFileSync("git", ["init", "-q", fakes.parent], { env: fakes.env() });
  const result = await createProject({ parent: fakes.parent, name: "inner", template: "empty", env: fakes.env(), homeDir: fakes.home });
  expect(result.status).toBe("ready");
  expect(await lstat(path.join(fakes.parent, "inner/.git")).then(() => true, () => false)).toBe(false);
  expect(formatNewProjectReceipt(result)[0]).toBe("Ready: ~/Projects/inner · empty folder · no template");
});

test("Enter at What are you building? picks My own (anything you describe), not Network", async () => {
  const s = await scripted(["", ""]);
  await newProjectFromQuestions(s.flow, {});
  expect(s.created.map(({ template }) => template)).toEqual(["empty"]);
});
