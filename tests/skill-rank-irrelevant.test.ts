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
  "find-skills": "Helps users discover and install agent skills when they ask questions like \"how do I do X\", \"find a skill for X\", \"is there a skill that can...\", or express interest in extending capabilities. This skill should be used when the user is looking for functionality that might exist as an installable skill.",
  "archify": "Create polished, validated architecture, workflow, sequence, data-flow, and lifecycle/state diagrams as explorable standalone HTML with inline SVG, dark/light themes, optional trace motion, and PNG/JPEG/WebP/SVG/WebM export. Accept plain-language requirements or pasted Mermaid flowchart, sequenceDiagram, and stateDiagram input; inspect repository evidence when the diagram must reflect real code. Use when the user asks to visualize system architecture, infrastructure, cloud/security/network topology, technical workflows, API call sequences, request lifecycles, data pipelines, ETL/ELT, data lineage, state machines, or to convert/beautify Mermaid.",
  "hpe-customer-deck": "HPE customer decks (PowerPoint) in the HPE Networking house style or the official HPE Light and Dark templates. Use to build a new customer presentation from notes or customer documents, restyle an existing .pptx into the house style, or review a deck before it goes to a customer.",
  "code-review": "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to \"review since X\".",
  "docx": "Comprehensive document creation, editing, and analysis with support for tracked changes, comments, formatting preservation, and text extraction. When Claude needs to work with professional documents (.docx files) for: (1) Creating new documents, (2) Modifying or editing content, (3) Working with tracked changes, (4) Adding comments, or any other document tasks",
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

test("one word of a skill's name, or a word any request uses, doesn't pick it: a network session's requests pick neither mcp-builder nor docx", async () => {
  // From a real session with the network MCP: adding a second Central login, testing it, and asking about recent changes.
  const skills = await registry();
  for (const request of ["add another mcp central server to network mcp - for temp use", "test temp mcp", "fix the temp mcp login",
    "when were the last changes to make sure i know which one he was working", "they recently added a ap and said it got it online but not working"]) {
    const unrelated = (await picked(skills, request)).filter((name) => name === "mcp-builder" || name === "docx");
    expect({ request, unrelated }).toEqual({ request, unrelated: [] });
  }
  // A request about documents still picks docx.
  expect(await picked(skills, "accept the tracked changes and comments in the report docx")).toContain("docx");
});

test("two generic words of a long description, or a name that is one word plus 'skills', pick nothing: a network quote session picks none of these", async () => {
  // From a real v0.4.12 session (quoting HPE switches through MCP servers).
  const skills = await registry();
  for (const request of [
    "you can also use the network mcp or other mcp and desksigns as well as hpe skills  until we get it better and accurate and faster for future use - rag is on the hpe networking mcp which can find some of the data as well",
    "cx6200 s witches 48 port  list out two tables fixed and module",
  ]) {
    const unrelated = (await picked(skills, request)).filter((name) => ["find-skills", "archify", "hpe-customer-deck", "mcp-builder", "code-review"].includes(name));
    expect({ request, unrelated }).toEqual({ request, unrelated: [] });
  }
  // Requests about them still pick them.
  expect(await picked(skills, "find skills for terraform")).toContain("find-skills");
  expect(await picked(skills, "draw an architecture diagram of the network topology as a data-flow")).toContain("archify");
  expect(await picked(skills, "build an hpe customer deck from these notes")).toContain("hpe-customer-deck");
  expect(await picked(skills, "review the changes on this branch against our coding standards")).toContain("code-review");
});
