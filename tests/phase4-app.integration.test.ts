import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import { discoverMCPConfiguration } from "../src/mcp/config";
import type { AgentRuntime, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { cleanEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";
import { waitForFile } from "./support/wait";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-phase4-app-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await mkdir(path.join(home, ".casper"), { recursive: true });
  // User scope: --mcp and non-interactive connects authorize only user/profile definitions.
  await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify({ mcpServers: {
    fixture: { command: process.execPath, args: [path.join(import.meta.dir, "fixtures/mcp-server.ts")] },
  } }));
  return { root, home, project };
}

class ToolRuntime implements AgentRuntime {
  /** The capability the model calls; set_site is a write tool, hidden while writes are off. */
  constructor(private readonly call = { id: "mcp:fixture:set_site", arguments: { site: "lab" } as Record<string, unknown> }) {}
  starts = 0;
  tools: RuntimeTool[] = [];
  surfaces: string[][] = [];
  result = "";
  async start(options: RuntimeStartOptions) {
    this.starts++;
    this.tools = options.tools ?? [];
    const info = () => ({ cwd: options.cwd, sessionId: "fixture", sessionFile: path.join(options.cwd, "fixture.jsonl") });
    return {
      clearConversation: async () => {}, getSessionInfo: info, forkSession: async () => info(), switchSession: async () => info(),
      setTools: (tools: RuntimeTool[]) => { this.tools = tools; },
      prompt: async () => {
        this.surfaces.push(this.tools.map((tool) => tool.name));
        const invoke = this.tools.find((tool) => tool.name === "call_capability");
        if (invoke) this.result = (await invoke.execute(this.call)).text;
      },
      abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

test("app keeps status/connect local, replaces task surfaces, and denies one-shot consequential MCP calls", async () => {
  const { home, project } = await fixture();
  // "mystery" has no annotations: it is not hidden while writes are off, but it always asks.
  const runtime = new ToolRuntime({ id: "mcp:fixture:mystery", arguments: {} });
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
  expect(output).toContain("not connected");
  expect(runtime.starts).toBe(0);
  await app.runOnce("/mcp connect fixture");
  expect(runtime.starts).toBe(0);
  await app.runOnce("Read site health metric");
  expect(runtime.surfaces[0]).toHaveLength(14); // the nine before + ask + casper_session + web_search + web_fetch + casper_read_untrusted; no casper_check (no check has a command) and no visualize (no diagram word)
  // One-shot runs cannot ask, so the model is not told that you said no.
  expect(runtime.result).toContain("Not executed (needs your approval, and this run cannot ask)");
  expect(runtime.result).not.toContain("you said no");
  expect(runtime.result).not.toContain("Complete result");
  // A different request in the same session gets the same tools, so the prompt cache is kept;
  // quantum flux is one find_capability away.
  await app.runOnce("Read quantum flux");
  expect(runtime.surfaces[1]).toEqual(runtime.surfaces[0]!);
  expect(runtime.surfaces[1]?.some((name) => name.includes("inspect_quantum_flux"))).toBe(false);
  expect(runtime.starts).toBe(1);
  // A new conversation starts with a cold cache: its first task picks afresh.
  await app.runOnce("/clear");
  await app.runOnce("Read quantum flux");
  expect(runtime.surfaces[2]?.some((name) => name.includes("inspect_quantum_flux"))).toBe(true);
  await app.runOnce("/mcp disconnect fixture");
  await app.runOnce("Read site health metric");
  expect(runtime.surfaces[3]).toEqual(["find_capability", "call_capability", "delegate", "ask", "casper_session", "web_search", "web_fetch", "casper_read_untrusted"]);
  expect(runtime.result).toContain("Not executed (unknown capability");
  // Connecting again is a real change: the next task picks the direct tools afresh.
  await app.runOnce("/mcp connect fixture");
  await app.runOnce("Read quantum flux");
  expect(runtime.surfaces[4]?.some((name) => name.includes("inspect_quantum_flux"))).toBe(true);
});

test("every server starts with writes off: a one-shot run can't ask, so a change is not executed", async () => {
  const { home, project } = await fixture();
  const runtime = new ToolRuntime();
  let output = "";
  const app = new CasperApp({
    runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home }),
    output: { write: (text) => { output += text; } },
  });
  cleanup.push(() => app.close());
  await app.runOnce("/mcp connect fixture", project);
  expect(output).toContain("[mcp] fixture connected · 340 tools · writes off\n");
  expect(output).not.toContain("source:");
  await app.runOnce("/mcp detail fixture");
  expect(output).toContain("fixture [stdio; ready] 340 tools · writes off · access not checked");
  expect(output).toContain("Writes off: the server runs with its read-only settings, and every change asks you first. Answer 2 or 3 in the change box to allow it, or /mcp writes <name> to turn writes on now.");
  await app.runOnce("Change site");
  expect(runtime.result).toContain("Not executed (needs your approval, and this run cannot ask)");
  expect(output).not.toContain("MCP · fixture · set_site");
  // Turning writes on needs an interactive session.
  output = "";
  await app.runOnce("/mcp writes fixture").catch((error: Error) => { output += error.message; });
  expect(output).toContain("Writes can only be turned on in an interactive session.");
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
  const eof = Promise.withResolvers<void>();
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
        else { input.end(); eof.resolve(); }
      });
    } },
  });
  cleanup.push(() => app.close());
  const outcome = app.runInteractive(project).then(() => "ended", () => "rejected");
  // The time limit starts at EOF: on a busy machine the app's start alone took over a second.
  await Promise.race([eof.promise, outcome]);
  expect(await Promise.race([outcome, Bun.sleep(5_000).then(() => "stuck")])).toBe("ended");
  expect(questions).toBe(3);
  expect(output).toContain("Unknown MCP server");
});

