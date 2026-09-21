import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import type { AgentRuntime, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture(projectYaml?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-viz-app-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await mkdir(path.join(project, "auth"));
  await mkdir(home);
  await writeFile(path.join(project, "auth/login.ts"), 'import { verify } from "./verify";\nimport { session } from "../session";\n');
  await writeFile(path.join(project, "auth/verify.ts"), "export const verify = () => true;\n");
  await writeFile(path.join(project, "session.ts"), 'import "./auth/verify";\nexport const session = 1;\n');
  if (projectYaml) await writeFile(path.join(project, ".casper/project.yaml"), projectYaml);
  return { home, project };
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else entries[path.relative(dir, full)] = await readFile(full, "utf8");
    }
  };
  await walk(dir);
  return entries;
}

class ToolRuntime implements AgentRuntime {
  tools: RuntimeTool[] = [];
  surfaces: string[][] = [];
  results: Array<{ text: string; isError?: boolean }> = [];
  prompts: string[] = [];
  options?: RuntimeStartOptions;
  /** Model-authored graph the fake runtime submits when the visualize tool is present. */
  args: Record<string, unknown> = { graph: {
    type: "flowchart", title: "Authentication flow",
    nodes: [{ id: "login", label: "auth/login.ts", group: "auth" }, { id: "verify", label: "auth/verify.ts", group: "auth" }, { id: "session", label: "session.ts" }],
    edges: [{ from: "login", to: "verify", label: "verify()" }, { from: "login", to: "session" }, { from: "session", to: "verify" }],
  } };
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.options = options;
    this.tools = options.tools ?? [];
    return {
      prompt: async (text) => {
        this.prompts.push(text);
        this.surfaces.push(this.tools.map((tool) => tool.name));
        const tool = this.tools.find((tool) => tool.name === "visualize");
        if (tool) this.results.push(await tool.execute(this.args));
      },
      setTools: (tools) => { this.tools = tools; },
      abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

function makeApp(runtime: ToolRuntime, home: string, output: string[] = []) {
  const app = new CasperApp({
    runtimeFactory: () => runtime, output: { write: (text) => { output.push(text); } },
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
  });
  cleanup.push(() => app.close());
  return app;
}

test("acceptance: 'map out the authentication flow' yields a visual, saves artifacts outside the workspace, and leaves code untouched", async () => {
  const { home, project } = await fixture();
  const runtime = new ToolRuntime();
  const output: string[] = [];
  const app = makeApp(runtime, home, output);
  await app.start(project);
  expect(output.join("")).not.toContain(" visualize ");
  await app.runOnce("/visualize");
  expect(output.join("")).toContain(`providers: mermaid, mindmesh\nartifacts: ${path.join(home, ".casper", "visualizations", "project")}`);
  const before = await snapshot(project);

  await app.runOnce("map out the authentication flow");
  expect(runtime.surfaces).toEqual([["delegate", "visualize"]]);
  expect(runtime.prompts[0]).toContain("- intent: visualize");
  expect(runtime.prompts[0]).toContain("- mode: read");
  const result = JSON.parse(runtime.results[0]!.text);
  expect(runtime.results[0]!.isError).toBeUndefined();
  expect(result.isError).toBe(false);
  expect(result.data.primary.provider).toBe("mermaid");
  expect(result.data.primary.content).toContain('title: "Authentication flow"');
  expect(result.data.primary.content).toContain("-->|verify()|");
  expect(result.data.artifacts.map((artifact: { provider: string }) => artifact.provider)).toEqual(["mermaid", "mindmesh"]);
  expect(result.data.notes).toEqual(["Visualization is read-only; it does not authorize code changes."]);

  const outputDir = path.join(home, ".casper", "visualizations", "project");
  for (const artifact of result.data.artifacts as Array<{ path: string; bytes: number }>) {
    expect(path.dirname(artifact.path)).toBe(await realpath(outputDir));
    expect(Buffer.byteLength(await readFile(artifact.path, "utf8"))).toBe(artifact.bytes);
  }
  const mindmesh = JSON.parse(await readFile(result.data.artifacts[1].path, "utf8"));
  expect(mindmesh.schemaVersion).toBe(6);
  expect(mindmesh.title).toBe("Authentication flow");
  expect(Object.keys(mindmesh.nodes)).toHaveLength(3);

  // The code workspace is byte-identical, including no stray .casper artifacts.
  expect(await snapshot(project)).toEqual(before);

  // Ordinary prompts do not carry the visualization tool.
  await app.runOnce("explain how login works");
  expect(runtime.surfaces[1]).toEqual(["delegate"]);
  expect(runtime.results).toHaveLength(1);
});

test("invalid model-authored graphs fail closed inside the tool without touching the session", async () => {
  const { home, project } = await fixture("visualize:\n  outputDir: false\n");
  const runtime = new ToolRuntime();
  runtime.args = { graph: { type: "flowchart", title: "Broken", nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "missing" }] } };
  const output: string[] = [];
  const app = makeApp(runtime, home, output);
  await app.start(project);
  expect(output.join("")).not.toContain(" visualize ");
  await app.runOnce("/visualize");
  expect(output.join("")).toContain("artifacts: disabled (in-conversation only)");
  await app.runOnce("draw a flowchart of login");
  expect(runtime.results[0]!.isError).toBe(true);
  expect(JSON.parse(runtime.results[0]!.text).data.error).toContain('unknown node "missing"');
  // The project-model cache lives under ~/.casper; no visualization artifacts must appear beside it.
  expect(await readdir(path.join(home, ".casper"))).not.toContain("visualizations");
});

