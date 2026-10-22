import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import type { AgentRuntime, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { removeTempDir } from "./support/temp-dir";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/** A placeholder network: no real site, host or address. */
const GRAPH = {
  type: "flowchart", title: "Example site network",
  nodes: [{ id: "isp", label: "ISP 192.0.2.1" }, { id: "core", label: "core-1" }, { id: "sw1", label: "sw1", group: "Floor 1" }],
  edges: [{ from: "isp", to: "core", label: "1/1/1" }, { from: "core", to: "sw1", label: "1/1/2 10G" }],
};

class DiagramRuntime implements AgentRuntime {
  tools: RuntimeTool[] = [];
  results: Array<{ text: string; isError?: boolean }> = [];
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.tools = options.tools ?? [];
    return {
      prompt: async (text) => {
        const tool = this.tools.find((tool) => tool.name === "visualize");
        if (tool && text.includes("- intent: visualize")) this.results.push(await tool.execute({ graph: GRAPH }));
      },
      setTools: (tools) => { this.tools = tools; },
      abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
  note(index = 0): string[] { return JSON.parse(this.results[index]!.text).data.notes; }
}

async function session(options: { config?: string; interactive?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-diagram-page-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, "index.ts"), 'import "./util";\n');
  await writeFile(path.join(project, "util.ts"), "export const one = 1;\n");
  if (options.config) await writeFile(path.join(home, ".casper", "config.yaml"), options.config);
  const runtime = new DiagramRuntime();
  const output: string[] = [];
  const opened: string[] = [];
  const app = new CasperApp({
    runtimeFactory: () => runtime, output: { write: (text) => { output.push(text); } }, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    pageSeams: { desktop: () => true, open: (url) => { opened.push(url); return true; } },
  });
  cleanup.push(() => app.close());
  await app.start(project);
  if (options.interactive !== false) app.interactive = true;
  return { app, runtime, opened, text: () => output.join("") };
}

test("in a session a diagram opens in the browser as a page Casper makes from it, and the model is told so", async () => {
  const { app, runtime, opened, text } = await session();
  await app.runOnce("draw a diagram of the example site network");
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/diagram-example-site-network\.html$/);
  expect(text()).toContain(`[page] diagram-example-site-network → ${opened[0]}`);
  expect(runtime.note()).toContain(`Shown in the user's browser as page diagram-example-site-network (${opened[0]}); don't make a page for it.`);
  const html = await readFile(path.join(app.pages!.directory, "diagram-example-site-network.html"), "utf8");
  expect(html).toContain('<pre class="mermaid">');
  expect(html).toContain("core-1");
  // The same diagram again replaces the page and its open tab reloads: no second window.
  await app.runOnce("draw the diagram of the example site network again");
  expect(opened).toHaveLength(1);
  expect(text()).toContain("[page] diagram-example-site-network updated →");
});

test("open_pages: off saves the page and prints its link without opening it; outputDir: false makes no page", async () => {
  const closed = await session({ config: "open_pages: off\n" });
  await closed.app.runOnce("draw a diagram of the example site network");
  expect(closed.opened).toEqual([]);
  expect(closed.text()).toMatch(/\[page\] diagram-example-site-network → http:\/\/127\.0\.0\.1:\d+\/diagram-example-site-network\.html/);
  expect(closed.runtime.note().some((note) => note.startsWith("Saved as page diagram-example-site-network (") && note.endsWith("), not opened: opening pages is off."))).toBe(true);

  const kept = await session({ config: "visualize:\n  outputDir: false\n" });
  await kept.app.runOnce("draw a diagram of the example site network");
  expect(kept.opened).toEqual([]);
  expect(kept.text()).not.toContain("[page]");
  expect(kept.runtime.note().join("\n")).not.toContain("page");
});

test("a run nobody watches (one-shot) makes no diagram page; /visualize repo in a session opens one", async () => {
  const oneShot = await session({ interactive: false });
  await oneShot.app.runOnce("draw a diagram of the example site network");
  expect(oneShot.opened).toEqual([]);
  expect(oneShot.text()).not.toContain("[page]");
  expect(oneShot.runtime.note()).not.toContainEqual(expect.stringContaining("browser"));

  const repo = await session();
  await repo.app.runOnce("/visualize repo");
  expect(repo.opened).toHaveLength(1);
  expect(repo.opened[0]).toMatch(/\/diagram-project-module-dependencies\.html$/);
  expect(repo.text()).toContain("[page] diagram-project-module-dependencies →");
});
