import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { discoverMCPConfiguration } from "../src/mcp/config";
import { loadProjectContext } from "../src/project/context";
import type { ProjectModel } from "../src/project/model";
import type { AgentRuntime, RuntimeEventListener, RuntimeSession, RuntimeStartOptions } from "../src/runtime/types";
import { SkillRegistry, skillRegistryOptions } from "../src/skills/registry";
import { classifyTask } from "../src/task/classify";
import { removeTempDir } from "./support/temp-dir";

/** From a live test in an app that runs Casper over ACP, with the skills from other tools' folders on a Mac:
 * a bug fix picked deep-research, "in one line, what did I answer" picked google-workspace and prototype, and a question
 * about a mentioned chat picked six skills on the words of that chat. These are the descriptions those skills ship with. */
const SKILLS: Record<string, string> = {
  "deep-research": "Use this skill when the user's prompt requires (1) researching a topic across multiple sources, comparing options or alternatives, analyzing trends or history, understanding markets or industries, or reviewing literature or studies and (2) synthesizing that research into a comprehensive, narrative report. If you're planning to search the web or internal knowledge bases, consider using this skill. This skill coordinates research subagents, so use it only when you have a tool for spawning subagents (the Agent or Task tool); otherwise, research the question directly.",
  "google-workspace": "Read this before the first Google Drive, Docs, Sheets or Slides connector call whenever the task creates or changes a Google file. Use this skill whenever the user wants to create or change a Google Doc, Sheet or Slides file in their Google Drive. Triggers include: a request that names Google Docs, Sheets, Slides or Drive and asks to make, edit, format, copy or rename a file; a docs.google.com link with a request to change that file, even a one-line fix or suggested edits; and any follow-up change to a Google file from earlier in the chat, even \"change it\" or \"add a tab\". Includes helper scripts for document positions, cell ranges and slide layout. However, if the user asks for a doc, deck or spreadsheet without naming Google, or gives a Google file only as source material for something new, use Claude's own output type instead. Do NOT use for read-only questions about a Google file, or for Word, Excel, PowerPoint or PDF files.",
  "prototype": "Build a throwaway prototype to answer a design question. Use when the user wants to sanity-check whether a state model or logic feels right, or explore what a UI should look like.",
  "research": "Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.",
  "built-in-browser": "Read this skill before the first step that uses the built-in browser, the browser pane inside the desktop app (also called the in-app browser or the browser pane), whose tools are named mcp__Browser__* when the session runs in the desktop app; before those tools are turned on there may be a single enable tool instead. It covers the pane's persistent sign-ins, tabs and preview_start, reading pages as text, site approvals, what the pane cannot open, and what to do when it cannot be reached.",
  "computer-use": "Read this skill before the first step of any request to do something in an app on the person's own computer (Notes, Finder, System Settings, any desktop app), to look at their screen, or for \"computer use\". Computer use (desktop control) takes screenshots of the person's desktop and controls it with clicks, typing and scrolling; its tools are named mcp__computer-use__* when the session runs in the desktop app; before computer use is turned on for a conversation there may be no such tools, only an enable tool, which turns it on.",
  "mcp-builder": "Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. Use when building MCP servers to integrate external APIs or services, whether in Python (FastMCP) or Node/TypeScript (MCP SDK).",
  "tdd": "Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions \"red-green-refactor\", or wants integration tests.",
  "modernize-tests": "Modernize an old test suite: move it to the current test runner and replace deprecated assertions.",
  "dispatching-parallel-agents": "Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies",
  "schedule": "Create, update, list, or run scheduled cloud agents (routines) that execute on a cron schedule. - When the user wants to schedule a recurring cloud agent, set up automated tasks, create a cron job for the agent, or manage their scheduled agents/routines.",
  "migrate-to-shoehorn": "Migrate test files from `as` type assertions to @total-typescript/shoehorn. Use when user mentions shoehorn, wants to replace `as` in tests, or needs partial test data.",
};

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => removeTempDir(directory))); });

const model = { schemaVersion: 1, project: { name: "example", root: "/example", git: false }, languages: ["javascript"], frameworks: [],
  packageManager: "npm", commands: {}, architecture: {}, conventions: [], detectedAt: "2026-01-01T00:00:00.000Z" } as unknown as ProjectModel;

