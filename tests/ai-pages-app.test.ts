import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { pageToolFor } from "../src/app/pages";
import { runSettings, settingRows, type SettingsHost } from "../src/app/settings";
import { loadConfiguration } from "../src/config/load";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import type { AgentRuntime, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { runsDuringWork } from "../src/tui/commands";
import { FULL_HELP_TEXT } from "../src/tui/help";
import { removeTempDir } from "./support/temp-dir";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class CaptureRuntime implements AgentRuntime {
  tools: RuntimeTool[] = [];
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.tools = options.tools ?? [];
    return { prompt: async () => {}, clearConversation: async () => {}, setTools: (tools) => { this.tools = tools; }, abort: async () => {}, subscribe: () => () => {},
      getState: () => ({ cwd: options.cwd, isStreaming: false }) };
  }
  async dispose() {}
}

async function folders(config?: string) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-ai-pages-app-")));
  cleanups.push(() => removeTempDir(base));
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(path.join(project, ".casper"), { recursive: true });
  if (config !== undefined) await writeFile(path.join(home, ".casper", "config.yaml"), config);
  return { home, project };
}

async function app(config?: string) {
  const { home, project } = await folders(config);
  const runtime = new CaptureRuntime();
  let text = "";
  const opened: string[] = [];
  const casper = new CasperApp({
    runtimeFactory: () => runtime, output: { write: (chunk) => { text += chunk; } }, sessionHomeDir: home, verificationMode: "off",
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    pageSeams: { desktop: () => true, open: (url) => { opened.push(url); return true; } },
  });
  cleanups.push(() => casper.close());
  await casper.runOnce("Compare Postgres and SQLite for this app", project);
  return { casper, runtime, home, project, opened, text: () => text, clear: () => { text = ""; } };
}

const PAGE = "<!doctype html><title>x</title><body><p>Postgres</p></body>";

test("casper_page is offered by default; ai_pages: off takes it out of the AI's tool list, so it costs nothing", async () => {
  const on = await app();
  expect(on.runtime.tools.map((tool) => tool.name)).toContain("casper_page");
  const off = await app("ai_pages: off\n");
  expect(off.runtime.tools.map((tool) => tool.name)).not.toContain("casper_page");
});

test("/pages lists this project's pages with their links, opens one in the browser and removes one; it runs during a task", async () => {
  const run = await app();
  run.casper.interactive = true;
  await run.casper.handleSlashCommand("/pages");
  expect(run.text()).toContain("[pages] No pages for this project yet.");
  const tool = run.runtime.tools.find((candidate) => candidate.name === "casper_page")!;
  const made = await tool.execute({ name: "db-options", html: PAGE });
  expect(made.text).toContain("It is open in the user's browser.");
  expect(run.opened).toHaveLength(1);
  expect(run.text()).toMatch(/\[page\] db-options → http:\/\/127\.0\.0\.1:\d+\/db-options\.html\n/);
  const saved = path.join(run.home, ".casper", "pages");
  expect(await readFile(path.join(saved, (await readdir(saved))[0]!, "db-options.html"), "utf8")).toContain("<p>Postgres</p>");

  run.clear();
  await run.casper.handleSlashCommand("/pages");
  expect(run.text()).toMatch(/^Pages \(.+\):\n {2}db-options {15}http:\/\/127\.0\.0\.1:\d+\/db-options\.html\n/);
  run.clear();
  await run.casper.handleSlashCommand("/pages open db-options");
  expect(run.text()).toMatch(/^\[page\] db-options → http:\/\/127\.0\.0\.1:\d+\/db-options\.html\n$/);
  expect(run.opened).toHaveLength(2);
  run.clear();
  await run.casper.handleSlashCommand("/pages open missing");
  expect(run.text()).toBe("[pages] No page missing. /pages lists them.\n");
  run.clear();
  await run.casper.handleSlashCommand("/pages remove db-options");
  expect(run.text()).toBe("[pages] Removed db-options.\n");
  run.clear();
  await run.casper.handleSlashCommand("/pages open ../etc");
  expect(run.text()).toContain("must be 1-40");
  for (const line of ["/pages", "/pages list", "/pages open db-options", "/pages remove db-options"]) expect(runsDuringWork(line)).toBe(true);
});

test("after /clear the next page brings the guide again: the new conversation never saw it", async () => {
  const run = await app();
  run.casper.interactive = true;
  const first = run.runtime.tools.find((candidate) => candidate.name === "casper_page")!;
  expect((await first.execute({ name: "a", html: PAGE })).text).toContain("Guide for later pages");
  expect((await first.execute({ name: "b", html: PAGE })).text).not.toContain("Guide for later pages");
  run.casper.interactive = false; // a one-shot /clear: no saved workspace to update
  await run.casper.handleSlashCommand("/clear");
  const next = pageToolFor(run.casper)!;
  expect(next).not.toBe(first);
  expect((await next.execute({ name: "c", html: PAGE })).text).toContain("Guide for later pages");
});

test("a one-shot run saves the page and prints the file's address; nothing opens", async () => {
  const run = await app();
  const tool = run.runtime.tools.find((candidate) => candidate.name === "casper_page")!;
  const made = await tool.execute({ name: "report", html: PAGE });
  expect(made.text).toContain("not opened: a one-shot run");
  expect(run.text()).toMatch(/\[page\] report → file:\/\/.+report\.html\n/);
  expect(run.opened).toEqual([]);
});

test("ai_pages and open_pages are your own settings: on or off in your config, never in a project file", async () => {
  const { home, project } = await folders("ai_pages: off\nopen_pages: off\n");
  const load = () => loadConfiguration({ projectRoot: project, homeDir: home });
  expect(await load()).toMatchObject({ aiPages: false, openPages: false });
  await writeFile(path.join(project, ".casper", "project.yaml"), "ai_pages: on\n");
  await expect(load()).rejects.toThrow("ai_pages is a user setting");
  await writeFile(path.join(project, ".casper", "project.yaml"), "open_pages: on\n");
  await expect(load()).rejects.toThrow("open_pages is a user setting");
  await writeFile(path.join(project, ".casper", "project.yaml"), "{}\n");
  await writeFile(path.join(home, ".casper", "config.yaml"), "ai_pages: sometimes\n");
  await expect(load()).rejects.toThrow("ai_pages must be on or off");
});

test("/settings: Pages the AI makes and Open pages in the browser are on by default; a pick writes ai_pages or open_pages", async () => {
  const { home, project } = await folders();
  let context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  const rows = settingRows(context);
  expect(rows.find((row) => row.label === "Pages the AI makes")!.value).toBe("on");
  expect(rows.find((row) => row.label === "Open pages in the browser")!.value).toBe("on");
  const answers = ["Pages the AI makes", "Turn them off", "Open pages in the browser", "Turn them off", "Done"];
  const asked: string[] = [];
  const host: SettingsHost = {
    output: { write: () => {} }, homeDir: () => home, canAsk: true, context: async () => context,
    reload: async () => { context = await loadProjectContext(await inspectProject(project), { homeDir: home }); },
    ask: async (question) => { asked.push(question); return answers.shift(); },
  };
  await runSettings(host);
  expect(asked[1]).toContain("costs no tokens");
  expect(asked[3]).toContain("prints the link only");
  expect(await readFile(path.join(home, ".casper", "config.yaml"), "utf8")).toBe("ai_pages: false\nopen_pages: false\n");
  expect(context).toMatchObject({ aiPages: false, openPages: false });
  expect(FULL_HELP_TEXT).toContain("/pages open <name>");
  expect(FULL_HELP_TEXT).toContain("pages the AI makes, open pages in the browser");
});
