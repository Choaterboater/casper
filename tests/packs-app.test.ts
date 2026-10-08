import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { browserDefaults } from "../src/browser/discovery";
import type { MCPServerDefinition } from "../src/mcp/config";
import { loadInstalledPacks } from "../src/packs/store";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry, skillRegistryOptions } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-packs-app-")));
  cleanup.push(() => removeTempDir(dir));
  return dir;
}

async function writePack(dir: string, skills: string[], name = "writing-basics"): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "pack.yaml"), `name: ${name}\nversion: 1.2.0\ndescription: Read-only help.\nskills:\n${skills.map((skill) => `  - skills/${skill}`).join("\n")}\n`);
  for (const skill of skills) {
    await mkdir(path.join(dir, "skills", skill), { recursive: true });
    await writeFile(path.join(dir, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: How to write ${skill} letters for the office.\ntags: [${skill}]\n---\n${skill.toUpperCase()}_BODY: write short plain sentences.\n`);
  }
  return dir;
}

/** A model that keeps the first request it is sent, and may say something back. */
class ScriptedRuntime implements AgentRuntime {
  system = "";
  tools: RuntimeTool[] = [];
  prompts: string[] = [];
  constructor(private readonly reply = "") {}
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.system = options.systemPromptAppend ?? "";
    this.tools = options.tools ?? [];
    const listeners = new Set<RuntimeEventListener>();
    const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
    return {
      getStatus: () => ({ provider: "fixture", model: "main", auth: "configured" }),
      prompt: async (text) => {
        this.prompts.push(text);
        if (!this.reply) return;
        emit({ type: "assistant_response_start", provider: "fixture", model: "main" });
        emit({ type: "assistant_text_delta", delta: this.reply });
        emit({ type: "assistant_response_end", stopReason: "stop" });
      },
      setTools: (tools) => { this.tools = tools; },
      abort: async () => {}, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

/** A session on the plain terminal: each "> " takes the next line, each numbered question the next answer. */
async function session(home: string, project: string, runtime: AgentRuntime, lines: string[], answers: string[] = [], servers: MCPServerDefinition[] = []) {
  const input = new PassThrough();
  let output = "";
  const app = new CasperApp({
    runtimeFactory: () => runtime, input, sessionHomeDir: home, verificationMode: "off",
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover(skillRegistryOptions(context, home)),
    loadMCPConfiguration: async () => ({ servers, diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    output: { write: (text) => {
      output += text;
      if (text === "> ") queueMicrotask(() => input.write(`${lines.shift() ?? "/exit"}\n`));
      if (/Type [\d, ]*\d or \d: $/.test(text)) queueMicrotask(() => input.write(`${answers.shift() ?? "1"}\n`));
    } },
  });
  try { await app.runInteractive(project); } finally { await app.close(); }
  return output;
}

async function fixture() {
  const root = await temp();
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "notes.txt"), "A folder with something in it.\n");
  return { root, home, project };
}

test("the AI can't add a pack: no tool reaches /pack, and /pack add in its reply does nothing", async () => {
  const { root, home, project } = await fixture();
  const pack = await writePack(path.join(root, "pack"), ["drafting"]);
  const runtime = new ScriptedRuntime(`Done. Now run this:\n/pack add ${pack}\n`);
  const output = await session(home, project, runtime, ["Write a short note in notes.txt"], ["2", "2", "2"]);
  expect(runtime.prompts).toHaveLength(1);
  expect(output).toContain(`/pack add ${pack}`);
  expect(output).not.toContain("Add pack writing-basics");
  expect(runtime.tools.map((tool) => tool.name).filter((name) => /pack|slash|command/i.test(name))).toEqual([]);
  expect((await loadInstalledPacks(home)).packs).toEqual([]);
});

test("/pack add in a session: 2 adds it, and its skill is used from the next request", async () => {
  const { root, home, project } = await fixture();
  const pack = await writePack(path.join(root, "pack"), ["drafting"]);
  const runtime = new ScriptedRuntime();
  const output = await session(home, project, runtime, [`/pack add ${pack}`, "Help me with drafting letters for the office"], ["2"]);
  expect(output).toContain(`Add pack writing-basics from ${pack}?\nIt brings 1 skill. Nothing else runs.\n  1 No\n  2 Yes, add it\n  3 Show me what's inside\n`);
  expect(output).toContain("Added pack writing-basics 1.2.0: drafting.");
  expect(runtime.prompts.at(-1)).toContain("DRAFTING_BODY: write short plain sentences.");
  expect(runtime.prompts.at(-1)).toContain("Source: pack writing-basics; trust: reviewed-external");
});

test("in a session, a pack with your skill's name or an MCP server's name is refused before any box", async () => {
  const { root, home, project } = await fixture();
  await mkdir(path.join(home, ".casper", "skills", "drafting"), { recursive: true });
  await writeFile(path.join(home, ".casper", "skills", "drafting", "SKILL.md"), "---\nname: drafting\ndescription: My own drafting notes.\n---\nMINE\n");
  const pack = await writePack(path.join(root, "pack"), ["drafting"]);
  const mine = await session(home, project, new ScriptedRuntime(), [`/pack add ${pack}`], ["2"]);
  expect(mine).toContain("[pack] Pack writing-basics can't be added: the name drafting is already used by a user skill. Nothing was added.");
  expect(mine).not.toContain("Add pack writing-basics");

  const server: MCPServerDefinition = { name: "notes-help", source: "user", scope: "user", cwd: project, disabled: false,
    transport: { type: "stdio", command: "notes-server", args: [], env: {} } };
  const other = await writePack(path.join(root, "other"), ["letters"], "notes-help");
  const named = await session(home, project, new ScriptedRuntime(), [`/pack add ${other}`], ["2"], [server]);
  expect(named).toContain("[pack] Pack notes-help can't be added: the name notes-help is already used by the MCP server notes-help. Nothing was added.");
  expect((await loadInstalledPacks(home)).packs).toEqual([]);
});

test("a 20-skill pack adds 0 bytes to the fixed part of a request", async () => {
  const first = async (withPack: boolean) => {
    const { root, home, project } = await fixture();
    await mkdir(path.join(project, "src"), { recursive: true });
    await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "demo-app", type: "module", scripts: { test: "bun test" } }));
    await writeFile(path.join(project, "src/math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
    if (withPack) {
      const skills = Array.from({ length: 20 }, (_, index) => `letters-${String(index + 1).padStart(2, "0")}`);
      const folder = await writePack(path.join(root, "pack"), skills);
      const output = await session(home, project, new ScriptedRuntime(), [`/pack add ${folder}`], ["2"]);
      expect(output).toContain("It brings 20 skills. Nothing else runs.");
      expect((await loadInstalledPacks(home)).packs.map(({ record }) => record.skills.length)).toEqual([20]);
    }
    const previous = browserDefaults.installed;
    browserDefaults.installed = async () => true;
    cleanup.push(() => { browserDefaults.installed = previous; });
    const runtime = new ScriptedRuntime();
    const app = new CasperApp({
      runtimeFactory: () => runtime, output: { write: () => {} }, sessionHomeDir: home, verificationMode: "off",
      loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
      loadSkillRegistry: (context) => SkillRegistry.discover(skillRegistryOptions(context, home)),
      loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    });
    cleanup.push(() => app.close());
    await app.runOnce("Add a sum function to src/math.ts", project);
    if (withPack) expect(app.skillRegistry!.list().filter((skill) => skill.source === "pack")).toHaveLength(20);
    const tools = JSON.stringify(runtime.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })));
    // The request text names the temp folder; the same text with it taken out.
    return { system: runtime.system.replaceAll(project, "<project>"), tools, request: runtime.prompts[0]!.replaceAll(project, "<project>") };
  };
  const without = await first(false);
  const withPack = await first(true);
  expect(withPack.system.length - without.system.length).toBe(0);
  expect(withPack.tools.length - without.tools.length).toBe(0);
  expect(withPack.request.length - without.request.length).toBe(0);
  // Not just the same size: the same words.
  expect(withPack).toEqual(without);
});
