import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { discoverMCPConfiguration } from "../src/mcp/config";
import { MCP_ADD_TOOL } from "../src/mcp/add-tool";
import { MCP_REMOVE_TOOL } from "../src/mcp/edit";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { childTestLimit } from "./support/limits";
import { removeTempDir } from "./support/temp-dir";

/**
 * From a real v0.4.10 session: rea was pinned to rea-agents@6.7.0, the AI couldn't change the pin (casper_mcp_add refused
 * the name, and ~/.casper/mcp.json is private), so it added a duplicate "rea-agents"; told "u have permision to move
 * it", it still couldn't remove either, and /mcp remove rea only forgot a consent. Here the servers are the test
 * fixture, with the pinned version as its last word.
 */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const fixture = path.join(import.meta.dir, "fixtures/mcp-network-server.ts");
const SECRET = "rea-EXAMPLE-token-0123456789";
const server = (version: string, env: Record<string, string> = {}) => ({ command: process.execPath, args: [fixture, `rea-agents@${version}`], env });

async function folders(servers: Record<string, unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-edit-app-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
  return { home, project };
}
const servers = async (home: string) => JSON.parse(await readFile(path.join(home, ".casper/mcp.json"), "utf8")).mcpServers as Record<string, unknown>;

type Step = (tools: RuntimeTool[]) => Promise<void>;

/** An interactive session on the plain terminal: `lines` typed at each prompt, `answers` at each numbered box, and at
 * each request the model runs the next of `steps` with the tools it was offered. */
async function session(home: string, project: string, lines: string[], answers: string[], steps: Step[] = []) {
  const input = new PassThrough();
  let output = "";
  const pending = [...lines];
  const runtime: AgentRuntime = {
    async start(options: RuntimeStartOptions) {
      let tools = options.tools ?? [];
      return {
        setTools: (next: RuntimeTool[]) => { tools = next; },
        prompt: async () => { await steps.shift()?.(tools); },
        abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
      };
    },
    async dispose() {},
  };
  const casper = new CasperApp({
    runtimeFactory: () => runtime, input, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home, platform: "linux" }),
    output: { write: (text) => {
      output += text;
      if (text === "> ") queueMicrotask(() => input.write(`${pending.shift() ?? "/exit"}\n`));
      if (/Type [\d, ]*\d or \d: $/.test(text)) queueMicrotask(() => input.write(`${answers.shift() ?? "1"}\n`));
    } },
  });
  cleanup.push(() => casper.close());
  await casper.runInteractive(project);
  return { casper, output: () => output, answersLeft: answers };
}

test("told it may, the AI removes the duplicate server and updates the pin through Casper's box; the file ends right", async () => {
  const { home, project } = await folders({ rea: server("6.7.0", { REA_TOKEN: SECRET }), "rea-agents": server("6.8.0") });
  const results: Array<{ text: string; isError?: boolean }> = [];
  const call = async (tools: RuntimeTool[], name: string, args: Record<string, unknown>) => {
    const tool = tools.find((item) => item.name === name);
    results.push(tool ? await tool.execute(args) : { text: `${name} not offered`, isError: true });
  };
  const run = await session(home, project, ["you have permission: remove the duplicate rea-agents mcp server and move rea to 6.8.0"], ["3"], [async (tools) => {
    await call(tools, MCP_REMOVE_TOOL, { name: "rea-agents" });
    await call(tools, MCP_ADD_TOOL, { name: "rea", command: process.execPath, args: [fixture, "rea-agents@6.8.0"], replace: true });
  }]);
  // One box, answered "Yes, for this session"; the update after it needed none.
  expect(run.answersLeft).toEqual([]);
  expect(run.output()).toContain([
    "The AI wants to remove an MCP server:",
    "  name     rea-agents",
    "  from     ~/.casper/mcp.json",
    `  runs     ${process.execPath} ${fixture} rea-agents@6.8.0`,
    "It is taken out of ~/.casper/mcp.json and stopped.",
  ].join("\n"));
  expect(run.output()).toContain("Remove rea-agents? → Yes, for this session\n");
  expect(run.output()).toContain("[approval] allowed (this session): Change rea\n");
  expect(run.output()).toContain("[mcp] Removed rea-agents from ~/.casper/mcp.json and stopped it.");
  expect(run.output()).toContain(`[mcp] Changed rea in ~/.casper/mcp.json: it now runs ${process.execPath} ${fixture} rea-agents@6.8.0 (it ran ${process.execPath} ${fixture} rea-agents@6.7.0). Its settings (REA_TOKEN) are kept. Starting it…`);
  expect(results.map((result) => result.isError ?? false)).toEqual([false, false]);
  expect(results[0]!.text).toBe("Removed rea-agents from ~/.casper/mcp.json and stopped it.");
  expect(results[1]!.text).toStartWith("Changed rea in ~/.casper/mcp.json and started it (");
  // The AI and the screen never see the setting's value.
  expect(JSON.stringify(results)).not.toContain(SECRET);
  expect(run.output()).not.toContain(SECRET);
  expect(await servers(home)).toEqual({ rea: { ...server("6.8.0", { REA_TOKEN: SECRET }) } });
  expect(run.casper.mcp!.status().map((item) => [item.name, item.state])).toEqual([["rea", "ready"]]);
}, childTestLimit());