test("/visualize is local and read-only; /visualize repo renders a dependency graph without a model", async () => {
  const { home, project } = await fixture("visualize:\n  providers: [mermaid]\n");
  const runtime = new ToolRuntime();
  const output: string[] = [];
  const app = makeApp(runtime, home, output);
  await app.start(project);
  output.length = 0;
  await app.runOnce("/visualize");
  expect(output.join("")).toBe([
    "> /visualize\n",
    `providers: mermaid\nartifacts: ${path.join(home, ".casper", "visualizations", "project")}\nVisualization is read-only and never modifies the workspace.\n`,
  ].join(""));

  output.length = 0;
  const before = await snapshot(project);
  await app.runOnce("/visualize repo auth");
  const text = output.join("");
  expect(text).toContain('title: "project/auth module dependencies"');
  expect(text).toContain('n0["login.ts"]');
  expect(text).toContain("n0 --> n1");
  expect(text).toContain("[visualize] Scanned 2 files at file granularity.");
  expect(text).toContain("[visualize] 1 relative import(s) could not be resolved to a scanned file.");
  expect(text).toMatch(/\[visualize\] wrote .*auth-module-dependencies\.mermaid\.mmd \(\d+ bytes\)/);
  expect(runtime.prompts).toHaveLength(0);
  expect(runtime.options).toBeUndefined();
  expect(await snapshot(project)).toEqual(before);
  expect(await readdir(path.join(home, ".casper", "visualizations", "project"))).toHaveLength(1);

  await expect(app.runOnce("/visualize repo auth extra")).rejects.toThrow("Usage: /visualize | /visualize repo [directory]");
  await expect(app.runOnce("/visualize bogus")).rejects.toThrow("Usage: /visualize");
  await expect(app.runOnce("/visualize repo ../")).rejects.toThrow("inside the project");
});

test("project configuration cannot redirect artifact writes", async () => {
  const { home, project } = await fixture("visualize:\n  outputDir: /tmp/elsewhere\n");
  const runtime = new ToolRuntime();
  const app = makeApp(runtime, home);
  await expect(app.start(project)).rejects.toThrow("visualize.outputDir may only be set in global or profile configuration");
});

test("regression: closing during /visualize repo cancels the scan instead of writing artifacts afterwards", async () => {
  const { home, project } = await fixture();
  await mkdir(path.join(project, "many"));
  for (let index = 0; index < 400; index++) await writeFile(path.join(project, `many/f${index}.ts`), `import "./f${(index + 1) % 400}";\n`);
  const runtime = new ToolRuntime();
  const app = makeApp(runtime, home);
  await app.start(project);
  const work = app.runOnce("/visualize repo many");
  const closed = app.close();
  await expect(work).rejects.toThrow("Visualization cancelled");
  await closed;
  await expect(readdir(path.join(home, ".casper", "visualizations", "project"))).rejects.toThrow(/ENOENT/);
});
