import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectModel } from "../src/project/model";
import { MAX_BUNDLED_BODY_BYTES, scoreWebSkill, STOP_AND_ASK_LINE, webSkills } from "../src/skills/bundled";
import { formatSelectedSkills, SkillRegistry } from "../src/skills/registry";
import { classifyTask } from "../src/task/classify";
import { removeTempDir } from "./support/temp-dir";

/** The bundled web skills: web-frontend (a look) is picked only for UI work in a project with no look of its own yet;
 * web-quality (the checks every page needs) for UI work in any project. */

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

test("the two skills are small and between them cover the agreed topics", () => {
  const [frontend, quality] = webSkills();
  expect(webSkills().map(({ metadata, path }) => [metadata.name, path])).toEqual([
    ["web-frontend", "skills/web/frontend/SKILL.md"], ["web-quality", "skills/web/quality/SKILL.md"]]);
  for (const skill of webSkills()) expect(Buffer.byteLength(skill.body)).toBeLessThanOrEqual(MAX_BUNDLED_BODY_BYTES);
  const both = `${frontend!.body}\n${quality!.body}`;
  for (const topic of ["type scale", "spacing", "<label", "focus", "44", "390px", "4.5:1", "empty", "error", "alt", "lang",
    "purple", "emoji", "card", "lorem", "repo's style always wins"]) expect(both).toContain(topic);
  expect(frontend!.body).toContain("web-quality skill");
});

test("web-quality refuses the machine-made signs and lists checkable rules, without theme advice", () => {
  const quality = webSkills()[1]!;
  const body = quality.body;
  expect(quality.files).toEqual({});
  const headings = body.split("\n").filter((line) => line.startsWith("## "));
  expect(headings).toEqual(["## When to use", "## Refuse", "## Verify", "## Forms", "## Structure and states", "## Check it"]);
  for (const line of ["eyebrow", "01 / 02 / 03", "border over 1px", "box-shadow: 4px 4px 0", "monospace", "terracotta", "acid green",
    "gradient text", "cards inside cards", "1px border under a wide soft shadow", "`transition: all`", "gray text on a coloured background",
  ]) expect(body).toContain(line);
  for (const line of ["65 to 75 characters", "more space above a heading than below", "user-scalable=no", "16px text or larger",
    "`autocomplete`", "`inputmode`", "Never block paste", "move focus to the first field with an error", "The URL holds",
    "`transform` and `opacity`", "44 by 44px", "4.5:1", ":focus-visible"]) expect(body).toContain(line);
  // The look stays the project's: no type scale, palette or font advice.
  for (const line of ["Pick a small system", "type scale", "font pair", "theme.css", "illustration-kit"]) expect(body).not.toContain(line);
  expect(body).toContain("Keep the\nproject's colours, fonts, spacing and components");
  // Credit for the borrowed text, with the Apache note that it was changed.
  for (const line of ["pbakaus/impeccable (Apache-2.0, Copyright 2025 Paul Bakaus)", "anthropics/skills frontend-design (Apache-2.0, Anthropic, PBC)",
    "vercel-labs/web-interface-guidelines\n(MIT, Copyright (c) 2025 Vercel Labs)", "jakubkrehel/make-interfaces-feel-better (MIT, Copyright (c)\n2026 Jakub Krehel)",
    "Changed: shortened and rewritten for Casper."]) expect(body).toContain(line);
});

test("the skill asks for a chosen look: fonts that suit the product, a page shape, own image and action per item, aligned cards", () => {
  const [skill] = webSkills();
  const body = skill!.body;
  expect(body).not.toContain("Use the system font stack unless");
  for (const line of ["heading and body font pair", "never Inter alone", "system stack as the fallback", "corner radius that fits",
    "the page's shape before writing code", "off-center hero", "uneven tile grid", "one reading column", "split screen",
    "its own image", "its own action", "Never reuse one image with a different label", "stock or CDN images you have not checked",
    "flex: 1", "margin-top: auto", "more than one column"]) expect(body).toContain(line);
});

test("the skill tells icons from illustrations: icons follow dark mode, illustrations read the kit and build lit, layered art", () => {
  const body = webSkills()[0]!.body;
  for (const line of ["## Drawing SVG", "Icons (small UI glyphs)", "currentColor", "aria-hidden", "Illustrations (hero, product, about art)",
    "illustration-kit.svg", "back to front", "top-left", "side face", "top face", "cast shadow", 'role="img"', "<title>", "<desc>",
    "viewBox", "no fixed size", "make_picture"]) expect(body).toContain(line);
  // The rules that pushed art toward flat clip-art are gone.
  for (const line of ["one simple motif", "no text inside", "a few clean shapes"]) expect(body).not.toContain(line);
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_BUNDLED_BODY_BYTES);
});

