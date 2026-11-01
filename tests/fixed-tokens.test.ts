import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { CasperApp } from "../src/app";
import { browserDefaults } from "../src/browser/discovery";
import { loadProjectContext } from "../src/project/context";
import { systemPromptAppend, DEFAULT_SYSTEM_PROMPT_APPEND, LEAN_SYSTEM_PROMPT_APPEND } from "../src/app/prompt";
import { projectGuidance, type GuidanceModel, type GuidanceSetting } from "../src/runtime/guidance";
import { withBackgroundOption, withStepTitle } from "../src/runtime/pi";
import { COMMAND_GUIDANCE } from "../src/runtime/guidance";
import type { AgentRuntime, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

/** What Casper adds to every model request: its system prompt and its own tools. Pi's built-in tools and edit
 * rules are left out (Casper does not write them). Sizes are characters of the text as sent; a token is about
 * 4 characters. Raise a budget only on purpose: every request pays it. */

/** A few percent above the sizes when this was set (October 2026: 11,754 characters fixed, about 4,000 o200k tokens
 * with Pi's own tools; it was 15,464 before the trims). Decision 25 (docs/adr/0002/25-visibility-over-a-smaller-prompt.md)
 * lets the AI say what it does for up to about 1,000 tokens more; fixed and lean are raised only by what that uses: the
 * line before each group of tool calls and the line after a change, 160 characters full and 77 lean. */
const BUDGET = {
  fixed: 12_360,
  /** Includes unchanged JSON schemas; lean wording saves at least a fifth of the full fixed request. */
  lean: 9_080,
  preamble: 1_200,
  /** casper_page is one short line: its guide comes back from the tool, never in the fixed prompt. */
  tools: { browser: 3_500, casper_read_untrusted: 1_100, casper_check: 950, delegate: 950, casper_session: 350, casper_page: 400 } as Record<string, number>,
  /** In a Git repository delegate also offers builders (about 50 tokens more). */
  delegateWithBuilders: 1_150,
  /** Decision 25: the shell's optional step title, added to Pi's bash tool for every request (129 characters). */
  stepTitle: 130,
  /** The shell's `background` option (154 characters), paid for in part by the 47 the bash guidance gave up ("slow work may
   * background (the result says so)": the result says it anyway). */
  background: 160,
};

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

class CaptureRuntime implements AgentRuntime {
  system = "";
  tools: RuntimeTool[] = [];
  first?: { text: string; tools: RuntimeTool[] };
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.system = options.systemPromptAppend ?? "";
    this.tools = options.tools ?? [];
    return {
      prompt: async (text) => { this.first ??= { text, tools: this.tools }; },
      setTools: (tools) => { this.tools = tools; },
      abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

/** A small TypeScript project with test and build scripts, Chrome present, checks on. */
async function firstRequest(task: string, options: { git?: boolean; model?: GuidanceModel; guidance?: GuidanceSetting } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-fixed-tokens-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(path.join(project, "src"), { recursive: true });
  if (options.guidance) await writeFile(path.join(home, ".casper", "config.yaml"), `lean_guidance: ${options.guidance}\n`);
  await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "demo-app", type: "module", scripts: { test: "bun test", build: "tsc -p ." } }));
  await writeFile(path.join(project, "tsconfig.json"), "{}\n");
  await writeFile(path.join(project, "src/math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
  if (options.git) {
    await writeFile(path.join(home, ".casper", "config.yaml"), `delegate:\n  build: true\n${options.guidance ? `lean_guidance: ${options.guidance}\n` : ""}`);
    // Builders start from a commit, so a repository with none doesn't offer them.
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
    execFileSync("git", ["-c", "user.name=Casper Test", "-c", "user.email=casper@example.invalid", "add", "-A"], { cwd: project });
    execFileSync("git", ["-c", "user.name=Casper Test", "-c", "user.email=casper@example.invalid", "commit", "-q", "-m", "base"], { cwd: project });
  }
  const previous = browserDefaults.installed;
  browserDefaults.installed = async () => true;
  cleanup.push(() => { browserDefaults.installed = previous; });
  const runtime = new CaptureRuntime();
  const app = new CasperApp({
    runtimeFactory: () => runtime, output: { write: () => {} }, sessionHomeDir: home, verificationMode: "auto",
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    ...(options.git ? { noSandbox: true } : {}),
  });
  cleanup.push(() => app.close());
  await app.runOnce(task, project);
  const first = runtime.first!;
  // Pi's context_with_system projection sees this same system/tool state before each provider call.
  const [projected] = projectGuidance([{ role: "system", content: runtime.system, timestamp: 0,
    toolsAdded: first.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })) }], options.model,
    app.projectContext?.leanGuidance, first.tools, { systemPromptAppend: runtime.system,
      leanSystemPromptAppend: systemPromptAppend(app.projectContext!, true) });
  if (projected?.role !== "system") throw new Error("Missing system prompt");
  const fullSystem = runtime.system;
  runtime.system = projected.content as string;
  first.tools = first.tools.map((tool, index) => ({ ...tool, description: projected.toolsAdded![index]!.description }));
  // The tool list as an OpenAI-style request carries it.
  const toolText = JSON.stringify(first.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })));
  const preamble = first.text.includes("User request:") ? first.text.slice(0, first.text.indexOf("User request:")) : "";
  return { system: runtime.system, fullSystem, names: first.tools.map((tool) => tool.name), toolText, preamble };
}

