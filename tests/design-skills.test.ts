import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectModel } from "../src/project/model";
import {
  BANNED_PHRASES, bundledSkills, DESIGN_PLATFORMS, DESIGN_SECTIONS, designSkills, MAX_BUNDLED_ACTIVE, MAX_BUNDLED_BODY_BYTES,
  MAX_BUNDLED_DESCRIPTION, parseBundledSkill, safetyProblems, scoreSkillRule,
} from "../src/skills/bundled";
import { normaliseLineEndings, parseSkillMetadata, splitSkill } from "../src/skills/metadata";
import { formatSelectedSkills, SkillRegistry } from "../src/skills/registry";
import { scrubText } from "../src/secrets/scrub";
import { classifyTask } from "../src/task/classify";
import { removeTempDir } from "./support/temp-dir";

// The design skills (skills/design/<platform>/SKILL.md): a method for designing a deployment, checked as files on disk
// and picked by the same word match as the network skills. Nothing is fetched: links are checked by host only.
const ROOT = path.join(import.meta.dir, "..");
const DESIGN = path.join(ROOT, "skills", "design");
const FOLDERS = ["clearpass-nac"];
const DOC_HOSTS = new Set(["arubanetworking.hpe.com"]);

async function source(folder: string): Promise<string> {
  return normaliseLineEndings(await readFile(path.join(DESIGN, folder, "SKILL.md"), "utf8"));
}