test("the skill keeps the phone header to one row with a Menu button and builds only what the brief asks", () => {
  const body = webSkills()[0]!.body;
  for (const line of ["At 390px the header stays one row", "Menu button", "aria-expanded", "Escape", "Extra header items go in the menu",
    "Build what the brief asks", "a cart or basket, accounts", "search", "links to the contact section"]) expect(body).toContain(line);
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_BUNDLED_BODY_BYTES);
});

/** A strict enough XML check for the kit: every tag is closed in order, attributes are quoted, nothing is left over. */
function xmlElements(text: string): Array<{ name: string; attributes: Record<string, string> }> {
  const elements: Array<{ name: string; attributes: Record<string, string> }> = [];
  const open: string[] = [];
  const rest = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g, (_, close: string, name: string, attributes: string, self: string) => {
    if (close) { expect(open.pop()).toBe(name); return ""; }
    const pairs: Record<string, string> = {};
    for (const [, key, value] of attributes.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      expect(pairs[key!]).toBeUndefined();
      pairs[key!] = value!;
    }
    elements.push({ name, attributes: pairs });
    if (!self) open.push(name);
    return "";
  });
  expect(open).toEqual([]);
  // Only the title and description text is left; no stray markup.
  expect(rest).not.toMatch(/[<>]/);
  return elements;
}

