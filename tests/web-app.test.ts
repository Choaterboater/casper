import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadConfiguration } from "../src/config/load";
import { loadProjectContext } from "../src/project/context";
import { observationInput } from "../src/runtime/observation";
import type { AgentRuntime, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { formatToolActivity } from "../src/tui/format";
import type { WebHttpRequest } from "../src/web/lookup";
import { removeTempDir } from "./support/temp-dir";
import { settingsCommand } from "../src/app/command-loop";
import { duringTask } from "../src/tui/give-way";
import { useTheme } from "../src/tui/theme";

/** Web lookups as a session offers them: on by default with no question, off with web: off in your own config. */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

async function folders() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-web-app-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  return { home, project };
}

async function session(home: string, project: string, onPrompt: (tools: RuntimeTool[]) => Promise<void> = async () => {}) {
  let tools: RuntimeTool[] = [];
  const requests: WebHttpRequest[] = [];
  let picks = 0;
  const runtime: AgentRuntime = {
    async start(options) {
      tools = options.tools ?? [];
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: () => () => {}, abort: async () => {}, setTools: (next) => { tools = next; },
        prompt: async () => { await onPrompt(tools); },
      };
    },
    async dispose() {},
  };
  let output = "";
  const app = new CasperApp({
    output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    verificationMode: "off",
    webSeams: {
      dns: async () => [{ address: "93.184.215.14", family: 4 }],
      http: async (request) => { requests.push(request); return new Response("<p>Install with bun add x</p>", { headers: { "content-type": "text/html" } }); },
    },
  });
  app.terminal.pick = async () => { picks++; return undefined; };
  return { app, tools: () => tools, requests, picks: () => picks, text: () => output };
}

test("web_search and web_fetch are offered by default, never ask, and read through the checks", async () => {
  const { home, project } = await folders();
  let result: { text: string; isError?: boolean } | undefined;
  const run = await session(home, project, async (tools) => {
    result = await tools.find((tool) => tool.name === "web_fetch")!.execute({ url: "http://docs.example.com/install" });
  });
  await run.app.runOnce("How do I install x? Look it up.", project);
  const names = run.tools().map((tool) => tool.name);
  expect(names).toContain("web_search");
  expect(names).toContain("web_fetch");
  expect(result?.isError).toBeUndefined();
  expect(result?.text).toContain("Install with bun add x");
  expect(result?.text).toContain("untrusted data from docs.example.com");
  expect(run.requests.map((request) => `${request.url.href} @${request.address.address}`)).toEqual(["https://docs.example.com/install @93.184.215.14"]);
  expect(run.picks()).toBe(0);
  await run.app.runOnce("/status");
  expect(run.text()).toContain(" web       on (DuckDuckGo) · /settings turns it off\n");
  await run.app.close();
});

test("/settings typed during a task never stops that task's web lookups: the theme leaves them alone, web off waits for the next task", async () => {
  const { home, project } = await folders();
  const results: { text: string; isError?: boolean }[] = [];
  let answers: string[] = [];
  const run = await session(home, project, async (tools) => {
    const fetch = tools.find((tool) => tool.name === "web_fetch")!;
    // /theme, then /settings web off, typed while this task runs; its web tool keeps working until it ends.
    run.app.interactive = true;
    Object.defineProperty(run.app.terminal, "canAsk", { get: () => true, configurable: true });
    run.app.terminal.pick = async () => answers.shift();
    answers = ["Light"];
    await duringTask(() => settingsCommand(run.app, "Theme"));
    results.push(await fetch.execute({ url: "http://docs.example.com/install" }));
    answers = ["Web lookups", "Turn them off", "Done"];
    await duringTask(() => settingsCommand(run.app));
    results.push(await fetch.execute({ url: "http://docs.example.com/install" }));
    run.app.interactive = false;
  });
  try {
    await run.app.runOnce("How do I install x? Look it up.", project);
    expect(results.map((result) => result.isError)).toEqual([undefined, undefined]);
    expect(results.every((result) => result.text.includes("Install with bun add x"))).toBe(true);
    expect(run.text()).toContain("[settings] Web lookups: off. Saved in ~/.casper/config.yaml. The running task keeps what it had; your next request uses it.\n");
    expect(run.app.web).toBeUndefined();
  } finally { useTheme(undefined); await run.app.close(); }
});

test("web: off in your own config takes both tools away", async () => {
  const { home, project } = await folders();
  await writeFile(path.join(home, ".casper", "config.yaml"), "web: off\n");
  const run = await session(home, project);
  await run.app.runOnce("How do I install x?", project);
  expect(run.tools().map((tool) => tool.name).filter((name) => name.startsWith("web_"))).toEqual([]);
  await run.app.runOnce("/status");
  expect(run.text()).toContain(" web       off (/settings turns it on)\n");
  await run.app.close();
});

test("web: loads from your config and a profile; a project file is refused", async () => {
  const { home, project } = await folders();
  const previous = process.env.CASPER_PROFILE;
  delete process.env.CASPER_PROFILE;
  try {
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).web).toEqual({ enabled: true, provider: "duckduckgo" });
    await writeFile(path.join(home, ".casper", "config.yaml"), "web:\n  enabled: false\n");
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).web.enabled).toBe(false);
    await writeFile(path.join(home, ".casper", "config.yaml"), "web:\n  provider: brave\n");
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).web).toEqual({ enabled: true, provider: "brave" });
    await writeFile(path.join(home, ".casper", "config.yaml"), "web:\n  provider: searxng\n  searxngUrl: http://127.0.0.1:8888\n");
    expect((await loadConfiguration({ projectRoot: project, homeDir: home })).web).toEqual({ enabled: true, provider: "searxng", searxngUrl: "http://127.0.0.1:8888/" });
    await writeFile(path.join(home, ".casper", "config.yaml"), "web:\n  provider: searxng\n");
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("needs web.searxngUrl");
    await writeFile(path.join(home, ".casper", "config.yaml"), "web:\n  provider: google\n");
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("web.provider must be duckduckgo, brave or searxng");
    await writeFile(path.join(home, ".casper", "config.yaml"), "web: on\n");
    await writeFile(path.join(project, ".casper", "project.yaml"), "web: on\n");
    await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("web is a user setting (~/.casper/config.yaml); a project cannot turn web lookups on or off");
  } finally {
    if (previous === undefined) delete process.env.CASPER_PROFILE; else process.env.CASPER_PROFILE = previous;
  }
});

test("tool lines show the web address or the search", () => {
  const fetch = observationInput({ url: "https://docs.example.com/install" });
  expect(formatToolActivity({ type: "tool_end", toolName: "web_fetch", input: fetch, isError: false }, 1200)).toBe("✓ web_fetch · docs.example.com/install · 1.2s");
  expect(formatToolActivity({ type: "tool_start", toolName: "web_search", input: observationInput({ query: "bun html rewriter", count: 3 }) })).toBe("• web_search · bun html rewriter");
});
