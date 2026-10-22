import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { discoverMCPConfiguration } from "../src/mcp/config";
import { MCP_ADD_TOOL } from "../src/mcp/add-tool";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { childTestLimit } from "./support/limits";
import { removeTempDir } from "./support/temp-dir";

/** casper_mcp_add in a real session: the box on the plain terminal, "Yes to everything" on, and a one-shot run. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const network = path.join(import.meta.dir, "fixtures/mcp-network-server.ts");
const ADD = { name: "net", command: process.execPath, args: [network] };

async function folders() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-tool-app-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await mkdir(path.join(home, ".casper"), { recursive: true });
  return { home, project };
}
const added = (home: string) => readFile(path.join(home, ".casper/mcp.json"), "utf8").then((text) => JSON.parse(text).mcpServers, () => undefined);

/** A session whose model, at each request, records the tools it was offered and calls casper_mcp_add when it has it. */
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
          const add = tools.find((tool) => tool.name === MCP_ADD_TOOL);
          if (add) results.push(await add.execute(ADD));
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
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: path.join(home, "..", "project"), homeDir: home, platform: "linux" }),
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

test("with Yes to everything on (/permissions all), the box still asks; No adds nothing", async () => {
  const { home, project } = await folders();
  const run = await session(home, project, ["add the example MCP server"], ["1"], (casper) => { casper.stopAsking = true; });
  expect(run.output()).toContain("The AI wants to add an MCP server and start it now:\n  name     net\n");
  expect(run.output()).toContain("Add net and start it?");
  expect(run.results).toEqual([{ text: "Not added: the user said no. Nothing was written or started.", isError: true }]);
  expect(await added(home)).toBeUndefined();
  // Asking stayed off the whole time: the box asked anyway.
  expect(run.casper.stopAsking).toBe(true);
});

test("the tool comes with the first request that names MCP and stays; a yes in the box adds the server and starts it", async () => {
  const { home, project } = await folders();
  const run = await session(home, project, ["fix the login bug", "add the example MCP server", "fix the login bug again"], ["2"]);
  expect(run.offered.map((names) => names.includes(MCP_ADD_TOOL))).toEqual([false, true, true]);
  expect(run.results[0]).toEqual({ text: "Added net to ~/.casper/mcp.json and started it (3 tools · writes off). Find its tools with find_capability." });
  expect(run.output()).toContain("[mcp] Added net to ~/.casper/mcp.json: ");
  expect((await added(home)).net).toEqual({ command: process.execPath, args: [network], env: {} });
}, childTestLimit());

test("a one-shot run can't ask: nothing is written, and the person is told the /mcp add line to type", async () => {
  const { home, project } = await folders();
  let output = "";
  const run = app(home, undefined, (text) => { output += text; });
  await run.casper.start(project);
  await run.casper.runOnce("add the example MCP server");
  expect(run.results[0]?.isError).toBe(true);
  expect(run.results[0]?.text).toStartWith("Not added: this run can't ask the user. Tell them to type this in a Casper session: /mcp add net ");
  expect(output).toContain("[mcp] The AI wanted to add net, and this run can't ask you, so nothing was added.");
  expect(await stat(path.join(home, ".casper/mcp.json")).then(() => true, () => false)).toBe(false);
});