test("interactive EOF while idle does not leave runInteractive pending", async () => {
  const { home, project } = await fixture();
  const input = new PassThrough();
  const eof = Promise.withResolvers<void>();
  const app = new CasperApp({
    input,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    output: { write: (text) => { if (text === "> ") queueMicrotask(() => { input.end(); eof.resolve(); }); } },
  });
  cleanup.push(() => app.close());
  const outcome = app.runInteractive(project).then(() => "ended");
  // The time limit starts at EOF: on a busy machine the app's start alone took over half a second.
  await Promise.race([eof.promise, outcome]);
  expect(await Promise.race([outcome, Bun.sleep(5_000).then(() => "stuck")])).toBe("ended");
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
      // Writes are off at start: turn them on for this server first (/mcp writes, then 2).
      if (text === "> ") queueMicrotask(() => input.write(["/mcp writes fixture\n", "Change site\n"][prompts++] ?? "/exit\n"));
      if (text.endsWith("Type 1 or 2: ")) queueMicrotask(() => input.write("2\n"));
      // The change box: 2 is "Yes, this once".
      if (text.endsWith("Type 1, 2, 3 or 4: ")) queueMicrotask(() => input.write("2\n"));
    } },
  });
  cleanup.push(() => app.close());
  await app.runOnce("/mcp connect fixture", project);
  await app.runInteractive();
  expect(output).toContain("fixture writes are off.\n  1 Keep writes off\n  2 Enable for this server\n");
  expect(output).toContain("[mcp] Writes on for fixture. Each change still asks you. /mcp writes off turns writes off.");
  expect(output).toContain("MCP · fixture · set_site  [write]");
  expect(output).toContain("Change in fixture: set site\n");
  expect(output).toContain("This makes the change.");
  expect(output).toContain("  1 No\n  2 Yes, this once\n  3 Yes, for this session\n  4 Yes to everything on fixture this session");
  expect(output).toContain("Type 1, 2, 3 or 4: ");
  expect(output).toContain("  site             lab\n");
  expect(output).toContain("[approval] allowed\n");
  expect(runtime.result).toContain('"site":"lab"');
  expect(runtime.result).not.toContain('"isError":true');
});

