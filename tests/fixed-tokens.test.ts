import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { browserDefaults } from "../src/browser/discovery";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

/** What Casper adds to every model request: its system prompt and its own tools. Pi's built-in tools and edit
 * rules are left out (Casper does not write them). Sizes are characters of the text as sent; a token is about
 * 4 characters. Raise a budget only on purpose: every request pays it. */

/** A few percent above the sizes when this was set (October 2026: 11,754 characters fixed, about 4,000 o200k tokens
 * with Pi's own tools; it was 15,464 before the trims). */
const BUDGET = {
  fixed: 12_200,
  preamble: 1_200,
  tools: { browser: 3_500, casper_read_untrusted: 1_100, casper_check: 950, delegate: 950 } as Record<string, number>,
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
async function firstRequest(task: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-fixed-tokens-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "demo-app", type: "module", scripts: { test: "bun test", build: "tsc -p ." } }));
  await writeFile(path.join(project, "tsconfig.json"), "{}\n");
  await writeFile(path.join(project, "src/math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
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
  });
  cleanup.push(() => app.close());
  await app.runOnce(task, project);
  const first = runtime.first!;
  // The tool list as an OpenAI-style request carries it.
  const toolText = JSON.stringify(first.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })));
  const preamble = first.text.includes("User request:") ? first.text.slice(0, first.text.indexOf("User request:")) : "";
  return { system: runtime.system, names: first.tools.map((tool) => tool.name), toolText, preamble };
}

test("the fixed part of a request stays small: system prompt plus Casper's tools for a small project", async () => {
  const { system, names, toolText, preamble } = await firstRequest("Add a sum function to src/math.ts and use it in src/index.ts");
  // Every tool the first request needs is still there; a diagram tool waits for a diagram word.
  expect(names).toEqual(["delegate", "ask", "casper_check", "web_search", "web_fetch", "casper_read_untrusted", "browser"]);
  expect(system.length + toolText.length).toBeLessThan(BUDGET.fixed);
  expect(preamble.length).toBeLessThan(BUDGET.preamble);
});

test("each tool's text stays within its own budget", async () => {
  const { toolText } = await firstRequest("Add a sum function to src/math.ts");
  const sizes = Object.fromEntries((JSON.parse(toolText) as Array<{ function: { name: string } }>).map((tool) => [tool.function.name, JSON.stringify(tool).length]));
  for (const [name, limit] of Object.entries(BUDGET.tools)) expect({ name, size: sizes[name]! < limit }).toEqual({ name, size: true });
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
});
