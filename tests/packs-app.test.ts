import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { browserDefaults } from "../src/browser/discovery";
import type { MCPServerDefinition } from "../src/mcp/config";
import { followTheme } from "../src/app/project-file";
import { settingRows } from "../src/app/settings";
import { checkConfig } from "../src/doctor/checks";
import { formatDoctorLines } from "../src/doctor/run";
import { runPackCommand } from "../src/packs/command";
import { readPackFolder } from "../src/packs/files";
import { installPack, loadInstalledPacks, stagePack } from "../src/packs/store";
import { registerPackThemes } from "../src/packs/themes";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { activeThemeName, themeNames, useTheme } from "../src/tui/theme";
import type { AgentRuntime, RuntimeEventListener, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry, skillRegistryOptions } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  // Packs off takes every pack's theme off the list again.
  await registerPackThemes(os.tmpdir(), false);
  useTheme(undefined);
});

async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-packs-app-")));
  cleanup.push(() => removeTempDir(dir));
  return dir;
}

const OCEAN = 'name: ocean\ncolors:\n  accent: "#3399ff"\n  warning: magenta\n';

/** A pack folder; with `theme`, its themes/ocean.yaml holds that text and pack.yaml names it. */
async function writePack(dir: string, skills: string[], name = "writing-basics", theme?: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "pack.yaml"), `name: ${name}\nversion: 1.2.0\ndescription: Read-only help.\nskills:\n${skills.map((skill) => `  - skills/${skill}`).join("\n")}\n${theme === undefined ? "" : "theme: themes/ocean.yaml\n"}`);
  if (theme !== undefined) {
    await mkdir(path.join(dir, "themes"), { recursive: true });
    await writeFile(path.join(dir, "themes", "ocean.yaml"), theme);
  }
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
  const output = await session(home, project, runtime, [`/pack add ${pack}`, "Help me with drafting letters for the office"], ["3", "2"]);
  expect(output).toContain(`Add pack writing-basics from ${pack}?\nIt brings 1 skill. Nothing else runs.\n  1 No\n  2 Yes, add it\n  3 Show me what's inside\n`);
  // 3 shows every file, each row behind the bar, laid out for the terminal.
  expect(output).toMatch(/--- skills\/drafting\/SKILL\.md \(\d+ bytes\) ---\n {2}│ ---\n {2}│ name: drafting\n/);
  expect(output).toContain("\n--- end of pack writing-basics ---\n");
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