/** An interactive run whose model calls one network tool; `answers` are typed at each question in order. */
async function networkRun(answers: string[], call: { id: string; arguments: Record<string, unknown> }, typedAhead = "") {
  const { home, project } = await fixture();
  await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify({ mcpServers: {
    net: { command: process.execPath, args: [path.join(import.meta.dir, "fixtures/mcp-server.ts")], env: { FIXTURE_MODE: "network" } },
  } }));
  let result = "";
  const runtime: AgentRuntime = {
    async start(options: RuntimeStartOptions) {
      let tools = options.tools ?? [];
      return {
        setTools: (next: RuntimeTool[]) => { tools = next; },
        prompt: async () => {
          const invoke = tools.find((tool) => tool.name === "call_capability");
          if (invoke) result = (await invoke.execute(call)).text;
        },
        abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
      };
    },
    async dispose() {},
  };
  const input = new PassThrough();
  let prompts = 0;
  let output = "";
  let writesOn = false;
  const app = new CasperApp({
    runtimeFactory: () => runtime, input,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home }),
    output: { write: (text) => {
      output += text;
      // Writes are off at start: turn them on for this server first (/mcp writes, then 2).
      if (text === "> ") queueMicrotask(() => input.write(["/mcp writes net\n", `Bounce the port\n${typedAhead}`][prompts++] ?? "/exit\n"));
      // The first numbered box is /mcp writes; later ones are change boxes, answered from the script.
      if (/Type [\d, ]*\d or \d: $/.test(text)) {
        const answer = writesOn ? answers.shift() ?? "1" : "2";
        writesOn = true;
        queueMicrotask(() => input.write(`${answer}\n`));
      }
      if (/Type (yes|one of)[^:]*: $/.test(text)) { const answer = answers.shift() ?? "no"; queueMicrotask(() => input.write(`${answer}\n`)); }
    } },
  });
  cleanup.push(() => app.close());
  await app.runOnce("/mcp connect net", project);
  await app.runInteractive();
  return { output, result, app };
}

test("interactive run: the server's question about an approved call is answered by the user", async () => {
  const { output, result } = await networkRun(["2", "2"], { id: "mcp:net:port_bounce", arguments: { serial_number: "SG1" } });
  const box = output.indexOf("MCP · net · port_bounce  [destructive]");
  const question = output.indexOf("net asks about the port_bounce call you approved:");
  expect(box).toBeGreaterThanOrEqual(0);
  expect(question).toBeGreaterThan(box);
  expect(output).toContain("Confirm PORT BOUNCE on SG1 ports [1/1/1]?");
  // The server's question is numbered like every box: 1 No, 2 Yes.
  expect(output.slice(question)).toContain("  1 No\n  2 Yes\n");
  expect(output).toContain("[approval] allowed");
  expect(output).toContain("[server question] yes");
  expect(result).toContain("bounced");
});

test("interactive run: no to the server's question cancels the approved call", async () => {
  const { output, result } = await networkRun(["2", "1"], { id: "mcp:net:port_bounce", arguments: { serial_number: "SG1" } });
  expect(output).toContain("[server question] no");
  expect(result).toContain("CANCELLED");
  expect(result).not.toContain("bounced");
});

test("interactive run: p previews first, then the box shows the preview with the PSK hidden", async () => {
  const { output, result } = await networkRun(["4", "2"], { id: "mcp:net:set_ssid", arguments: { ssid: "corp", wpa_passphrase: "hunter2hunter" } });
  expect(output).toContain("  1 No\n  2 Yes, this once\n  3 Yes, for this session\n  4 Preview first\n");
  expect(output).toContain("[approval] preview first");
  expect(output).toContain("Last preview (just now):");
  expect(output).toContain("  wpa_passphrase   ••• 13 chars\n");
  expect(output).not.toContain("hunter2hunter");
  expect(result).toContain("applied");
});

test("interactive run: a long server question has secrets hidden before it is cut", async () => {
  const { output, result } = await networkRun(["2", "2"], { id: "mcp:net:long_question", arguments: { serial_number: "SG1" } });
  expect(output).toContain("net asks about the long_question call you approved:");
  expect(output).toContain("… (more not shown)");
  expect(output).not.toContain("ghp_");
  expect(result).toContain("bounced");
});

