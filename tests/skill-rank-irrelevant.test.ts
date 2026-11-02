import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectModel } from "../src/project/model";
import { SkillRegistry } from "../src/skills/registry";
import { classifyTask } from "../src/task/classify";
import { removeTempDir } from "./support/temp-dir";

/** From a real session with about 37 skills from other tools' folders: "what is pac mcp" (a question) picked mcp-builder on
 * the one word "mcp" of its name, and a slow-laptop question about Mist picked web-design-guidelines on "my" and "check"
 * ("review my UI", "check accessibility"). The descriptions are the kind those skills ship with. */
const SKILLS: Record<string, string> = {
  "mcp-builder": "Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. Use when building MCP servers to integrate external APIs or services, whether in Python (FastMCP) or Node/TypeScript (MCP SDK).",
  "web-design-guidelines": "Review UI code for Web Interface Guidelines compliance. Use when asked to \"review my UI\", \"check accessibility\", \"audit design\", \"review UX\", or \"check my site against best practices\".",
  "frontend-design": "Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications.",
  "webapp-testing": "Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser logs.",
  "chrome-browser": "Drive your own Chrome browser: open pages, click, fill forms and read what a page shows, signed in as you.",
  "built-in-browser": "Use the built-in browser to open a page, see what it shows, and check a local web app while you build it.",
  "diagnosing-bugs": "Diagnosis loop for hard bugs and performance regressions. Use when the user says \"diagnose\"/\"debug this\", or reports something broken/throwing/failing/slow.",
  "agentfinder": "Discover installable MCP servers, tools, skills, and agents for a task by searching an agent finder. Use whenever the user wants to find or install a tool, MCP server, skill, agent, or integration.",
  "skill-creator": "Guide for creating effective skills. Use when users want to create a new skill (or update an existing skill) that extends the agent's capabilities.",
  "simrack": "SimRack runbook for vJunos sandboxes on Proxmox. Use for SimRack deploys, lab builds, rebuilds, teardowns and lab troubleshooting.",
  "xlsx": "Use for any spreadsheet file: open, read, edit, create or fix data in a workbook, with formulas and charts.",
};

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => removeTempDir(directory))); });

const model = { schemaVersion: 1, project: { name: "example", root: "/example", git: false }, languages: [], frameworks: [], packageManager: null,
  commands: {}, architecture: {}, conventions: [], detectedAt: "2026-01-01T00:00:00.000Z" } as unknown as ProjectModel;

async function registry(): Promise<SkillRegistry> {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-skill-irrelevant-"));
  temporary.push(base);
  const homeDir = path.join(base, "home"), projectRoot = path.join(base, "project");
  await mkdir(projectRoot, { recursive: true });
  for (const [name, description] of Object.entries(SKILLS)) {
    const folder = path.join(homeDir, ".claude", "skills", name);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\nBody\n`);
  }
  return SkillRegistry.discover({ homeDir, projectRoot, bundled: true });
}

const picked = async (skills: SkillRegistry, request: string) =>
  (await skills.loadForTask(request, model, classifyTask(request))).map(({ skill }) => skill.name).sort();

test("a question about what something is, and a slow-laptop question about Mist, pick no unrelated skill", async () => {
  const skills = await registry();
  expect(await picked(skills, "what is pac mcp")).toEqual([]);
  const mist = await picked(skills, "can you check mist and see why my laptop is slow and phoen its only doing like 140 down");
  expect(mist.filter((name) => name !== "network-mist-api")).toEqual([]);
  const earlier = await picked(skills, "using the network mcp on mist network lab org home-net why my mac laptop wifi so slow");
  expect(earlier.filter((name) => name !== "network-mist-api")).toEqual([]);
});

test("a request that is about one of those skills still picks it", async () => {
  const skills = await registry();
  expect(await picked(skills, "build an mcp server for our ticket api in python")).toContain("mcp-builder");
  expect(await picked(skills, "use the mcp builder for this")).toContain("mcp-builder");
  expect(await picked(skills, "review my UI for accessibility")).toContain("web-design-guidelines");
  expect(await picked(skills, "audit the design of my site against best practices")).toContain("web-design-guidelines");
  expect(await picked(skills, "debug this: the import is slow since the last change, a performance regression")).toContain("diagnosing-bugs");
  expect(await picked(skills, "rebuild the simrack lab")).toEqual(["simrack"]);
});
