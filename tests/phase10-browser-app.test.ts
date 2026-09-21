import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import type { AgentRuntime, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class ScriptedRuntime implements AgentRuntime {
  tools: RuntimeTool[] = [];
  starts = 0;
  options?: RuntimeStartOptions;
  action: () => Promise<void> = async () => {};
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.starts++; this.tools = options.tools ?? []; this.options = options;
    return { prompt: async () => this.action(), setTools: tools => { this.tools = tools; },
      abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }) };
  }
  async dispose() {}
}
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-browser-app-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), project = path.join(root, "project"); await mkdir(home); await mkdir(project);
  const runtime = new ScriptedRuntime(), output: string[] = [];
  const app = new CasperApp({ runtimeFactory: () => runtime, output: { write: text => { output.push(text); } },
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ homeDir: home, projectRoot: context.info.root }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  cleanup.push(() => app.close());
  await app.start(project);
  return { app, runtime, output, root, home, project };
}

const browserTest = existsSync(process.env.CASPER_BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? test : test.skip;

browserTest("Casper reports a reproduced browser fix and stops its owned development server after the task", async () => {
  const f = await fixture();
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
  const url = `http://127.0.0.1:${probe.port}`; await probe.stop(true);
  const html = (fixed: boolean) => `<!doctype html><h1 id="result">${fixed ? "Working" : "Broken"}</h1>`;
  await writeFile(path.join(f.project, "index.html"), html(false));
  await writeFile(path.join(f.project, "dev.ts"), 'Bun.serve({hostname:"127.0.0.1",port:Number(process.env.PORT),fetch:()=>new Response(Bun.file("index.html"),{headers:{"content-type":"text/html","cache-control":"no-store"}})});');
  await writeFile(path.join(f.project, "package.json"), JSON.stringify({ scripts: { dev: `${process.execPath} dev.ts` } }));
  let captured: RuntimeTool | undefined;
  f.runtime.action = async () => {
    captured = f.runtime.tools.find(tool => tool.name === "browser");
    const invoke = async (args: Record<string, unknown>) => {
      const result = await captured!.execute(args); expect(result.isError).toBeUndefined(); return JSON.parse(result.text).data;
    };
    await invoke({ action: "serve", script: "dev", url, impact: "local-test", reason: "Synthetic fixture" });
    const baseline = await invoke({ action: "check", scenario: { name: "Heading regression", url, steps: [],
      scope: { inputs: ["index.html"] }, assertions: [{ kind: "text", selector: "#result", expected: "Working" }] } });
    expect(baseline.status).toBe("fail");
    await writeFile(path.join(f.project, "index.html"), html(true));
    await f.runtime.options!.afterFileEdit!(path.join(f.project, "index.html"));
    const replay = await invoke({ action: "replay", id: baseline.id });
    expect(replay).toMatchObject({ status: "pass", baseline: "fail", scenarioSha256: baseline.scenarioSha256 });
  };
  await f.app.runOnce("fix this website and demonstrate the regression passing");
  expect(f.app.getLastTaskResult()).toMatchObject({ execution: "completed", browser: { status: "pass", checks: [{ status: "pass", baseline: "fail", freshness: "fresh" }] } });
  expect(f.output.join("")).toContain("Browser assertions pass");
  expect(f.output.join("")).toContain("no Casper verification recorded");
  await expect(fetch(url)).rejects.toThrow();
  expect((await captured!.execute({ action: "inspect" })).isError).toBe(true);
  f.runtime.action = async () => { expect(f.runtime.tools.some(tool => tool.name === "browser")).toBe(false); };
  await f.app.runOnce("hello");
  expect(f.app.getLastTaskResult()?.browser).toBeUndefined();
}, 20_000);

browserTest("a requested website task can inspect a real page through Casper's custom tool", async () => {
  const f = await fixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<h1>App seam fixture</h1>", { headers: { "content-type": "text/html" } }) });
  cleanup.push(async () => { server.stop(true); });
  let captured: RuntimeTool | undefined;
  f.runtime.action = async () => {
    captured = f.runtime.tools.find(tool => tool.name === "browser");
    expect(captured).toBeDefined();
    expect((await captured!.execute({ action: "open", url: `http://127.0.0.1:${server.port}` })).isError).toBeUndefined();
    const observed = await captured!.execute({ action: "inspect" });
    expect(JSON.parse(observed.text).data.text).toContain("App seam fixture");
    const screenshot = await captured!.execute({ action: "screenshot" });
    expect(JSON.parse(screenshot.text).data.path).toEndWith(".png");
  };
  await f.app.runOnce("debug this website");
  await f.app.close();
  expect((await captured!.execute({ action: "inspect" })).isError).toBe(true);
}, 20_000);

test("browser status is local and ordinary chat exposes no browser tool", async () => {
  const f = await fixture();
  await f.app.runOnce("/browser");
  expect(f.runtime.starts).toBe(0);
  expect(f.output.join("")).toContain('"state":"idle"');
  await f.app.runOnce("hello");
  expect(f.runtime.tools.some(tool => tool.name === "browser")).toBe(false);
});