test("a pack's theme is on the list at start only while packs are on: theme: in your config picks it, a project file can't, and packs off or /pack remove goes back to default with the note", async () => {
  const { root, home, project } = await fixture();
  const config = path.join(home, ".casper", "config.yaml");
  const folder = await writePack(path.join(root, "pack"), ["drafting"], "writing-basics", OCEAN);
  await installPack(home, await stagePack(home, await readPackFolder(folder)), folder);
  await writeFile(config, "theme: ocean\n");
  const start = async () => {
    let output = "";
    const app = new CasperApp({ output: { write: (text) => { output += text; } }, runtimeFactory() { throw new Error("No model expected"); },
      sessionHomeDir: home, loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }) });
    try { await app.start(project); return { output, context: app.projectContext! }; } finally { await app.close(); }
  };
  const NOTE = "[config] theme ocean is not one Casper has; using default. Themes: default, light, high-contrast";

  const on = await start();
  expect(activeThemeName()).toBe("ocean");
  expect(on.output).not.toContain("ocean");
  // /settings offers it by name, as the pack's; casper doctor finds it too.
  const row = settingRows({ ...on.context, theme: "default" }).find((setting) => setting.label === "Theme")!;
  expect(row.choices.map((choice) => [choice.label, choice.description])).toEqual([
    ["Light", "for a light terminal background"], ["High-contrast", "bright colours, no faint text"], ["Ocean", "from pack writing-basics"],
  ]);
  // casper doctor runs in its own process, with no theme on the list but the built-in ones; and inside a session it
  // leaves the session's list as it is.
  const doctor = async () => formatDoctorLines((await checkConfig({ homeDir: home, projectRoot: project, env: {}, platform: process.platform,
    currentVersion: "0.0.0", install: { kind: "binary", executable: path.join(home, "casper") }, agentDir: path.join(home, ".casper", "agent") })).lines);
  await registerPackThemes(os.tmpdir(), false);
  expect(await doctor()).not.toContain("ocean");
  expect(themeNames()).toEqual(["default", "light", "high-contrast"]);
  await writeFile(config, "packs: off\ntheme: ocean\n");
  expect(await doctor()).toContain("theme ocean is not one Casper has; using default. Themes: default, light, high-contrast");
  await writeFile(config, "theme: ocean\n");
  await registerPackThemes(home, true);

  // A project file can't set theme: at all, a pack's theme included.
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper", "project.yaml"), "theme: ocean\n");
  await expect(loadProjectContext(await inspectProject(project), { homeDir: home })).rejects.toThrow("theme is a user setting (~/.casper/config.yaml); a project cannot change your screen's colours");
  await rm(path.join(project, ".casper", "project.yaml"));

  // Packs off: no pack's theme is on the list, and your theme: goes back to default with the usual note.
  await writeFile(config, "packs: off\ntheme: ocean\n");
  const off = await start();
  expect([activeThemeName(), themeNames()]).toEqual(["default", ["default", "light", "high-contrast"]]);
  expect(off.output.split("\n").filter((line) => line.includes("ocean"))).toEqual([NOTE]);

  // Removed while in use: it stays on screen until Casper starts again, then default with the note.
  await writeFile(config, "theme: ocean\n");
  await start();
  expect(activeThemeName()).toBe("ocean");
  const printed: string[] = [];
  await runPackCommand({ homeDir: home, cwd: project, packsOn: true, canAsk: true, print: (line) => printed.push(line),
    approve: async () => undefined, takenNames: () => ({ skills: [], servers: [] }) }, "remove writing-basics");
  expect(printed).toEqual(["Removed pack writing-basics. Its theme ocean stays on screen until you start Casper again; then the colours go back to default."]);
  expect([activeThemeName(), themeNames()]).toEqual(["ocean", ["default", "light", "high-contrast"]]);
  // Settings read again in the session (a /settings change, /verify add, /undo) keep it, and /settings says why.
  const written: string[] = [];
  const session = { projectContext: { ...on.context, theme: "ocean" }, events: { ensureLineBreak() {} }, output: { write: (text: string) => written.push(text) } };
  followTheme(session as unknown as Parameters<typeof followTheme>[0], "ocean");
  expect([activeThemeName(), written]).toEqual(["ocean", []]);
  expect(settingRows({ ...on.context, theme: "ocean" }).find((setting) => setting.label === "Theme")!.value).toBe("ocean (its pack is no longer used; default from the next start)");
  // Picking another one in /settings uses it.
  followTheme({ ...session, projectContext: { ...on.context, theme: "light" } } as unknown as Parameters<typeof followTheme>[0], "ocean");
  expect(activeThemeName()).toBe("light");
  const removed = await start();
  expect(activeThemeName()).toBe("default");
  expect(removed.output.split("\n").filter((line) => line.includes("ocean"))).toEqual([NOTE]);
});

test("a 20-skill pack with a theme adds 0 bytes to the fixed part of a request, its theme in use or not", async () => {
  const first = async (withPack: boolean) => {
    const { root, home, project } = await fixture();
    await mkdir(path.join(project, "src"), { recursive: true });
    await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "demo-app", type: "module", scripts: { test: "bun test" } }));
    await writeFile(path.join(project, "src/math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
    // Both runs name the pack's theme: with the pack it is used, without it default is.
    await writeFile(path.join(home, ".casper", "config.yaml"), "theme: ocean\n");
    if (withPack) {
      const skills = Array.from({ length: 20 }, (_, index) => `letters-${String(index + 1).padStart(2, "0")}`);
      const folder = await writePack(path.join(root, "pack"), skills, "writing-basics", OCEAN);
      const output = await session(home, project, new ScriptedRuntime(), [`/pack add ${folder}`], ["2"]);
      expect(output).toContain("It brings 20 skills and a theme. Nothing else runs.");
      expect((await loadInstalledPacks(home)).packs.map(({ record }) => [record.skills.length, record.theme])).toEqual([[20, "themes/ocean.yaml"]]);
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
    expect(activeThemeName()).toBe(withPack ? "ocean" : "default");
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