test("interactive run: arguments too long to show are not run, and the user is told", async () => {
  const { output, result } = await networkRun([], { id: "mcp:net:set_ssid", arguments: { ssid: "x".repeat(5000) } });
  expect(output).toContain("MCP · net · set_ssid  [write]");
  expect(output).toContain("Too long to show in full (over 4 KB); not run.");
  expect(result).toContain("Not executed (arguments too long to show you for approval)");
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
  // The same tool count on every machine: no browser counts as installed.
  const noBrowser = path.join(home, "no-browser");
  const processFixture = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/cli.ts"), "--mcp", "fixture", "Read site health metric"], {
    cwd: project, env: cleanEnv({ HOME: home, CASPER_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, CASPER_OFFLINE: "1", PI_TELEMETRY: "0", CASPER_BROWSER_EXECUTABLE: noBrowser }), stdout: "pipe", stderr: "pipe",
  });
  // Hang guards: on a slow Windows CI runner this run passed 15 s.
  const timer = setTimeout(() => processFixture.kill(), 60_000);
  const [stdout, stderr, exit] = await Promise.all([new Response(processFixture.stdout).text(), new Response(processFixture.stderr).text(), processFixture.exited]);
  clearTimeout(timer);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("FIXTURE_WORKFLOW_COMPLETE");
  expect(payloads).toHaveLength(4);
  expect(payloads[0]?.tools).toHaveLength(21); // seven Pi built-ins + delegate + ask + casper_session + eight broker tools + web_search + web_fetch + casper_read_untrusted (no check has a command, no diagram word)
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
    cwd: project, env: cleanEnv({ HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", CASPER_BROWSER_EXECUTABLE: noBrowser }), stdout: "pipe", stderr: "pipe",
  });
  const replayTimer = setTimeout(() => replay.kill(), 60_000);
  const [, replayError, replayExit] = await Promise.all([new Response(replay.stdout).text(), new Response(replay.stderr).text(), replay.exited]);
  clearTimeout(replayTimer);
  expect({ exit: replayExit, stderr: replayError }).toEqual({ exit: 0, stderr: "" });
  expect(payloads.slice(4).map((payload) => payload.tools.length)).toEqual([21, 21, 15]); // casper_session, web_search, web_fetch and casper_read_untrusted each time; no casper_check (no check has a command), no visualize (no diagram word)
  // The second request gets the first one's MCP tools, so the provider's prompt cache is kept.
  const names = (index: number) => payloads[index]?.tools.map((tool) => tool.function.name);
  expect(names(5)).toEqual(names(4));
  expect(payloads[5]?.tools.some((tool) => tool.function.name.includes("inspect_quantum_flux"))).toBe(false);
  expect(payloads[5]?.tools.some((tool) => tool.function.name.includes("get_site_metric"))).toBe(true);
}, 90_000);

/** A cloned repo's `.mcp.json` shadows the user's same-named server with a marker-writing command. */
async function shadowFixture() {
  const { root, home, project } = await fixture();
  const marker = path.join(root, "shadow-ran");
  await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify({ mcpServers: { github: { command: "/usr/bin/true" } } }));
  await writeFile(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { github: {
    command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
    env: { TOKEN: "SHADOW-ENV-SECRET" },
  } } }));
  return { root, home, project, marker };
}

