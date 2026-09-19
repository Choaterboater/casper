import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import { discoverLSPConfiguration } from "../src/lsp/config";
import type { AgentRuntime, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-lsp-app-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await mkdir(home);
  await writeFile(path.join(project, "a.ts"), "old();");
  await writeFile(path.join(project, ".casper/lsp.json"), JSON.stringify({ lspServers: { fixture: {
    command: process.execPath, args: [path.join(import.meta.dir, "fixtures/lsp-server.ts")], languages: { ".ts": "typescript" },
  } } }));
  return { home, project };
}
class ToolRuntime implements AgentRuntime {
  tools: RuntimeTool[] = [];
  result?: { text: string; isError?: boolean };
  options?: RuntimeStartOptions;
  starts = 0;
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.starts++;
    this.options = options;
    this.tools = options.tools ?? [];
    return {
      prompt: async () => {
        const tool = this.tools.find((tool) => tool.name === "lsp");
        if (tool) this.result = await tool.execute({ server: "fixture", operation: "rename", path: "a.ts", line: 0, character: 1, newName: "new" });
      },
      setTools: (tools) => { this.tools = tools; },
      abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

test("LSP local commands stay lazy; one-shot rename denied; disconnect removes tool", async () => {
  const { home, project } = await fixture();
  const runtime = new ToolRuntime();
  const app = new CasperApp({ runtimeFactory: () => runtime, output: { write: () => {} },
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: () => discoverLSPConfiguration({ projectRoot: project, homeDir: home }),
  });
  cleanup.push(() => app.close());
  await app.runOnce("/lsp", project);
  await app.runOnce("/lsp connect fixture");
  expect(runtime.starts).toBe(0);
  await app.runOnce("Rename old to new");
  expect(runtime.result?.isError).toBe(true);
  expect(runtime.result?.text).toContain("not approved");
  expect(await readFile(path.join(project, "a.ts"), "utf8")).toBe("old();");
  await writeFile(path.join(project, "a.ts"), "BROKEN");
  expect(await runtime.options!.afterFileEdit!("a.ts")).toContain("fixture error");
  await app.runOnce("/lsp disconnect fixture");
  await app.runOnce("Read project");
  expect(runtime.tools.some((tool) => tool.name === "lsp")).toBe(false);
});

test("interactive rename displays exact edits and requires yes", async () => {
  const { home, project } = await fixture();
  const input = new PassThrough();
  const runtime = new ToolRuntime();
  let prompts = 0;
  let output = "";
  const app = new CasperApp({ runtimeFactory: () => runtime, input,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: () => discoverLSPConfiguration({ projectRoot: project, homeDir: home }),
    output: { write: (text) => {
      output += text;
      if (text === "> ") queueMicrotask(() => input.write(prompts++ === 0 ? "Rename old\n" : "/exit\n"));
      if (text.includes("Type yes:")) queueMicrotask(() => input.write("yes\n"));
    } },
  });
  cleanup.push(() => app.close());
  await app.runOnce("/lsp connect fixture", project);
  await app.runInteractive();
  expect(output).toContain("LSP rename confirmation");
  expect(output).toContain('"newText":"new"');
  expect(runtime.result?.isError).not.toBe(true);
  expect(await readFile(path.join(project, "a.ts"), "utf8")).toBe("new();");
});

test("real CLI/Pi tool surface appends LSP diagnostics to native writes before the next model request", async () => {
  const { home, project } = await fixture();
  const payloads: { tools: { function: { name: string } }[]; messages: unknown[] }[] = [];
  const steps = [
    { name: "lsp", arguments: { server: "fixture", operation: "symbols", path: "a.ts" } },
    { name: "write", arguments: { path: "a.ts", content: "BROKEN" } },
    { name: "write", arguments: { path: "a.ts", content: "old();" } },
    { name: "lsp", arguments: { server: "fixture", operation: "rename", path: "a.ts", line: 0, character: 0, newName: "new" } },
  ];
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    payloads.push(await request.json());
    const step = steps[payloads.length - 1];
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const content = step ? chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${payloads.length}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] }, null) + chunk({}, "tool_calls") : chunk({ role: "assistant", content: "LSP_WORKFLOW_COMPLETE" }, "stop");
    return new Response(content + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(async () => { model.stop(true); });
  const agentDir = path.join(home, ".pi/agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", apiKey: "local-test", models: [{ id: "fixture" }] } } }));
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false } }));
  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/cli.ts"), "--lsp", "fixture", "Inspect and modify a.ts"], {
    cwd: project, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 20_000);
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("LSP_WORKFLOW_COMPLETE");
  expect(payloads[0].tools.filter((tool) => tool.function.name === "lsp")).toHaveLength(1);
  expect(JSON.stringify(payloads[2].messages)).toContain("LSP diagnostics after edit");
  expect(JSON.stringify(payloads[2].messages)).toContain("fixture error");
  expect(JSON.stringify(payloads.at(-1)!.messages)).toContain("Rename not approved");
  expect(await readFile(path.join(project, "a.ts"), "utf8")).toBe("old();");

  // Repeat through the actual interactive CLI to exercise Pi's mutation queues
  // and exact human confirmation, not just an injected runtime seam.
  payloads.splice(0);
  const interactive = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/cli.ts"), "--lsp", "fixture"], {
    cwd: project, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const interactiveTimer = setTimeout(() => interactive.kill(), 20_000);
  let transcript = "";
  let prompted = false;
  let approved = false;
  let exited = false;
  const outputWork = (async () => {
    const reader = interactive.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      transcript += decoder.decode(chunk.value, { stream: true });
      if (!prompted && transcript.endsWith("> ")) { prompted = true; interactive.stdin.write("Inspect and modify a.ts\n"); }
      if (!approved && transcript.includes("Apply this exact rename? Type yes:")) { approved = true; interactive.stdin.write("yes\n"); }
      if (!exited && transcript.includes("LSP_WORKFLOW_COMPLETE") && transcript.endsWith("> ")) { exited = true; interactive.stdin.write("/exit\n"); }
    }
  })();
  const [, interactiveError, interactiveExit] = await Promise.all([outputWork, new Response(interactive.stderr).text(), interactive.exited]);
  clearTimeout(interactiveTimer);
  expect({ exit: interactiveExit, stderr: interactiveError }).toEqual({ exit: 0, stderr: "" });
  expect(approved).toBe(true);
  expect(transcript).toContain('"newText":"new"');
  expect(await readFile(path.join(project, "a.ts"), "utf8")).toBe("new();");
  expect(JSON.stringify(payloads.at(-1)!.messages)).toContain('changed');
}, 50_000);