test("the illustration kit is valid SVG with unique ids, the listed materials, shadows and textures, each with a comment", () => {
  const kit = webSkills()[0]!.files["illustration-kit.svg"]!;
  expect(kit.length).toBeLessThan(8 * 1024);
  const elements = xmlElements(kit);
  expect(elements[0]!.name).toBe("svg");
  expect(elements[0]!.attributes).toMatchObject({ xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 240 120" });
  const ids = elements.flatMap(({ attributes }) => attributes.id ? [attributes.id] : []);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ["steel", "chrome", "walnut", "light-wood", "ceramic", "glass", "paint", "enamel", "fabric", "paper", "stone",
    "contact-shadow", "cast-shadow", "glow", "sheen", "brushed", "grain"]) {
    expect(ids).toContain(id);
    // A one-line comment says what each one is for, right above it.
    expect(kit).toMatch(new RegExp(`<!-- [^\\n]+ -->\\n<[a-zA-Z]+ id="${id}"`));
  }
  const byId = new Map(elements.filter(({ attributes }) => attributes.id).map((element) => [element.attributes.id!, element]));
  expect(byId.get("contact-shadow")!.name).toBe("filter");
  expect(byId.get("cast-shadow")!.name).toBe("filter");
  expect(elements.filter(({ name }) => name === "feGaussianBlur").length).toBeGreaterThanOrEqual(3);
  // Steel and chrome are 7-stop bands of light and dark.
  for (const id of ["steel", "chrome"]) expect(kit.split(`id="${id}"`)[1]!.split("</linearGradient>")[0]!.match(/<stop /g)).toHaveLength(7);
  expect(kit).toContain("change only the hue");
  // Every url(#…) its shapes use is defined in it.
  for (const [, used] of kit.matchAll(/="url\(#([\w-]+)\)"/g)) expect(ids).toContain(used!);
});

test("the kit is never in the prompt: the skill names it, and its folder is given only when the skill is picked", async () => {
  const body = webSkills()[0]!.body;
  expect(body).not.toContain("<linearGradient");
  const prompt = "build a landing page with a hero illustration";
  const loaded = await (await registry()).loadForTask(prompt, model(), classifyTask(prompt));
  const text = formatSelectedSkills(loaded);
  expect(text).not.toContain("<linearGradient");
  const folder = /^Base directory: (.+)$/m.exec(text)?.[1];
  expect(folder).toBeDefined();
  expect(await readFile(path.join(folder!, "illustration-kit.svg"), "utf8")).toBe(webSkills()[0]!.files["illustration-kit.svg"]!);
  if (process.platform !== "win32") expect((await stat(folder!)).mode & 0o077).toBe(0);
});

test("UI work in a project with no design yet picks it", async () => {
  // Plain web words pick it in any project, even an empty one.
  for (const prompt of ["build a landing page with a signup form", "style the navbar and buttons", "create a web app to track my lab gear",
    "add a dark mode to the website", "change the look and feel of the html report"]) {
    expect({ prompt, picked: await picked(prompt) }).toEqual({ prompt, picked: ["web-frontend", "web-quality"] });
  }
  // Words that also mean other things (page, form, layout, header, design …) count only in a web project.
  const web = model({}, ["react", "vite"]);
  for (const prompt of ["add a settings page", "make the layout work on a phone", "add a header with the logo", "design the signup form"]) {
    expect({ prompt, picked: await picked(prompt, web) }).toEqual({ prompt, picked: ["web-frontend", "web-quality"] });
  }
});

test("network, script and report work in a project that isn't a web app doesn't pick it", async () => {
  const projects = [model({}, [], ["python"]), model({}, ["mistapi"], ["python"]), model(), model({}, [], [])];
  for (const prompt of ["add a header row to the CSV report", "make the script look up each AP's site name",
    "fix the paging so it fetches all pages from the Mist API", "add a form field to the Ansible inventory",
    "design a VLAN plan and write the playbook", "change the style of the log output", "add a menu to the CLI",
    "show the results on screen as a table", "add a theme option to the config", "split the parser into components"]) {
    for (const project of projects) {
      expect({ prompt, frameworks: project.frameworks, picked: (await picked(prompt, project)).filter((name) => name.startsWith("web-")) })
        .toEqual({ prompt, frameworks: project.frameworks, picked: [] });
    }
  }
});

test("the repo's own look wins: styles, components, a design folder or a styling package keep the theme advice out, not the checks", async () => {
  const prompt = "build a landing page with a signup form";
  for (const project of [model({ styles: "src/theme.css" }), model({ ui: "src/components" }), model({ design: "design" }),
    model({}, ["react", "tailwind"]), model({}, ["next", "styled-components"])]) {
    expect(await picked(prompt, project)).toEqual(["web-quality"]);
    const loaded = await (await registry()).loadForTask(prompt, project, classifyTask(prompt));
    const text = formatSelectedSkills(loaded);
    expect(text).toContain("## Verify");
    expect(text).toContain("## Refuse");
    expect(text).not.toContain("Pick a small system");
    expect(text).not.toContain("type scale");
    // web-quality ships no files, so no folder is made for it.
    expect(text).not.toContain("Base directory:");
  }
  // In a Tailwind React app the words with other meanings count too.
  const tailwind = model({ styles: "tailwind.config.ts" }, ["react", "vite", "tailwind"]);
  for (const prompt of ["add a settings page", "make the layout work on a phone", "design the signup form"]) {
    expect({ prompt, picked: await picked(prompt, tailwind) }).toEqual({ prompt, picked: ["web-quality"] });
  }
  expect(scoreWebSkill(prompt, tailwind, classifyTask(prompt))).toBe(0);
  expect(scoreWebSkill(prompt, tailwind, classifyTask(prompt), true)).toBe(6);
});

test("the checks follow the same word rules as the theme advice in a project with a look", async () => {
  const styled = (frameworks: string[] = [], languages = ["typescript"]) => model({ styles: "src/index.css" }, frameworks, languages);
  for (const prompt of ["add a header row to the CSV report", "fetch all pages from the Mist API", "change the style of the log output",
    "split the parser into components", "what does the settings page do?"]) {
    for (const project of [styled(), styled([], ["python"])]) {
      expect({ prompt, picked: (await picked(prompt, project)).filter((name) => name.startsWith("web-")) }).toEqual({ prompt, picked: [] });
    }
  }
});

test("questions and non-UI work don't pick it", async () => {
  for (const prompt of ["what does the settings page do?", "list APs per site in Mist", "fix the central logging config",
    "add a retry to the API client", "write tests for the parser"]) {
    expect({ prompt, picked: (await picked(prompt)).filter((name) => name.startsWith("web-")) }).toEqual({ prompt, picked: [] });
  }
  expect(scoreWebSkill("explain the page layout", model(), classifyTask("explain the page layout"))).toBe(0);
  expect(scoreWebSkill("explain the page layout", model({ styles: "src/index.css" }), classifyTask("explain the page layout"), true)).toBe(0);
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
  // Your house style replaces the look; the checks still come.
  expect(chosen.map(({ skill, body }) => [skill.source, skill.name, skill.source === "user" ? body.trim() : ""])).toEqual([
    ["user", "web-frontend", "Use our house style."], ["bundled", "web-quality", ""]]);
});

test("the notices credit the four projects web-quality borrows from, and say the text was changed", async () => {
  const notices = await Bun.file(new URL("../THIRD_PARTY_NOTICES.txt", import.meta.url)).text();
  const entry = notices.split("Frontend design guidance — the web-quality skill text")[1]!.split("\n=====")[0]!;
  for (const line of ["https://github.com/pbakaus/impeccable", "https://github.com/anthropics/skills, skills/frontend-design",
    "https://github.com/vercel-labs/web-interface-guidelines", "https://github.com/jakubkrehel/make-interfaces-feel-better",
    "Copyright 2025 Paul Bakaus", "Copyright Anthropic, PBC", "Copyright (c) 2025 Vercel Labs", "Copyright (c) 2026 Jakub Krehel",
    "Changes: the text was shortened", "reference/ios.md"]) expect(entry).toContain(line);
});