test("the fixed part of a request stays small: system prompt plus Casper's tools for a small project", async () => {
  const { system, names, toolText, preamble } = await firstRequest("Add a sum function to src/math.ts and use it in src/index.ts");
  // Every tool the first request needs is still there; a diagram tool waits for a diagram word.
  expect(names).toEqual(["delegate", "ask", "casper_session", "casper_check", "web_search", "web_fetch", "casper_read_untrusted", "casper_page", "browser"]);
  expect(system.length + toolText.length).toBeLessThan(BUDGET.fixed);
  expect(preamble.length).toBeLessThan(BUDGET.preamble);
});

test("each tool's text stays within its own budget", async () => {
  const { toolText } = await firstRequest("Add a sum function to src/math.ts");
  const sizes = Object.fromEntries((JSON.parse(toolText) as Array<{ function: { name: string } }>).map((tool) => [tool.function.name, JSON.stringify(tool).length]));
  for (const [name, limit] of Object.entries(BUDGET.tools)) expect({ name, size: sizes[name]! < limit }).toEqual({ name, size: true });
});

test("with builders offered (a Git repository) delegate stays within its budget", async () => {
  const { toolText } = await firstRequest("Add a sum function to src/math.ts", { git: true });
  const delegate = (JSON.parse(toolText) as Array<{ function: { name: string; description: string } }>).find((tool) => tool.function.name === "delegate")!;
  expect(delegate.function.description).toContain("Role builder");
  expect(delegate.function.description).toContain("start independent builders in the same turn");
  expect(JSON.stringify(delegate).length).toBeLessThan(BUDGET.delegateWithBuilders);
});

test("check advice is said once: in casper_check, not again in every task's text", async () => {
  const { toolText, preamble } = await firstRequest("Add a sum function to src/math.ts");
  const check = (JSON.parse(toolText) as Array<{ function: { name: string; description: string } }>).find((tool) => tool.function.name === "casper_check")!.function.description;
  expect(check).toContain("Pick checks from the actual changes, not the request's words; docs-only or no-change work may need none.");
  expect(check).toContain("only these runs are recorded");
  expect(check).toContain("a skip means they said no; don't ask again in chat");
  expect(preamble).not.toContain("Select checks");
  expect(preamble).not.toContain("four-check");
  // What the tool does not say stays in the task text.
  expect(preamble).toContain("If you ran tests yourself, say in one line what ran and the result. Don't claim a check passed that didn't run.");
  expect(preamble).toContain("Count a requirement as done only when a test you can name asserts it");
  expect(preamble).toContain("Do not list the covered ones");
  // Decision 39: open items are only what needs the person or is blocked; the rest the AI does itself.
  expect(preamble).toContain("Do the rest yourself; end with only those still not done because they need the person or are blocked");
});

test("full and lean guidance use native/plain reads rather than interpreter scripts for tiny reads", () => {
  for (const prompt of [DEFAULT_SYSTEM_PROMPT_APPEND, LEAN_SYSTEM_PROMPT_APPEND]) {
    expect(prompt).toContain("scripts only to compute");
    expect(prompt).toContain("read");
    expect(prompt).toContain("wc");
    expect(prompt).toContain("tail");
  }
});

test("lean fixed guidance is well below full, with the same tools and schemas", async () => {
  const task = "Add a sum function to src/math.ts";
  const full = await firstRequest(task);
  for (const model of [{ provider: "ollama", contextWindow: 128_000 }, { provider: "hosted", contextWindow: 16_384 },
    { provider: "hosted", contextWindow: 32_768 }]) {
    const lean = await firstRequest(task, { model });
    expect(lean.system).toContain(LEAN_SYSTEM_PROMPT_APPEND);
    expect(lean.system).not.toContain(DEFAULT_SYSTEM_PROMPT_APPEND);
    expect(lean.system.length + lean.toolText.length).toBeLessThan(BUDGET.lean);
    expect(lean.system.length + lean.toolText.length).toBeLessThan((full.system.length + full.toolText.length) * 0.8);
    expect(lean.names).toEqual(full.names);
    const definitions = (text: string) => JSON.parse(text).map((tool: { function: { description?: string } }) => {
      const { description: _description, ...rest } = tool.function; return rest;
    });
    expect(definitions(lean.toolText)).toEqual(definitions(full.toolText));
  }
});

test("big hosted models get exactly the full text and descriptions; off restores full for local and small", async () => {
  const task = "Add a sum function to src/math.ts";
  const hosted = await firstRequest(task, { model: { provider: "hosted", contextWindow: 200_000 } });
  expect(hosted.system).toBe(hosted.fullSystem);
  expect(hosted.system).toContain(DEFAULT_SYSTEM_PROMPT_APPEND);
  for (const model of [{ provider: "ollama", contextWindow: 128_000 }, { provider: "hosted", contextWindow: 16_384 }]) {
    const off = await firstRequest(task, { model, guidance: "off" });
    expect(off.system).toBe(off.fullSystem);
    expect(off.toolText).toBe(hosted.toolText);
  }
});

test("the shell's optional step title adds only its own small budget to every request (decision 25)", () => {
  const base = createBashToolDefinition(process.cwd()).parameters;
  expect(JSON.stringify(withStepTitle(base)).length - JSON.stringify(base).length).toBeLessThan(BUDGET.stepTitle);
  expect(Object.keys(withStepTitle(base).properties)).toEqual([...Object.keys(base.properties), "description"]);
});

test("the shell's background option adds only its own small budget, and the bash guidance gave up its background words", () => {
  const base = withStepTitle(createBashToolDefinition(process.cwd()).parameters);
  expect(JSON.stringify(withBackgroundOption(base)).length - JSON.stringify(base).length).toBeLessThan(BUDGET.background);
  expect(Object.keys(withBackgroundOption(base).properties)).toEqual([...Object.keys(base.properties), "background"]);
  expect(COMMAND_GUIDANCE).not.toContain("background");
});
