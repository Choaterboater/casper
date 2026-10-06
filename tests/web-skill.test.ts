import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectModel } from "../src/project/model";
import { MAX_BUNDLED_BODY_BYTES, scoreWebSkill, STOP_AND_ASK_LINE, webSkills } from "../src/skills/bundled";
import { formatSelectedSkills, SkillRegistry } from "../src/skills/registry";
import { classifyTask } from "../src/task/classify";
import { removeTempDir } from "./support/temp-dir";

/** The bundled frontend skill: picked only for UI work in a project with no look of its own yet. */

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => removeTempDir(dir))); });

function model(architecture: Record<string, string> = {}, frameworks: string[] = [], languages = ["typescript"]): ProjectModel {
  return {
    schemaVersion: 1, project: { name: "example", root: "/example", git: false },
    languages, frameworks, packageManager: "bun",
    commands: {}, architecture, conventions: [], detectedAt: "2026-01-01T00:00:00.000Z",
  } as ProjectModel;
}

async function registry(): Promise<SkillRegistry> {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-web-skill-"));
  temporary.push(base);
  await mkdir(path.join(base, "home"));
  await mkdir(path.join(base, "project"));
  return SkillRegistry.discover({ homeDir: path.join(base, "home"), projectRoot: path.join(base, "project"), bundled: true });
}

const picked = async (prompt: string, project = model()) =>
  (await (await registry()).loadForTask(prompt, project, classifyTask(prompt))).map(({ skill }) => skill.name);

test("the skill is small, in Casper's own words, and covers the agreed topics", () => {
  const [skill] = webSkills();
  expect(skill!.metadata.name).toBe("web-frontend");
  expect(skill!.path).toBe("skills/web/frontend/SKILL.md");
  expect(Buffer.byteLength(skill!.body)).toBeLessThanOrEqual(MAX_BUNDLED_BODY_BYTES);
  for (const topic of ["type scale", "spacing", "<label", "focus", "44", "390px", "4.5:1", "empty", "error", "alt", "lang",
    "purple", "emoji", "card", "lorem", "repo's style always wins"]) expect(skill!.body).toContain(topic);
});

test("UI work in a project with no design yet picks it", async () => {
  // Plain web words pick it in any project, even an empty one.
  for (const prompt of ["build a landing page with a signup form", "style the navbar and buttons", "create a web app to track my lab gear",
    "add a dark mode to the website", "change the look and feel of the html report"]) {
    expect({ prompt, picked: await picked(prompt) }).toEqual({ prompt, picked: ["web-frontend"] });
  }
  // Words that also mean other things (page, form, layout, header, design …) count only in a web project.
  const web = model({}, ["react", "vite"]);
  for (const prompt of ["add a settings page", "make the layout work on a phone", "add a header with the logo", "design the signup form"]) {
    expect({ prompt, picked: await picked(prompt, web) }).toEqual({ prompt, picked: ["web-frontend"] });
  }
});

test("network, script and report work in a project that isn't a web app doesn't pick it", async () => {
  const projects = [model({}, [], ["python"]), model({}, ["mistapi"], ["python"]), model(), model({}, [], [])];
  for (const prompt of ["add a header row to the CSV report", "make the script look up each AP's site name",
    "fix the paging so it fetches all pages from the Mist API", "add a form field to the Ansible inventory",
    "design a VLAN plan and write the playbook", "change the style of the log output", "add a menu to the CLI",
    "show the results on screen as a table", "add a theme option to the config", "split the parser into components"]) {
    for (const project of projects) {
      expect({ prompt, frameworks: project.frameworks, picked: (await picked(prompt, project)).includes("web-frontend") })
        .toEqual({ prompt, frameworks: project.frameworks, picked: false });
    }
  }
});

test("the repo's own look wins: styles, components, a design folder or a styling package keep it out", async () => {
  const prompt = "build a landing page with a signup form";
  expect(await picked(prompt, model({ styles: "src/theme.css" }))).toEqual([]);
  expect(await picked(prompt, model({ ui: "src/components" }))).toEqual([]);
  expect(await picked(prompt, model({ design: "design" }))).toEqual([]);
  expect(await picked(prompt, model({}, ["react", "tailwind"]))).toEqual([]);
});

test("questions and non-UI work don't pick it", async () => {
  for (const prompt of ["what does the settings page do?", "list APs per site in Mist", "fix the central logging config",
    "add a retry to the API client", "write tests for the parser"]) {
    expect({ prompt, picked: (await picked(prompt)).includes("web-frontend") }).toEqual({ prompt, picked: false });
  }
  expect(scoreWebSkill("explain the page layout", model(), classifyTask("explain the page layout"))).toBe(0);
});

test("a web skill never brings the network stop-and-ask line, and a user's own web-frontend replaces it", async () => {
  const prompt = "build a landing page with a signup form";
  const loaded = await (await registry()).loadForTask(prompt, model(), classifyTask(prompt));
  const text = formatSelectedSkills(loaded);
  expect(text).toContain("--- Skill web-frontend@bundled ---");
  expect(text).not.toContain("stop and ask");
  expect(text).not.toContain(STOP_AND_ASK_LINE);

  const base = await mkdtemp(path.join(os.tmpdir(), "casper-web-skill-own-"));
  temporary.push(base);
  const own = path.join(base, "home/.casper/skills/web-frontend");
  await mkdir(own, { recursive: true });
  await mkdir(path.join(base, "project"));
  await writeFile(path.join(own, "SKILL.md"), "---\nname: web-frontend\ndescription: Our house style.\n---\nUse our house style.\n");
  const mine = await SkillRegistry.discover({ homeDir: path.join(base, "home"), projectRoot: path.join(base, "project"), bundled: true });
  const chosen = await mine.loadForTask(prompt, model(), classifyTask(prompt));
  expect(chosen.map(({ skill, body }) => [skill.source, body.trim()])).toEqual([["user", "Use our house style."]]);
});