async function folders() {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-skill-fit-"));
  temporary.push(base);
  const homeDir = path.join(base, "home"), projectRoot = path.join(base, "project");
  await mkdir(path.join(homeDir, ".casper"), { recursive: true });
  await mkdir(path.join(projectRoot, ".casper"), { recursive: true });
  for (const [name, description] of Object.entries(SKILLS)) {
    const folder = path.join(homeDir, ".claude", "skills", name);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\nBody of ${name}\n`);
  }
  return { homeDir, projectRoot };
}

async function registry(): Promise<SkillRegistry> {
  const { homeDir, projectRoot } = await folders();
  return SkillRegistry.discover({ homeDir, projectRoot, bundled: true });
}

const picked = async (skills: SkillRegistry, request: string) =>
  (await skills.loadForTask(request, model, classifyTask(request))).map(({ skill }) => skill.name).sort();

test("the live test's requests pick no skill: a bug fix, a one-line question, counting tests and questions about a chat", async () => {
  const skills = await registry();
  for (const request of [
    "Before you change anything, use your ask tool to ask me one multiple-choice question: should sum also return 0 for an empty list? Options: Yes, No. Then fix sum.js so npm test passes.",
    "In one line: what did I answer to your question earlier?",
    "count the tests in sum.test.js without running them",
    "@Before you change anything, ask  what did that chat change? Then count the tests in sum.test.js without running them.",
    "@Before you change anything, use  Without running anything: which functions did that chat add, and what does max do for an empty list? One line.",
    "Without running anything: list the tools you can use in this session, names only.",
  ]) expect({ request, picked: await picked(skills, request) }).toEqual({ request, picked: [] });
});

test("a request about one of those skills still picks it", async () => {
  const skills = await registry();
  expect(await picked(skills, "fix the typo in the title of my Google Doc https://docs.google.com/document/d/abc/edit")).toContain("google-workspace");
  expect(await picked(skills, "add a tab to the Google Sheet with this month's numbers")).toContain("google-workspace");
  expect(await picked(skills, "research the web for the best Rust web frameworks and compare them")).toContain("deep-research");
  expect(await picked(skills, "research the market and write a narrative report")).toContain("deep-research");
  expect(await picked(skills, "build a throwaway prototype of the settings page")).toContain("prototype");
  expect(await picked(skills, "write integration tests test-first, red-green-refactor")).toContain("tdd");
  expect(await picked(skills, "replace the as assertions in tests with shoehorn")).toContain("migrate-to-shoehorn");
  expect(await picked(skills, "build an mcp server for our ticket api in python")).toContain("mcp-builder");
  expect(await picked(skills, "take a screenshot of my desktop with computer use")).toContain("computer-use");
});

test("the plural of a word of any request still counts: only words about the exchange lose theirs", async () => {
  const skills = await registry();
  // "task" says nothing about a topic, but "tasks" is the word these two skills share with the request.
  expect(await picked(skills, "work on two independent tasks")).toContain("dispatching-parallel-agents");
  expect(await picked(skills, "show my scheduled tasks")).toContain("schedule");
});

class Runtime implements AgentRuntime {
  readonly prompts: string[] = [];
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    const listeners = new Set<RuntimeEventListener>();
    const prompts = this.prompts;
    return {
      async prompt(text: string) {
        prompts.push(text);
        for (const listener of listeners) {
          listener({ type: "assistant_text_delta", delta: "ok" });
          listener({ type: "message_end" });
        }
      },
      setTools() {}, async abort() {},
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

test("skills are picked from the person's words, not from a mentioned chat sent with them (decision 90)", async () => {
  const { homeDir, projectRoot } = await folders();
  const runtime = new Runtime();
  let output = "";
  const app = new CasperApp({
    sessionHomeDir: homeDir, verificationMode: "off", runtimeFactory: () => runtime,
    loadProjectContext: (project) => loadProjectContext(project, { homeDir }),
    loadSkillRegistry: (context) => SkillRegistry.discover(skillRegistryOptions(context, homeDir)),
    loadMCPConfiguration: (context) => discoverMCPConfiguration({ projectRoot: context.info.root, homeDir, imports: false }),
    output: { write: (text) => { output += text; } },
  });
  try {
    const typed = "what did that chat change? Then count the tests in sum.test.js without running them.";
    // The mentioned chat talks about Google Docs and building an MCP server: its words are context, not the request.
    const mentioned = "chat:abc\n## Referenced sessions\n[{\"role\":\"user\",\"text\":\"edit the Google Doc in my Google Drive, then build an MCP server for our ticket api in python\"}]";
    await app.runOnce(`${typed}\n${mentioned}`, projectRoot, typed);
    expect(output).not.toContain("skills selected");
    expect(runtime.prompts.at(-1)).toContain("Google Drive");
    // The person's own words still pick the skill they name.
    output = "";
    await app.runOnce(`build an MCP server for our ticket api in python\n${mentioned}`, projectRoot, "build an MCP server for our ticket api in python");
    expect(output).toContain(" skills selected: mcp-builder");
  } finally {
    await app.close();
  }
});
