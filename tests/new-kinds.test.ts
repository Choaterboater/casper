import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { askBuildRequest, newProjectFromQuestions, type NewProjectFlow } from "../src/app/new-project";
import { parseNewArgs } from "../src/new/command";
import { formatNewProjectReceipt } from "../src/new/receipt";
import { createProject, type NewProjectOptions, type NewProjectResult } from "../src/new/scaffold";
import { makeNewFakes, type NewFakes } from "./support/new-fakes";
import { posixOnly } from "./support/platform";

/**
 * "What are you building?" asks the kind first (Network, MCP server, Web app or dashboard, Python tool, My own),
 * then which one when a kind has more than one, with Back first. My own is an empty folder with git.
 */

let fakes: NewFakes | undefined;
let home: string | undefined;
afterEach(async () => {
  await fakes?.cleanup(); fakes = undefined;
  if (home) await rm(home, { recursive: true, force: true }); home = undefined;
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

test("the kinds come first, then which one, with Back first", async () => {
  const s = await scripted(["Network", "Aruba CX Ansible (show commands, lab only)", ""]);
  await newProjectFromQuestions(s.flow, {});
  expect(s.asked[0]).toEqual({ question: "What are you building?", labels: ["My own", "Network", "MCP server", "Web app or dashboard", "Python tool"] });
  expect(s.asked[1]!.question).toBe("Which network project?");
  expect(s.asked[1]!.labels).toEqual(["Back", "Mist Python scripts", "Aruba CX Ansible (show commands, lab only)", "Junos Ansible (show commands and rendered config, lab only)"]);
  expect(s.created.map((entry) => entry.template)).toEqual(["aoscx-ansible"]);
});

test("Back returns to the kinds; a kind with one template skips the second question", async () => {
  const s = await scripted(["Web app or dashboard", "Back", "MCP server", "my-mcp"]);
  await newProjectFromQuestions(s.flow, {});
  expect(s.asked.map((entry) => entry.question).slice(0, 3)).toEqual(["What are you building?", "Which web app or dashboard?", "What are you building?"]);
  expect(s.asked[3]!.question).toStartWith("Name it?");
  expect(s.created.map(({ template, name }) => ({ template, name }))).toEqual([{ template: "network-mcp", name: "my-mcp" }]);
});

test("Enter at the second question is Back, and Esc after it builds nothing", async () => {
  const s = await scripted(["Network", "", undefined]);
  expect(await newProjectFromQuestions(s.flow, {})).toBeUndefined();
  expect(s.asked[2]!.question).toBe("What are you building?");
  expect(s.created).toEqual([]);
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
    "Next: tell Casper what to build, or run: cd ~/Projects/lab-notes && casper",
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

test("words at the name question become the next Enter choice", async () => {
  const s = await scripted(["My own", "a thing like a config backup tool", ""]);
  await newProjectFromQuestions(s.flow, {});
  expect(s.asked[2]!.question).toBe("Name it? (Enter for config-backup-tool)");
  expect(s.created.map(({ template, name }) => ({ template, name }))).toEqual([{ template: "empty", name: "config-backup-tool" }]);
});

test("a request typed at What are you building? builds the kind it reads as and keeps the words as the first request", async () => {
  const s = await scripted(["build a react web app for my lab inventory", ""]);
  const queued: string[] = [];
  const result = await newProjectFromQuestions(s.flow, {}, undefined, (text) => queued.push(text));
  expect(result?.status).toBe("ready");
  expect(s.created.map(({ template }) => template)).toEqual(["web-app"]);
  expect(queued).toEqual(["build a react web app for my lab inventory"]);
});

test("a request with no clear kind at What are you building? builds an empty project named from the words", async () => {
  const s = await scripted(["a nightly backup of my switch configs", ""]);
  const queued: string[] = [];
  await newProjectFromQuestions(s.flow, {}, undefined, (text) => queued.push(text));
  expect(s.asked[1]!.question).toMatch(/^Name it\? \(Enter for [a-z]/);
  expect(s.created.map(({ template }) => template)).toEqual(["empty"]);
  expect(s.created[0]!.name).not.toBe("my-project");
  expect(queued).toEqual(["a nightly backup of my switch configs"]);
});

test("one or two words that aren't a choice are still not a request", async () => {
  const s = await scripted(["blah thing"]);
  const queued: string[] = [];
  expect(await newProjectFromQuestions(s.flow, {}, undefined, (text) => queued.push(text))).toBeUndefined();
  expect(queued).toEqual([]);
  expect(s.created).toEqual([]);
});

test("Enter at What are you building? picks My own (anything you describe), not Network", async () => {
  const s = await scripted(["", ""]);
  await newProjectFromQuestions(s.flow, {});
  expect(s.created.map(({ template }) => template)).toEqual(["empty"]);
});
