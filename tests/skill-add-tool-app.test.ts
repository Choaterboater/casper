import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SKILL_ADD_TOOL } from "../src/skills/add-tool";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

/** casper_skill_add in a real session: the box on the plain terminal, "Yes to everything" on, and a one-shot run. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const SKILL = { name: "lab-naming", description: "Naming rules for lab sites and switches.", text: "Site names are <city>-<building>." };

async function folders() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-skill-tool-app-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await mkdir(path.join(home, ".casper"), { recursive: true });
  return { home, project };
}
const added = (home: string) => readFile(path.join(home, ".casper/skills/lab-naming/SKILL.md"), "utf8").catch(() => undefined);

/** A session whose model, at each request, records the tools it was offered and calls casper_skill_add when it has it. */
function app(home: string, input?: PassThrough, write: (text: string) => void = () => {}) {
  const offered: string[][] = [];
  const results: Array<{ text: string; isError?: boolean }> = [];
  const runtime: AgentRuntime = {
    async start(options: RuntimeStartOptions) {
      let tools = options.tools ?? [];
      return {
        setTools: (next: RuntimeTool[]) => { tools = next; },
        prompt: async () => {
          offered.push(tools.map((tool) => tool.name));
          const add = tools.find((tool) => tool.name === SKILL_ADD_TOOL);
          if (add) results.push(await add.execute(SKILL));
        },
        abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
      };
    },
    async dispose() {},
  };
  const casper = new CasperApp({
    runtimeFactory: () => runtime, ...(input ? { input } : {}), sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    output: { write },
  });
  cleanup.push(() => casper.close());
  return { casper, offered, results };
}

/** An interactive session on the plain terminal: `lines` typed at each prompt, `answers` at each numbered box. */
async function session(home: string, project: string, lines: string[], answers: string[], prepare?: (app: CasperApp) => void) {
  const input = new PassThrough();
  let output = "";
  const pending = [...lines];
  const made = app(home, input, (text) => {
    output += text;
    if (text === "> ") queueMicrotask(() => input.write(`${pending.shift() ?? "/exit"}\n`));
    if (/Type [\d, ]*\d or \d: $/.test(text)) queueMicrotask(() => input.write(`${answers.shift() ?? "1"}\n`));
  });
  prepare?.(made.casper);
  await made.casper.runInteractive(project);
  return { ...made, output: () => output };
}

test("with Yes to everything on (/permissions all), the box still asks after the whole text; No adds nothing", async () => {
  const { home, project } = await folders();
  const run = await session(home, project, ["add a skill for our lab naming rules"], ["1"], (casper) => { casper.stopAsking = true; });
  const output = run.output();
  expect(output).toContain("--- the skill lab-naming: ~/.casper/skills/lab-naming/SKILL.md ---\n  │ ---\n  │ name: lab-naming\n");
  expect(output).toContain("  │ Site names are <city>-<building>.\n--- end of the skill lab-naming ---\n");
  expect(output.indexOf("--- end of the skill lab-naming ---")).toBeLessThan(output.indexOf("Add the skill lab-naming?"));
  expect(run.results).toEqual([{ text: "Not added: the user said no. Nothing was written.", isError: true }]);
  expect(await added(home)).toBeUndefined();
  // Asking stayed off the whole time: the box asked anyway.
  expect(run.casper.stopAsking).toBe(true);
});

test("the tool comes with the first request that names a skill and stays; a yes adds the skill and the session uses it", async () => {
  const { home, project } = await folders();
  const run = await session(home, project, ["fix the login bug", "add a skill for our lab naming rules", "fix the login bug again"], ["2"]);
  expect(run.offered.map((names) => names.includes(SKILL_ADD_TOOL))).toEqual([false, true, true]);
  expect(run.results[0]).toEqual({ text: "Added the skill lab-naming (~/.casper/skills/lab-naming/SKILL.md). It is used from the next request it fits." });
  // Asked again, the same name is now taken: nothing is written over it.
  expect(run.results[1]).toEqual({ text: "Not added: lab-naming is already a skill. Pick another name.", isError: true });
  expect(run.output()).toContain("[skills] Added lab-naming: ~/.casper/skills/lab-naming/SKILL.md\n");
  expect(await added(home)).toBe("---\nname: lab-naming\ndescription: Naming rules for lab sites and switches.\n---\nSite names are <city>-<building>.\n");
  expect(run.casper.skillRegistry?.list().find((skill) => skill.name === "lab-naming")?.source).toBe("user");
});

test("a one-shot run can't ask: nothing is written, and the person is told to ask again in a session", async () => {
  const { home, project } = await folders();
  let output = "";
  const run = app(home, undefined, (text) => { output += text; });
  await run.casper.start(project);
  await run.casper.runOnce("add a skill for our lab naming rules");
  expect(run.results[0]).toEqual({ text: "Not added: this run can't ask the user. Tell them to ask for it again in a Casper session.", isError: true });
  expect(output).toContain("[skills] The AI wanted to add the skill lab-naming, and this run can't ask you, so nothing was added.");
  expect(await stat(path.join(home, ".casper/skills")).then(() => true, () => false)).toBe(false);
});
