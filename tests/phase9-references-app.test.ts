import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { ProjectMemory } from "../src/memory/store";
import { projectStateDirectory } from "../src/project/model";
import { discoverReferenceConfiguration } from "../src/references/config";
import { SkillRegistry } from "../src/skills/registry";
import type { AgentRuntime, RuntimeSessionInfo, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(configured = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-reference-app-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const reference = path.join(root, "reference");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await mkdir(reference);
  await writeFile(path.join(reference, "README.md"), "UNREQUESTED_REFERENCE_BODY\nMCP routing keeps schemas small.\n");
  const config = JSON.stringify({ references: { router: { path: reference, paths: ["README.md"] } } });
  if (configured) await writeFile(path.join(home, ".casper/references.yaml"), config);
  // Project-owned metadata must not authorize an external reference read.
  await writeFile(path.join(project, ".casper/references.yaml"), config);
  return { root, home, project, reference };
}

class ReferenceRuntime implements AgentRuntime {
  starts = 0;
  tools: RuntimeTool[] = [];
  captured?: RuntimeTool;
  result = "";
  promptText = "";
  systemText = "";
  async start(options: RuntimeStartOptions) {
    this.starts++;
    this.tools = options.tools ?? [];
    this.systemText = options.systemPromptAppend ?? "";
    return {
      setTools: (tools: RuntimeTool[]) => { this.tools = tools; },
      prompt: async (text: string) => {
        this.promptText = text;
        this.captured = this.tools.find((tool) => tool.name === "search_references");
        if (this.captured) this.result = (await this.captured.execute({ source: "router", query: "MCP routing" })).text;
      },
      abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}
function appFor(home: string, runtime: AgentRuntime, output: (text: string) => void) {
  const app = new CasperApp({
    runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: (context) => discoverReferenceConfiguration({ homeDir: home, profileName: context.profileName }),
    output: { write: output },
  });
  cleanup.push(() => app.close());
  return app;
}

test("reference listing/search are local and do not create model tasks or memory outcomes", async () => {
  const { home, project, reference } = await fixture();
  const runtime = new ReferenceRuntime();
  let output = "";
  const app = appFor(home, runtime, (text) => { output += text; });
  await app.runOnce("/references", project);
  expect(runtime.starts).toBe(0);
  expect(output).toContain("router");
  expect(output).not.toContain("UNREQUESTED_REFERENCE_BODY");
  await app.runOnce("/references search router MCP routing");
  expect(runtime.starts).toBe(0);
  expect(output).toContain('"file":"README.md","line":2');
  expect(output).toContain("MCP routing keeps schemas small.");
  expect(output).toContain("Current repository");
  expect(await new ProjectMemory(projectStateDirectory(project, home)).outcomes()).toEqual([]);
  expect(await readFile(path.join(reference, "README.md"), "utf8")).toBe("UNREQUESTED_REFERENCE_BODY\nMCP routing keeps schemas small.\n");
});

test("a configured model tool returns advisory excerpts on demand and is revoked on close", async () => {
  const { home, project } = await fixture();
  const runtime = new ReferenceRuntime();
  const app = appFor(home, runtime, () => {});
  await app.runOnce("Look for an existing routing pattern", project);
  expect(runtime.tools.map((tool) => tool.name)).toContain("search_references");
  expect(runtime.promptText + runtime.systemText).not.toContain("UNREQUESTED_REFERENCE_BODY");
  expect(runtime.promptText + runtime.systemText).not.toContain("MCP routing keeps schemas small.");
  expect(runtime.result).toContain("MCP routing keeps schemas small.");
  expect(runtime.result).toContain("untrusted examples");
  expect(runtime.result).toContain("Current repository");
  const [outcome] = await new ProjectMemory(projectStateDirectory(project, home)).outcomes();
  expect(outcome?.verification).toBe("not-run");
  expect(outcome?.accepted).toBeNull();
  await app.close();
  expect((await runtime.captured!.execute({ query: "routing" })).isError).toBe(true);
});

test("project files alone expose no reference tool and absent references do not block ordinary coding", async () => {
  const { home, project } = await fixture(false);
  const runtime = new ReferenceRuntime();
  let output = "";
  const app = appFor(home, runtime, (text) => { output += text; });
  await app.runOnce("/references search * routing", project);
  expect(runtime.starts).toBe(0);
  expect(output).toContain("No reference sources configured");
  await app.runOnce("Inspect this repository");
  expect(runtime.starts).toBe(1);
  expect(runtime.tools.map((tool) => tool.name)).not.toContain("search_references");
  expect(runtime.result).toBe("");
  await expect(app.runOnce("/references search")).rejects.toThrow("Usage:");
  await app.runOnce("/project");
  expect(runtime.starts).toBe(1);
});

test("named-session rebinding reloads source metadata and revokes the old captured tool", async () => {
  const { home, project, root } = await fixture();
  const other = path.join(root, "other-reference");
  await mkdir(other);
  await writeFile(path.join(other, "README.md"), "MCP routing NEW_REFERENCE\n");
  const file = path.join(home, "main.jsonl");
  await writeFile(file, "fixture");
  let info: RuntimeSessionInfo = { cwd: project, sessionId: "main", sessionFile: file };
  let tools: RuntimeTool[] = [];
  const captured: RuntimeTool[] = [];
  const results: string[] = [];
  const runtime: AgentRuntime = {
    start: async (options) => {
      tools = options.tools ?? [];
      return {
        getSessionInfo: () => ({ ...info }), getState: () => ({ cwd: info.cwd, isStreaming: false }),
        forkSession: async (options) => {
          const child = path.join(home, "child.jsonl");
          await writeFile(child, "fixture");
          await writeFile(path.join(home, ".casper/references.yaml"), JSON.stringify({ references: { router: { path: other, paths: ["README.md"] } } }));
          info = { cwd: options.cwd, sessionId: "child", sessionFile: child };
          return { ...info };
        },
        switchSession: async (options) => { info = { ...info, sessionFile: options.sessionFile, cwd: options.cwd ?? info.cwd }; return { ...info }; },
        setTools: (next) => { tools = next; }, appendContext: async () => {},
        prompt: async () => {
          const tool = tools.find((entry) => entry.name === "search_references")!;
          captured.push(tool);
          results.push((await tool.execute({ query: "MCP routing" })).text);
        },
        abort: async () => {}, subscribe: () => () => {},
      };
    }, dispose: async () => {},
  };
  const input = new PassThrough();
  let step = 0;
  const app = new CasperApp({
    runtimeFactory: () => runtime, input, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: () => discoverReferenceConfiguration({ homeDir: home }),
    output: { write: (text) => {
      if (text.includes("Type yes:")) queueMicrotask(() => input.write("yes\n"));
      if (text === "> ") queueMicrotask(() => input.write(["/branch alternate", "Search again", "/exit"][step++]! + "\n"));
    } },
  });
  cleanup.push(() => app.close());
  await app.runOnce("Search first", project);
  await app.runInteractive();
  expect(results).toHaveLength(2);
  expect(results[0]).toContain("keeps schemas small");
  expect(results[1]).toContain("NEW_REFERENCE");
  expect((await captured[0]!.execute({ query: "routing" })).isError).toBe(true);
  expect((await captured[1]!.execute({ query: "routing" })).isError).not.toBe(true);
});

async function cli(project: string, home: string, prompt: string) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/cli.ts"), prompt], {
    cwd: project, env: { ...process.env, HOME: home, CASPER_PROFILE: "default", PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  } finally { clearTimeout(timer); child.kill(); }
}

test("real CLI local reference search works without model configuration or credentials", async () => {
  const { home, project } = await fixture();
  const result = await cli(project, home, "/references search router MCP routing");
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).toContain('"file":"README.md","line":2');
  expect(result.stdout).not.toContain("UNREQUESTED_REFERENCE_BODY");
});

test("reference CLI and model output escape terminal controls without altering excerpts", async () => {
  const { home, project, reference } = await fixture();
  const excerpt = "MCP routing \u007f\u0085\u009b31m\u009dignored\u009c\u202e\u001b[0m";
  await writeFile(path.join(reference, "README.md"), excerpt + "\n");
  const result = await cli(project, home, "/references search router MCP routing");
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const unsafe = (text: string) => [...text].filter((char) => /[\u001b\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(char)).map((char) => char.codePointAt(0));
  expect(unsafe(result.stdout)).toEqual([]);
  const searchResult = result.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line))
    .find(value => Array.isArray(value.matches));
  expect(searchResult.matches[0].excerpt).toBe(excerpt);
  const runtime = new ReferenceRuntime();
  const app = appFor(home, runtime, () => {});
  await app.runOnce("Find the configured routing example", project);
  expect(unsafe(runtime.result)).toEqual([]);
  expect(JSON.parse(runtime.result).matches[0].excerpt).toBe(excerpt);
});