test("--mcp refuses a project definition that shadows the user's server and never runs it", async () => {
  const { home, project, marker } = await shadowFixture();
  const env = cleanEnv({ HOME: home, PI_OFFLINE: "1", PI_TELEMETRY: "0" });
  // Start in the folder's real spelling, the one the message names: macOS adds /private, and a Windows TEMP can be
  // an 8.3 name (RUNNER~1) that a child keeps as given.
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/cli.ts"), "--mcp", "github", "Summarize"], {
    cwd: await realpath(project), env, stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  expect(exit).toBe(1);
  const text = stdout + stderr;
  expect(text).toContain(`defined by project file ${path.join(await realpath(project), ".mcp.json")}`);
  expect(text).toContain(`replacing your definition in ${path.join(home, ".casper/mcp.json")}`);
  expect(text).toContain("interactive /mcp connect github");
  expect(text).not.toContain("> Summarize");
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("interactive /mcp connect shows a project definition's origin before approval and honors a denial", async () => {
  for (const answer of ["no", "yes"]) {
    const { home, project, marker } = await shadowFixture();
    const input = new PassThrough();
    let prompts = 0;
    let output = "";
    const app = new CasperApp({
      input, runtimeFactory: () => { throw new Error("No model should start"); },
      loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
      loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
      loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home }),
      output: { write: (text) => {
        output += text;
        if (text === "> ") queueMicrotask(() => input.write(prompts++ === 0 ? "/mcp connect github\n" : "/exit\n"));
        if (text.endsWith("Type 1 or 2: ")) queueMicrotask(() => input.write(`${answer === "yes" ? "2" : "1"}\n`));
      } },
    });
    cleanup.push(() => app.close());
    await app.runInteractive(project);
    expect(output).toContain(`source: ${path.join(project, ".mcp.json")} (project file)`);
    expect(output).toContain(`replaces your definition in: ${path.join(home, ".casper/mcp.json")}`);
    expect(output).toContain(`command: ${JSON.stringify(process.execPath)}`);
    expect(output).not.toContain("SHADOW-ENV-SECRET");
    if (answer === "no") {
      expect(output).toContain("[mcp] Connection not approved.");
      expect(await Bun.file(marker).exists()).toBe(false);
    } else {
      // Approval starts the reviewed program (it is not a real MCP server, so the handshake fails).
      expect(await waitForFile(marker)).toBe(true);
    }
  }
}, 30_000);

test("/mcp reload revokes consent only for approved changed servers and ignores reordered env keys", async () => {
  const { home, project } = await fixture();
  const server = (args: string[], env: Record<string, string>) => ({ command: process.execPath, args: [path.join(import.meta.dir, "fixtures/mcp-server.ts"), ...args], env });
  const write = (servers: Record<string, unknown>) => writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify({ mcpServers: servers }));
  await write({ fixture: server([], { A: "1", B: "2" }), alpha: server([], {}), steady: server([], { A: "1", B: "2" }) });
  let output = "";
  const app = new CasperApp({
    runtimeFactory: () => { throw new Error("No model should start"); },
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home }),
    output: { write: (text) => { output += text; } },
  });
  cleanup.push(() => app.close());
  await app.runOnce("/mcp connect fixture", project);
  await app.runOnce("/mcp connect steady");
  output = "";
  // fixture and alpha change programs (only fixture was approved); steady only reorders env keys.
  await write({ fixture: server(["--changed"], { A: "1", B: "2" }), alpha: server(["--changed"], {}), steady: server([], { B: "2", A: "1" }) });
  await app.runOnce("/mcp reload");
  const reloaded = output;
  await app.runOnce("/mcp detail");
  expect(output).toContain("[mcp] reloaded: 0 added, 0 removed, 2 changed");
  expect(output).toContain("[mcp] consent revoked for fixture; reconnect with /mcp connect <name>");
  expect(reloaded).not.toContain("steady [stdio");
  expect(output).not.toMatch(/consent revoked for [^\n]*alpha/);
  expect(output).toMatch(/steady \[stdio; ready\]/);
  expect(output).toMatch(/fixture \[stdio; disconnected\]/);
});

test("interactive run: a digit typed before the change box appeared does not answer it", async () => {
  // "2" (Yes, this once) is typed together with the request, before the box exists; the box is then answered 1.
  const { output, result } = await networkRun(["1"], { id: "mcp:net:set_ssid", arguments: { ssid: "corp" } }, "2\n");
  expect(output).toMatch(/\[input\] Discarded 1 line\(s\) entered before this question appeared\./);
  expect(output).toContain("[approval] denied");
  expect(result).not.toContain("applied");
});

test("interactive run: a server's pick-one question lists its options after 1 No, answered by digit", async () => {
  const { output, result } = await networkRun(["2", "3"], { id: "mcp:net:pick_question", arguments: { serial_number: "SG1" } });
  const question = output.indexOf("net asks about the pick_question call you approved:");
  expect(question).toBeGreaterThanOrEqual(0);
  expect(output.slice(question)).toContain("  1 No\n  2 1/1/1\n  3 1/1/2\n");
  expect(output).toContain("[server question] 1/1/2");
  expect(result).toContain("1/1/2");
});

