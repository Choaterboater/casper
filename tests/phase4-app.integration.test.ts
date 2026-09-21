import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import { discoverMCPConfiguration } from "../src/mcp/config";
import type { AgentRuntime, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-phase4-app-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper/mcp.json"), JSON.stringify({ mcpServers: {
    fixture: { command: process.execPath, args: [path.join(import.meta.dir, "fixtures/mcp-server.ts")] },
  } }));
  return { root, home, project };
}

class ToolRuntime implements AgentRuntime {
  starts = 0;
  tools: RuntimeTool[] = [];
  surfaces: string[][] = [];
  result = "";
  async start(options: RuntimeStartOptions) {
    this.starts++;
    this.tools = options.tools ?? [];
    return {
      setTools: (tools: RuntimeTool[]) => { this.tools = tools; },
      prompt: async () => {
        this.surfaces.push(this.tools.map((tool) => tool.name));
        const invoke = this.tools.find((tool) => tool.name === "call_capability");
        if (invoke) this.result = (await invoke.execute({ id: "mcp:fixture:set_site", arguments: { site: "lab" } })).text;
      },
      abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

test("app keeps status/connect local, replaces task surfaces, and denies one-shot consequential MCP calls", async () => {
  const { home, project } = await fixture();
  const runtime = new ToolRuntime();
  let output = "";
  const app = new CasperApp({
    runtimeFactory: () => runtime,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home }),
    output: { write: (text) => { output += text; } },
  });
  cleanup.push(() => app.close());
  await app.runOnce("/mcp", project);
  expect(output).toContain("disconnected");
  expect(runtime.starts).toBe(0);
  await app.runOnce("/mcp connect fixture");
  expect(output).toContain("340 tools");
  expect(runtime.starts).toBe(0);
  await app.runOnce("Read site health metric");
  expect(runtime.surfaces[0]).toHaveLength(9);
  expect(runtime.result).toContain("requires explicit interactive confirmation");
  await app.runOnce("Read quantum flux");
  expect(runtime.surfaces[1]).toHaveLength(4);
  expect(runtime.surfaces[1]?.some((name) => name.includes("inspect_quantum_flux"))).toBe(true);
  expect(runtime.starts).toBe(1);
  await app.runOnce("/mcp disconnect fixture");
  await app.runOnce("Read site health metric");
  expect(runtime.surfaces[2]).toEqual(["find_capability", "call_capability", "delegate"]);
  expect(runtime.result).toContain("unavailable");
});

test("closing during a lazy runtime factory drains it without starting a late model session", async () => {
  const { home, project } = await fixture();
  let release!: (runtime: AgentRuntime) => void;
  let entered!: () => void;
  const factoryEntered = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<AgentRuntime>((resolve) => { release = resolve; });
  let starts = 0;
  let disposals = 0;
  const app = new CasperApp({
    runtimeFactory: () => { entered(); return pending; },
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    output: { write: () => {} },
  });
  cleanup.push(() => app.close());
  const prompt = app.runOnce("Hello", project).then(() => "completed", () => "cancelled");
  await factoryEntered;
  const closing = app.close();
  release({ start: async () => { starts++; throw new Error("Must not start"); }, dispose: async () => { disposals++; } });
  await closing;
  expect(await prompt).toBe("cancelled");
  expect(starts).toBe(0);
  expect(disposals).toBe(1);
});

test("interactive MCP errors leave the session usable, and EOF ends the input loop", async () => {
  const { home, project } = await fixture();
  const input = new PassThrough();
  let questions = 0;
  let output = "";
  const app = new CasperApp({
    input, runtimeFactory: () => { throw new Error("No model should start"); },
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home }),
    output: { write: (text) => {
      output += text;
      if (text === "> ") queueMicrotask(() => {
        const next = ["/mcp connect nonexistent", "/mcp"][questions++];
        if (next) input.write(next + "\n");
        else input.end();
      });
    } },
  });
  cleanup.push(() => app.close());
  const outcome = app.runInteractive(project).then(() => "ended", () => "rejected");
  expect(await Promise.race([outcome, Bun.sleep(1000).then(() => "stuck")])).toBe("ended");
  expect(questions).toBe(3);
  expect(output).toContain("Unknown MCP server");
  expect(output).toContain("fixture [stdio; disconnected]");
});

test("interactive EOF while idle does not leave runInteractive pending", async () => {
  const { home, project } = await fixture();
  const input = new PassThrough();
  const app = new CasperApp({
    input,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    output: { write: (text) => { if (text === "> ") queueMicrotask(() => input.end()); } },
  });
  cleanup.push(() => app.close());
  expect(await Promise.race([app.runInteractive(project).then(() => "ended"), Bun.sleep(500).then(() => "stuck")])).toBe("ended");
});