test("pinned Pi receives only requested excerpts with provenance from the real read-only tool", async () => {
  const { home, project } = await fixture();
  const payloads: Array<{ tools: Array<{ function: { name: string } }>; messages: unknown[] }> = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    payloads.push(await request.json());
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({
      id: "reference-fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    const body = payloads.length === 1
      ? chunk({ role: "assistant", tool_calls: [{ index: 0, id: "reference_call", type: "function", function: {
        name: "search_references", arguments: JSON.stringify({ source: "router", query: "MCP routing" }),
      } }] }, null) + chunk({}, "tool_calls")
      : chunk({ role: "assistant", content: "REFERENCE_FIXTURE_COMPLETE" }, "stop");
    return new Response(body + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(async () => { provider.stop(true); });
  const agentDir = path.join(home, ".pi/agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [{ id: "fixture" }],
  } } }));
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false } }));
  await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture" }));
  const result = await cli(project, home, "Find the configured reference's MCP routing example; do not change files.");
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).toContain("REFERENCE_FIXTURE_COMPLETE");
  expect(payloads).toHaveLength(2);
  expect(payloads[0]?.tools.map((tool) => tool.function.name)).toContain("search_references");
  expect(JSON.stringify(payloads[0]?.messages)).not.toContain("MCP routing keeps schemas small.");
  expect(JSON.stringify(payloads[1]?.messages)).toContain("MCP routing keeps schemas small.");
  expect(JSON.stringify(payloads[1]?.messages)).toContain("Current repository");
  expect(JSON.stringify(payloads[1]?.messages)).toContain("sha256");
  expect(JSON.stringify(payloads)).not.toContain("UNREQUESTED_REFERENCE_BODY");
}, 15_000);