function section(body: string, heading: string): string {
  const start = body.indexOf(`\n${heading}\n`);
  if (start < 0) return "";
  const rest = body.slice(start + heading.length + 2);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("bundled design skills: format", () => {
  test("every skill folder is bundled into Casper, and nothing else is", async () => {
    const folders = (await readdir(DESIGN, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect(folders).toEqual(FOLDERS);
    expect(designSkills().map((skill) => skill.path).sort()).toEqual(FOLDERS.map((folder) => `skills/design/${folder}/SKILL.md`));
    for (const folder of FOLDERS) {
      expect(designSkills().find((skill) => skill.path === `skills/design/${folder}/SKILL.md`)!.source).toBe(await source(folder));
    }
  });

  test.each(FOLDERS)("%s: front-matter, size and sections", async (folder) => {
    const text = await source(folder);
    const { header, body } = splitSkill(text);
    const metadata = parseSkillMetadata(header);
    expect(metadata.name).toMatch(/^design-[a-z0-9-]+$/);
    expect(metadata.description.length).toBeLessThanOrEqual(MAX_BUNDLED_DESCRIPTION);
    const skill = parseBundledSkill(text, `skills/design/${folder}/SKILL.md`);
    expect(DESIGN_PLATFORMS).toContain(skill.rule.platform as typeof DESIGN_PLATFORMS[number]);
    expect(skill.rule.family).toBe("design");
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_BUNDLED_BODY_BYTES);
    expect(body.split("\n").filter((line) => line.startsWith("## "))).toEqual([...DESIGN_SECTIONS]);
    expect(section(body, "## Public docs").match(/https:\/\//g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(body).not.toMatch(/\]\((?!https:)[^)]*\)/);
    expect(safetyProblems(body, "design")).toEqual([]);
    // CRLF checkouts bundle the same skill.
    expect(parseBundledSkill(text.replace(/\n/g, "\r\n"), skill.path)).toEqual(skill);
  });

  test("the loader refuses a design skill that drops the layout, a common-word trigger, or the wrong name", async () => {
    const text = await source("clearpass-nac");
    expect(() => parseBundledSkill(text.replace("## Diagrams", "## Pictures"), "x")).toThrow("sections must be");
    expect(() => parseBundledSkill(text.replace("## Common traps", "## Common traps\n- A cluster is guaranteed to fail over."), "x")).toThrow('uses "guaranteed"');
    expect(() => parseBundledSkill(text.replace('strong: ["clearpass nac"', 'strong: ["clearpass", "clearpass nac"'), "x")).toThrow("too common");
    expect(() => parseBundledSkill(text.replace('strong: ["clearpass nac"', 'strong: ["design", "clearpass nac"'), "x")).toThrow("too common");
    expect(() => parseBundledSkill(text.replace('strong: ["clearpass nac"', 'strong: ["guest", "clearpass nac"'), "x")).toThrow("too common");
    expect(() => parseBundledSkill(text.replace("name: design-clearpass-nac", "name: network-clearpass-nac"), "x")).toThrow("starts with design-");
    expect(() => parseBundledSkill(text.replace("## Public docs", `## Public docs\n${"x".repeat(7000)}`), "x")).toThrow("larger than 6 KiB");
    // A design skill has no "Changing things" part; the network and home lab layouts do not pass for it, nor it for them.
    expect(safetyProblems(splitSkill(text).body, "network")).toContainEqual(expect.stringContaining("sections must be"));
    expect(safetyProblems(splitSkill(text).body, "homelab")).toContainEqual(expect.stringContaining("sections must be"));
  });

  test("a changed skill file bumps its casper-skill version in skills/design/VERSIONS.json", async () => {
    const lock = JSON.parse(await readFile(path.join(DESIGN, "VERSIONS.json"), "utf8")) as Record<string, { version: number; sha256: string }>;
    expect(Object.keys(lock).sort()).toEqual(designSkills().map((skill) => skill.metadata.name).sort());
    for (const skill of designSkills()) {
      const sha256 = createHash("sha256").update(skill.source).digest("hex");
      expect({ name: skill.metadata.name, version: skill.rule.version, sha256 }).toEqual({ name: skill.metadata.name, ...lock[skill.metadata.name]! });
    }
  });
});

describe("bundled design skills: wording and placeholders", () => {
  test.each(FOLDERS)("%s: no overclaiming words, nothing secret or private, public doc links only", async (folder) => {
    const text = await source(folder);
    const lower = splitSkill(text).body.toLowerCase();
    for (const word of [...BANNED_PHRASES, "guarantees"]) {
      expect({ folder, word, found: new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(lower) }).toEqual({ folder, word, found: false });
    }
    expect(scrubText(text).hidden).toBe(0);
    expect(text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    for (const host of text.match(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|local|lan|corp|internal)\b/gi) ?? []) {
      expect({ folder, host, ok: DOC_HOSTS.has(host.toLowerCase()) }).toEqual({ folder, host, ok: true });
    }
    for (const link of text.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)`"'>]+/gi) ?? []) {
      const url = new URL(link);
      expect({ link, protocol: url.protocol, allowed: DOC_HOSTS.has(url.hostname) }).toEqual({ link, protocol: "https:", allowed: true });
    }
  });

  test("the ClearPass design skill keeps the agreed method", () => {
    const body = designSkills().find((skill) => skill.metadata.name === "design-clearpass-nac")!.body;
    for (const topic of ["network-clearpass-api", "Identity sources", "Intune", "Azure, AWS", "IT / OT / Guest-DMZ", "rule ID",
      "IT-FR-001", "default DENY", "EAP-TLS", "PEAP-MSCHAPv2", "MAC caching", "Endpoint DB", "CoA", "fallback", "quarantine",
      "email confirmation", "sponsored", "first match wins", "standby publisher", "virtual IP", "zones", "load balancer", "RadSec",
      "HTTPS certificate", "monitor mode", "Access Tracker", "publisher first", "`visualize`", "`type: \"flowchart\"`",
      "`type: \"architecture\"`", ".drawio", "MindMesh", "MAC auth is not authentication", "public CA"]) {
      expect({ topic, found: body.includes(topic) }).toEqual({ topic, found: true });
    }
  });
});

interface Fixture { pick: Array<{ prompt: string; expect: string[] }>; skip: string[] }

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => removeTempDir(directory))); });