test("interactive approval shows exact arguments and permits only an explicit yes", async () => {
  const { home, project } = await fixture();
  const runtime = new ToolRuntime();
  const input = new PassThrough();
  let prompts = 0;
  let output = "";
  const app = new CasperApp({
    runtimeFactory: () => runtime, input,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home }),
    output: { write: (text) => {
      output += text;
      if (text === "> ") queueMicrotask(() => input.write(prompts++ === 0 ? "Change site\n" : "/exit\n"));
      if (text.includes("Type yes:")) queueMicrotask(() => input.write("yes\n"));
    } },
  });
  cleanup.push(() => app.close());
  await app.runOnce("/mcp connect fixture", project);
  await app.runInteractive();
  expect(output).toContain('MCP confirmation: "mcp:fixture:set_site" [write]');
  expect(output).toContain('Arguments: {"site":"lab"}');
  expect(runtime.result).toContain('"site":"lab"');
  expect(runtime.result).not.toContain('"isError":true');
});

test("real CLI and Pi adapter send a small surface and complete search/schema/call via a local model protocol fixture", async () => {
  const { home, project } = await fixture();
  const payloads: { tools: { function: { name: string } }[]; messages: { role: string; content: unknown }[] }[] = [];
  const steps = [
    { name: "find_capability", arguments: { query: "quantum flux", id: "" } },
    { name: "find_capability", arguments: { id: "mcp:fixture:inspect_quantum_flux", query: "" } },
    { name: "call_capability", arguments: { id: "mcp:fixture:inspect_quantum_flux", arguments: { site: "lab" } } },
  ];
  const model = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => {
      payloads.push(await request.json());
      const step = steps[payloads.length - 1];
      const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({
        id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`;
      const content = step ? chunk({ role: "assistant", tool_calls: [{
        index: 0, id: `call_${payloads.length}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.arguments) },
      }] }, null) + chunk({}, "tool_calls") : chunk({ role: "assistant", content: "FIXTURE_WORKFLOW_COMPLETE" }, "stop");
      return new Response(content + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  cleanup.push(async () => { model.stop(true); });
  const agentDir = path.join(home, ".pi/agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [{ id: "fixture" }],
  } } }));
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false } }));
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture" }));
  const processFixture = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/cli.ts"), "--mcp", "fixture", "Read site health metric"], {
    cwd: project, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => processFixture.kill(), 15_000);
  const [stdout, stderr, exit] = await Promise.all([new Response(processFixture.stdout).text(), new Response(processFixture.stderr).text(), processFixture.exited]);
  clearTimeout(timer);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("FIXTURE_WORKFLOW_COMPLETE");
  expect(payloads).toHaveLength(4);
  expect(payloads[0]?.tools).toHaveLength(16); // seven Pi built-ins + delegate + eight broker tools
  expect(JSON.stringify(payloads[0]?.tools)).not.toContain("inspect_quantum_flux");
  expect(payloads[0]?.tools.map((tool) => tool.function.name)).toContain("find_capability");
  expect(JSON.stringify(payloads[2]?.messages)).toContain("inputSchema");
  expect(JSON.stringify(payloads[3]?.messages)).toContain("inspect_quantum_flux");
  expect(JSON.stringify(payloads[3]?.messages)).toContain("Complete result");

  // Exercise replacement in the same real Pi session (not only initial registration).
  const harness = path.join(home, "two-tasks.ts");
  await writeFile(harness, `import { CasperApp } from ${JSON.stringify(path.join(import.meta.dir, "../src/app.ts"))};
const app = new CasperApp();
try {
  await app.runOnce('/mcp connect fixture');
  await app.runOnce('Read site health metric');
  await app.runOnce('Read quantum flux');
  await app.runOnce('/mcp disconnect fixture');
  await app.runOnce('Read site health metric');
} finally { await app.close(); }
`);
  const replay = Bun.spawn([process.execPath, harness], {
    cwd: project, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, stdout: "pipe", stderr: "pipe",
  });
  const replayTimer = setTimeout(() => replay.kill(), 10_000);
  const [, replayError, replayExit] = await Promise.all([new Response(replay.stdout).text(), new Response(replay.stderr).text(), replay.exited]);
  clearTimeout(replayTimer);
  expect({ exit: replayExit, stderr: replayError }).toEqual({ exit: 0, stderr: "" });
  expect(payloads.slice(4).map((payload) => payload.tools.length)).toEqual([16, 11, 10]);
  expect(payloads[5]?.tools.some((tool) => tool.function.name.includes("inspect_quantum_flux"))).toBe(true);
  expect(payloads[5]?.tools.some((tool) => tool.function.name.includes("get_site_metric"))).toBe(false);
}, 30_000);