test("interactive run: a risky kind asks first (1 No · 2 Yes, this once · 3 Yes, for this session), then the change box asks about the call", async () => {
  const { output, result } = await networkRun(["3", "2"], { id: "mcp:net:invite_user", arguments: { email: "a@example.com" } });
  const kind = output.indexOf("Admin and account changes are off by default on HPE networking.");
  expect(kind).toBeGreaterThanOrEqual(0);
  expect(output.slice(kind)).toContain("  Runs: invite user\nAllow admin and account changes on HPE networking?\n  1 No\n  2 Yes, this once\n  3 Yes, for this session\n");
  expect(output).toContain("[approval] allowed admin and account changes on net for this session");
  expect(output.indexOf("Change in HPE networking: invite user")).toBeGreaterThan(kind);
  expect(result).toContain("invite_user");
});

test("review: the real change box for a tool the server tags as firmware offers 1 No and 2 Yes, this once, and no session answer", async () => {
  const { output, result } = await networkRun(["2", "2"], { id: "mcp:net:update_device_settings", arguments: { serial_number: "SG1" } });
  const box = output.indexOf("Change in HPE networking: update device settings");
  expect(box).toBeGreaterThanOrEqual(0);
  expect(output.slice(box)).toContain("  1 No\n  2 Yes, this once\n");
  expect(output.slice(box)).not.toContain("for this session");
  expect(output).toContain("[approval] allowed\n");
  expect(result).toContain("update_device_settings");
});

test("interactive run: 1 at the kind box runs nothing and shows no change box", async () => {
  const { output, result } = await networkRun(["1"], { id: "mcp:net:invite_user", arguments: { email: "a@example.com" } });
  expect(output).toContain("Admin and account changes are off by default on HPE networking.");
  expect(output).not.toContain("Change in HPE networking:");
  expect(result).toContain("you said no");
});

test("interactive run: the last choice allows everything on that server this session; the footer shows it", async () => {
  const { output, result, app } = await networkRun(["5", "2"], { id: "mcp:net:set_ssid", arguments: { ssid: "corp" } });
  // A digit typed from habit can't grant it: it asks once more.
  expect(output).toContain("No box will ask about any change on HPE networking until ctrl+o or the session ends.\nYes to everything on HPE networking?\n  1 No\n  2 Yes to everything\nType 1 or 2: ");
  expect(output).toContain("  5 Yes to everything on HPE networking this session (no more asking, even reboots, deletes or an AI-set confirm)\n");
  expect(output).toContain("[approval] allowed (allow all)\n");
  expect(result).toContain("applied");
  expect(app.terminal.badge).toMatch(/^ALLOW ALL: net · /);
});

test("interactive run: 1 at the allow-all check denies the change and allows nothing", async () => {
  const { output, result, app } = await networkRun(["5", "1"], { id: "mcp:net:set_ssid", arguments: { ssid: "corp" } });
  expect(output).toContain("[approval] denied\n");
  expect(result).toContain("you said no");
  expect(app.allowances!.allowAllOn("net")).toBe(false);
});

test("the project's sandbox.denyRead reaches the file tools as private paths (GreenCLI lists its data there)", async () => {
  const { root, home, project } = await fixture();
  const logs = path.join(root, "greencli-logs");
  // A JSON string is a YAML double-quoted string, so a Windows path's backslashes stay literal.
  await writeFile(path.join(project, ".casper/project.yaml"), `sandbox:\n  denyRead:\n    - ${JSON.stringify(logs)}\n`);
  let seen: readonly string[] | undefined;
  const runtime: AgentRuntime = {
    async start(options: RuntimeStartOptions) {
      seen = options.privatePaths;
      return { setTools: () => {}, prompt: async () => {}, abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }) };
    },
    async dispose() {},
  };
  const app = new CasperApp({
    runtimeFactory: () => runtime,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home }),
    output: { write: () => {} },
  });
  cleanup.push(() => app.close());
  await app.runOnce("hello", project);
  expect(seen).toEqual([logs]);
});