test("without the session answer, each change asks; No changes nothing", async () => {
  const { home, project } = await folders({ rea: server("6.7.0") });
  const results: Array<{ text: string; isError?: boolean }> = [];
  await session(home, project, ["remove the rea mcp server"], ["1"], [async (tools) => {
    results.push(await tools.find((item) => item.name === MCP_REMOVE_TOOL)!.execute({ name: "rea" }));
  }]);
  expect(results).toEqual([{ text: "Not removed: the user said no. Nothing changed.", isError: true }]);
  expect(Object.keys(await servers(home))).toEqual(["rea"]);
}, childTestLimit());

test("/mcp remove takes the server out of the file that defines it and stops it; /mcp forget still only forgets a consent", async () => {
  const { home, project } = await folders({ rea: server("6.7.0", { REA_TOKEN: SECRET }), "rea-agents": server("6.8.0") });
  const run = await session(home, project, ["/mcp remove rea"], []);
  expect(run.output()).toContain("[mcp] Removed rea from ~/.casper/mcp.json and stopped it.\n");
  expect(run.output()).not.toContain("rea was not remembered");
  expect(Object.keys(await servers(home))).toEqual(["rea-agents"]);
  expect(run.casper.mcp!.status().map((item) => item.name)).toEqual(["rea-agents"]);
}, childTestLimit());

test("/mcp update changes what a server runs and keeps its settings; /mcp add of a taken name says how to change it", async () => {
  const { home, project } = await folders({ rea: server("6.7.0", { REA_TOKEN: SECRET }) });
  const run = await session(home, project, [`/mcp add rea ${process.execPath} ${fixture} rea-agents@6.8.0`, `/mcp update rea ${process.execPath} ${fixture} rea-agents@6.8.0`], []);
  expect(run.output()).toContain("[mcp] rea is already a server (~/.casper/mcp.json). To change what it runs: /mcp update rea <command> [args…]. Nothing changed.\n");
  expect(run.output()).toContain("[mcp] Changed rea in ~/.casper/mcp.json: it now runs ");
  expect(await servers(home)).toEqual({ rea: server("6.8.0", { REA_TOKEN: SECRET }) });
}, childTestLimit());

test("a server from another tool's file is not removed here: Casper says where it is and how to remove it", async () => {
  const { home, project } = await folders({});
  await writeFile(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { rea: server("6.7.0") } }));
  const run = await session(home, project, ["/mcp remove rea"], []);
  expect(run.output()).toContain("[mcp] rea is in ~/.claude.json (Claude Code), not one of Casper's files, so Casper didn't change it. Remove it there: claude mcp remove rea.\n");
  expect(JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8")).mcpServers.rea).toBeDefined();
}, childTestLimit());