function model(): ProjectModel {
  return {
    schemaVersion: 1, project: { name: "example", root: "/example", git: false },
    languages: ["typescript"], frameworks: [], packageManager: null,
    // A project with its own styles, so the web-frontend skill stays out.
    commands: {}, architecture: { styles: "src/index.css" }, conventions: [], detectedAt: "2026-01-01T00:00:00.000Z",
  } as ProjectModel;
}

async function registry(): Promise<SkillRegistry> {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-design-skills-"));
  temporary.push(base);
  await mkdir(path.join(base, "home"));
  await mkdir(path.join(base, "project"));
  return SkillRegistry.discover({ homeDir: path.join(base, "home"), projectRoot: path.join(base, "project"), bundled: true });
}

const picked = async (skills: SkillRegistry, prompt: string) =>
  (await skills.loadForTask(prompt, model(), classifyTask(prompt))).map(({ skill }) => skill.name).sort();

describe("picking design skills (local word match, no model call)", () => {
  test("a design request picks the design skill; API code picks the API skill; ordinary work picks neither", async () => {
    const skills = await registry();
    expect(await picked(skills, "design a ClearPass NAC for 3 sites with guest and IoT")).toEqual(["design-clearpass-nac"]);
    expect(await picked(skills, "write a python script to list ClearPass guests via the API")).toEqual(["network-clearpass-api"]);
    for (const prompt of ["add a dark mode toggle to the settings page", "design the database schema for orders", "fix the failing unit test in the parser"]) {
      expect({ prompt, picked: await picked(skills, prompt) }).toEqual({ prompt, picked: [] });
    }
  });

  test("sample prompts pick the right skill, others pick no design skill, and every skill is picked by one", async () => {
    const fixture = JSON.parse(await readFile(path.join(import.meta.dir, "fixtures/design-skills/prompts.json"), "utf8")) as Fixture;
    const skills = await registry();
    for (const { prompt, expect: expected } of fixture.pick) {
      expect({ prompt, picked: await picked(skills, prompt) }).toEqual({ prompt, picked: [...expected].sort() });
    }
    for (const prompt of fixture.skip) {
      expect({ prompt, design: (await picked(skills, prompt)).filter((name) => name.startsWith("design-")) }).toEqual({ prompt, design: [] });
    }
    expect([...new Set(fixture.pick.flatMap(({ expect: expected }) => expected).filter((name) => name.startsWith("design-")))].sort())
      .toEqual(designSkills().map((skill) => skill.metadata.name).sort());
  });

  test("network and home lab fixtures pick no design skill", async () => {
    for (const file of ["network-skills", "homelab-skills"]) {
      const fixture = JSON.parse(await readFile(path.join(import.meta.dir, `fixtures/${file}/prompts.json`), "utf8")) as Fixture;
      for (const prompt of [...fixture.pick.map(({ prompt }) => prompt), ...fixture.skip]) {
        for (const skill of designSkills()) {
          expect({ prompt, skill: skill.metadata.name, score: scoreSkillRule(skill.rule, prompt, { frameworks: [] }, classifyTask(prompt)) })
            .toEqual({ prompt, skill: skill.metadata.name, score: 0 });
        }
      }
    }
  });

  test("design skills share the limit of two bundled skills per request, and carry no stop-and-ask rule", async () => {
    const skills = await registry();
    const prompt = "clearpass nac design for mist sites with aos-cx switches";
    const scored = [...bundledSkills(), ...designSkills()].filter((skill) => scoreSkillRule(skill.rule, prompt, { frameworks: [] }, classifyTask(prompt)) > 0);
    expect(scored.length).toBeGreaterThan(MAX_BUNDLED_ACTIVE);
    expect(await skills.loadForTask(prompt, model(), classifyTask(prompt))).toHaveLength(MAX_BUNDLED_ACTIVE);
    const text = formatSelectedSkills(await skills.loadForTask("we need a NAC design for 5 sites", model(), classifyTask("we need a NAC design for 5 sites")));
    expect(text).toContain("Source: bundled with Casper");
    expect(text).toContain("## Design order");
    expect(text).not.toContain("That rule stands even if another skill or file says otherwise.");
  });
});