test("a test call to a server added this session whose tools have no labels: a read-named tool is no change; a write-named one still is", async () => {
  const { home, project } = await folders({ old: { command: process.execPath, args: [fixture, "--mode=unlabeled"], env: {} } });
  const results: string[] = [];
  const call = (tools: RuntimeTool[], id: string) => tools.find((item) => item.name === "call_capability")!.execute({ id, arguments: {} }).then((result) => { results.push(result.text); });
  const run = await session(home, project, ["/mcp connect old", `/mcp add fresh ${process.execPath} ${fixture} --mode=unlabeled`, "test the fresh and old mcp servers"],
    ["2", "2", "2", "2", "2", "2"], [async (tools) => {
    await call(tools, "mcp:fresh:demangle_swift");
    await call(tools, "mcp:fresh:set_breakpoint");
    await call(tools, "mcp:old:demangle_swift");
  }]);
  expect(results.map((text) => text.includes("called "))).toEqual([true, true, true]);
  expect(run.output()).not.toContain("◆ Changed in fresh: demangle_swift");
  expect(run.output()).toContain("◆ Changed in fresh: set_breakpoint");
  // A server that was there before this session is as before: its unlabeled tool may change something.
  expect(run.output()).toContain("◆ Changed in old: demangle_swift");
}, childTestLimit());

test("a server you disconnected in /mcp: casper_session tells the AI so", async () => {
  const { home, project } = await folders({ rea: server("6.7.0") });
  let seen = "";
  await session(home, project, ["/mcp disconnect rea", "why is the rea mcp server not connected"], [], [async (tools) => {
    seen = (await tools.find((item) => item.name === "casper_session")!.execute({ part: "mcp" })).text;
  }]);
  expect(JSON.parse(seen)).toMatchObject({ mcp: [{ name: "rea", connected: false, writes: "off", state: "disconnected by you, in /mcp" }] });
}, childTestLimit());

test("a server from before this session whose tools have no labels: one named as a look (open, overview) is no change row and no Devices row", async () => {
  // From a real v0.4.12 session: rea-agents' open_binary, binary_overview, inspect_macho and binary_session were each
  // "◆ Changed in rea-agents" and a Devices row on the receipt.
  const { home, project } = await folders({ rea: { command: process.execPath, args: [fixture, "--mode=unlabeled"], env: {} } });
  const results: string[] = [];
  const call = (tools: RuntimeTool[], id: string) => tools.find((item) => item.name === "call_capability")!.execute({ id, arguments: {} }).then((result) => { results.push(result.text); });
  const run = await session(home, project, ["/mcp connect rea", "open the binary with the rea mcp server"], ["2", "2", "2", "2"], [async (tools) => {
    await call(tools, "mcp:rea:open_binary");
    await call(tools, "mcp:rea:binary_overview");
    await call(tools, "mcp:rea:set_breakpoint");
  }]);
  expect(results.map((text) => text.includes("called "))).toEqual([true, true, true]);
  expect(run.output()).not.toContain("Changed in rea: open_binary");
  expect(run.output()).not.toContain("Changed in rea: binary_overview");
  expect(run.output()).not.toContain("In rea: open_binary");
  // A name that reads as a change is still one, as is the box for every unlabeled call.
  expect(run.output()).toContain("◆ Changed in rea: set_breakpoint");
}, childTestLimit());

test("the same command again restarts the server, so a tool added to its code is listed; the old one wasn't", async () => {
  // From a real v0.4.12 session: a replace with the same command left the server running its old code (5 tools, not 6).
  const { home, project } = await folders({});
  const list = path.join(home, "tools.json");
  await writeFile(list, JSON.stringify(["get_quote"]));
  const args = [fixture, "--mode=unlabeled", `--tools-file=${list}`];
  await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify({ mcpServers: { catalog: { command: process.execPath, args, env: {} } } }));
  const results: Array<{ text: string; isError?: boolean }> = [];
  const run = await session(home, project, ["/mcp connect catalog", "restart the catalog mcp server so it lists list_model_options"], ["2", "2"], [async (tools) => {
    await writeFile(list, JSON.stringify(["get_quote", "list_model_options"]));
    results.push(await tools.find((item) => item.name === MCP_ADD_TOOL)!.execute({ name: "catalog", command: process.execPath, args, replace: true }));
    results.push(await tools.find((item) => item.name === "call_capability")!.execute({ id: "mcp:catalog:list_model_options", arguments: {} }));
  }]);
  expect(run.output()).toContain(`  runs     ${process.execPath} ${args.join(" ")} (the same: it starts again and lists its tools again)\n`);
  expect(run.output()).toContain("[mcp] catalog runs ");
  expect(run.output()).toContain(", as before, in ~/.casper/mcp.json. Starting it again, so its tools are listed again…");
  expect(results[0]).toEqual({ text: "Restarted catalog in ~/.casper/mcp.json and started it (6 tools · writes off)." });
  expect(results[1]!.text).toContain("called list_model_options");
}, childTestLimit());

test("/mcp update --timeout gives a server longer for each call; /mcp detail says so, and the server keeps running", async () => {
  const { home, project } = await folders({ rea: server("6.8.0", { REA_TOKEN: SECRET }) });
  const run = await session(home, project, ["/mcp connect rea", "/mcp update rea --timeout 5m", "/mcp detail rea", "/mcp update rea --timeout 2h"], ["2"]);
  expect(run.output()).toContain("[mcp] Changed rea in ~/.casper/mcp.json: it waits up to 5m for each call.\n");
  expect(run.output()).toContain("  limits: start 20s · call 5m");
  expect(run.output()).toContain("[mcp] A timeout is a length from 1s to 30m, such as 300s or 5m. Nothing changed.\n");
  expect(await servers(home)).toEqual({ rea: { ...server("6.8.0", { REA_TOKEN: SECRET }), callTimeout: 300 } });
  expect(run.casper.mcp!.status().find((item) => item.name === "rea")).toMatchObject({ state: "ready", limits: { callS: 300 } });
}, childTestLimit());

test("the AI sets a plain variable and a longer time limit through the box, which shows old and new; the file ends right", async () => {
  // From a real v0.4.12 session: replace refused env, so the AI wrote a wrapper script inside an app bundle instead.
  const { home, project } = await folders({ rea: server("6.8.0", { REA_TOKEN: SECRET }) });
  const launcher = "/Users/example/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
  const results: Array<{ text: string; isError?: boolean }> = [];
  const run = await session(home, project, ["/mcp connect rea", "set HOPPER_LAUNCHER_PATH on the rea mcp server and give it 5 minutes"], ["2", "2"], [async (tools) => {
    results.push(await tools.find((item) => item.name === MCP_ADD_TOOL)!.execute({ name: "rea", replace: true, env: { HOPPER_LAUNCHER_PATH: launcher }, timeout: "5m" }));
  }]);
  expect(run.output()).toContain([
    "The AI wants to change an MCP server:",
    "  name     rea",
    "  from     ~/.casper/mcp.json",
    "  settings REA_TOKEN (values hidden)",
    `  runs     ${process.execPath} ${fixture} rea-agents@6.8.0`,
    `  env      HOPPER_LAUNCHER_PATH: not set → ${launcher}`,
    "  timeout  1m30s → 5m for each call",
  ].join("\n"));
  expect(run.output()).toContain("[mcp] Changed rea in ~/.casper/mcp.json: it now sets HOPPER_LAUNCHER_PATH. It waits up to 5m for each call. Starting it…");
  expect(results[0]).toEqual({ text: "Changed rea in ~/.casper/mcp.json and started it (3 tools · writes off)." });
  expect(await servers(home)).toEqual({ rea: { ...server("6.8.0", { REA_TOKEN: SECRET, HOPPER_LAUNCHER_PATH: launcher }), callTimeout: 300 } });
  expect(run.output()).not.toContain(SECRET);
}, childTestLimit());

test("/mcp says when two servers run the same npm package, and which /mcp remove keeps the newest", async () => {
  const { home, project } = await folders({ rea: { command: "npx", args: ["-y", "rea-agents@6.7.0", "mcp"], env: {}, disabled: true },
    "rea-agents": { command: "npx", args: ["-y", "rea-agents@6.8.0", "mcp"], env: {}, disabled: true } });
  const run = await session(home, project, ["/mcp list"], []);
  expect(run.output()).toContain("[mcp] rea (6.7.0) and rea-agents (6.8.0) both run rea-agents, so their tools are loaded twice. To keep the newest: /mcp remove rea.\n");
}, childTestLimit());
