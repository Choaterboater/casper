import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { CasperApp } from "../src/app";
import { receiptEvent, storedTaskResult } from "../src/app/json-events";
import { planAppSmoke } from "../src/services/detect";
import { HttpPageOpener, type PageOpener } from "../src/services/page-checks";
import { ServiceManager } from "../src/services/manager";
import { sameRuntimeInputs, tryApp, type AppSmokeReport } from "../src/services/try-it";
import { hostProcessPlatform, type ProcessRecord } from "../src/platform/processes";
import { freePort } from "../src/platform/managed-process";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import type { AgentRuntime, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { ReceiptStore } from "../src/task/receipts";
import { checksPassed, formatReceipt, formatTaskResult, taskOutcome, type TaskResult } from "../src/task/result";
import { removeTempDir } from "./support/temp-dir";
import { cleanEnv } from "./support/env";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(condition: () => boolean | Promise<boolean>, timeout = 10_000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (await condition()) return; await Bun.sleep(20); }
  throw new Error("Expected condition was not reached");
}
const lines = async (file: string) => (await readFile(file, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

class ScriptedRuntime implements AgentRuntime {
  options?: RuntimeStartOptions;
  tools: RuntimeTool[] = [];
  prompts = 0;
  turn: () => Promise<void> = async () => {};
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.options = options; this.tools = options.tools ?? [];
    const info = () => ({ cwd: options.cwd, sessionId: "fixture", sessionFile: path.join(options.cwd, "..", "session.jsonl") });
    return { prompt: async () => { this.prompts++; await this.turn(); }, setTools: tools => { this.tools = tools; },
      abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
      clearConversation: async () => {}, getSessionInfo: info, resumeConversation: async () => {}, forkSession: async () => info(), switchSession: async () => info() };
  }
  async dispose() {}
  async write(file: string, text: string) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); await this.options!.afterFileEdit!(file); }
}

async function fixture(options: { mode?: "auto" | "offer" | "off"; config?: Record<string, unknown>; manifest?: Record<string, unknown>; status?: number; port?: number; homeConfig?: string; opener?: PageOpener } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-try-it-")));
  cleanups.push(() => removeTempDir(root));
  const project = path.join(root, "project"), home = path.join(root, "home");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await mkdir(path.join(home, ".casper"), { recursive: true });
  if (options.homeConfig) await writeFile(path.join(home, ".casper", "config.yaml"), options.homeConfig);
  await writeFile(path.join(root, "session.jsonl"), "");
  const starts = path.join(root, "starts.log"), requests = path.join(root, "requests.log");
  const source = (status = options.status ?? 200) => `import { appendFileSync } from "node:fs";
const server = Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch(request) {
  const route = new URL(request.url).pathname;
  appendFileSync(${JSON.stringify(requests)}, route + "\\n");
  return new Response("<main>App</main><a href='/other'>Other</a>", { status: route === "/health" ? 200 : ${status}, headers: { "content-type": "text/html" } });
} });
appendFileSync(${JSON.stringify(starts)}, JSON.stringify({ pid: process.pid, port: server.port }) + "\\n");
console.log("listening");
`;
  const server = path.join(project, "server.ts");
  await writeFile(server, source());
  await writeFile(path.join(project, "package.json"), JSON.stringify(options.manifest ?? { name: "app" }));
  await writeFile(path.join(project, "bun.lock"), "");
  const spec = { command: `"${process.execPath}" server.ts`, port: options.port ?? "auto" as const, ready: { log: "listening" }, timeoutMs: 2000 };
  await writeFile(path.join(project, ".casper/project.yaml"), stringify({ verification: { mode: options.mode ?? "offer" }, repair: { maxAttempts: 0 }, services: { web: spec }, ...options.config }));
  const runtime = new ScriptedRuntime(), output: string[] = [];
  const app = new CasperApp({ runtimeFactory: () => runtime, output: { write: text => { output.push(text); } }, sessionHomeDir: home, pageOpener: async () => options.opener ?? new HttpPageOpener(),
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ homeDir: home, projectRoot: context.info.root }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }), loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  cleanups.push(() => app.close().catch(() => {}));
  await app.start(project);
  const edit = (file = "server.ts", text = `${source()}\n// changed\n`) => { runtime.turn = () => runtime.write(path.join(project, file), text); };
  const run = async () => { await app.runOnce("Refactor the app"); return app.getLastTaskResult()!; };
  const stopped = async () => {
    await until(async () => (await lines(starts)).length > 0);
    const records = (await lines(starts)).map(line => JSON.parse(line) as { pid: number; port: number });
    await until(() => records.every(record => !alive(record.pid)));
    for (const record of records) await until(async () => { try { await fetch(`http://127.0.0.1:${record.port}/`); return false; } catch { return true; } });
  };
  return { app, runtime, project, home, root, server, spec, source, starts, requests, edit, run, stopped, text: () => output.join("") };
}

for (const [kind, file] of [["app", "src/app.ts"], ["server", "server.ts"], ["page", "public/index.html"]]) {
  test(`a ${kind} change starts the declared command, checks one real request, and stops its processes`, async () => {
    const f = await fixture(); f.edit(file);
    const task = await f.run();
    expect(task.appSmoke).toMatchObject({ status: "pass", path: "/", httpStatus: 200, cleanup: "stopped" });
    await f.stopped();
    await until(async () => (await lines(f.requests)).length === 1);
    expect(await lines(f.requests)).toEqual(["/"]);
    expect(f.text()).toContain("App smoke: passed");
    expect(f.text()).toContain("app stopped");
  }, 20_000);
}

test("completion cleanup stops the app's child processes too", async () => {
  const f = await fixture();
  const child = `const helper = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { env: ${JSON.stringify(cleanEnv({}, { SystemRoot: process.env.SystemRoot }))}, stdout: "ignore", stderr: "ignore" });\nrequire("node:fs").appendFileSync(${JSON.stringify(f.starts)}, JSON.stringify({ pid: helper.pid, port: 0 }) + "\\n");\n`;
  f.edit("server.ts", child + f.source());
  expect((await f.run()).appSmoke?.cleanup).toBe("stopped");
  expect(await lines(f.starts)).toHaveLength(2);
  await f.stopped();
}, 20_000);

test("a framework-less API uses the project's dev command without needing an HTML page", async () => {
  const f = await fixture({ config: { services: {} }, manifest: { name: "api", scripts: { dev: `"${process.execPath}" server.ts` } } });
  await writeFile(path.join(f.project, "package.json"), JSON.stringify({ scripts: { dev: "bun server.ts" } }));
  f.edit();
  const task = await f.run();
  expect(task.appSmoke).toMatchObject({ status: "pass", label: "bun run dev", httpStatus: 200, cleanup: "stopped" });
  await f.stopped();
}, 20_000);

test("start is used when the app has no dev command", async () => {
  const f = await fixture({ config: { services: {} }, manifest: { name: "api", scripts: { start: "bun server.ts" } } });
  f.edit();
  expect((await f.run()).appSmoke).toMatchObject({ status: "pass", label: "bun run start" });
  await f.stopped();
}, 20_000);

test("a changed file-routed page supplies the real request path", async () => {
  const f = await fixture({ manifest: { dependencies: { next: "15", react: "19" } } });
  f.edit("app/dashboard/page.tsx", "export default function Page() { return <main>Dashboard</main>; }\n");
  expect((await f.run()).appSmoke).toMatchObject({ status: "pass", path: "/dashboard", httpStatus: 200 });
  expect(await lines(f.requests)).toEqual(["/dashboard"]);
  await f.stopped();
}, 20_000);

test("a Markdown page under a docs route remains a runtime change", async () => {
  const f = await fixture();
  expect(await planAppSmoke(f.project, { frameworks: ["astro"], services: { web: f.spec } }, ["src/pages/docs/guide.md"]))
    .toMatchObject({ path: "/docs/guide" });
});

test("a declared HTTP readiness path supplies the API smoke path, not a guessed root", async () => {
  const f = await fixture();
  const plan = await planAppSmoke(f.project, { services: { api: { ...f.spec, ready: { http: "/health" } } } }, ["server.ts"]);
  expect(plan).toMatchObject({ service: { name: "api", source: "declared" }, path: "/health" });
});

test("service scopes select only the server touched by the change", async () => {
  const f = await fixture();
  await mkdir(path.join(f.project, "api")); await mkdir(path.join(f.project, "ui"));
  await writeFile(path.join(f.project, "api/server.ts"), "export {};\n");
  const services = { api: { ...f.spec, scope: { inputs: ["api"] } }, web: { ...f.spec, scope: { inputs: ["ui"] } } };
  expect(await planAppSmoke(f.project, { services }, ["api/server.ts"])).toMatchObject({ service: { name: "api" } });
  expect(await planAppSmoke(f.project, { services }, ["other.ts"])).toBeUndefined();
});

test("startup failure says not run in terminal, saved and JSON receipts", async () => {
  const f = await fixture({ config: { services: { web: { command: `"${process.execPath}" -e "process.exit(4)"`, ready: { log: "listening" }, timeoutMs: 1000 } } } });
  f.edit(); const task = await f.run();
  expect(task.appSmoke).toMatchObject({ status: "not-run", cleanup: "stopped" });
  expect(task.appSmoke?.reason).toContain("could not start");
  expect(f.text()).toContain("App smoke: not run");
  expect(f.text()).toContain("exit code 4");
  expect(receiptEvent(undefined, task, 2).appSmoke?.status).toBe("not-run");
  const saved = await new ReceiptStore(f.app.projectContext!.stateDirectory).get(task.receipt!);
  expect(typeof saved === "object" ? saved.task?.appSmoke : undefined).toEqual(task.appSmoke);
  expect(taskOutcome(undefined, task)).toBe("incomplete");
}, 20_000);

test("startup timeout is bounded, says not run, and cleans up the process", async () => {
  const f = await fixture();
  await writeFile(f.server, `require("node:fs").appendFileSync(${JSON.stringify(f.starts)}, JSON.stringify({ pid: process.pid, port: 0 }) + "\\n"); setInterval(() => {}, 1000);\n`);
  const target = { service: { name: "web", spec: { ...f.spec, timeoutMs: 1000 }, source: "declared" as const, label: f.spec.command, frameworks: [], portFlags: true }, path: "/" };
  const report = await tryApp(f.project, target, new AbortController().signal);
  expect(report).toMatchObject({ status: "not-run", cleanup: "stopped" });
  expect(report.reason).toContain("within 1 s");
  await until(async () => (await lines(f.starts)).length > 0);
  const [{ pid }] = (await lines(f.starts)).map(line => JSON.parse(line));
  await until(() => !alive(pid));
}, 15_000);

test("cancelling a started smoke still stops the owned process", async () => {
  const f = await fixture();
  await writeFile(f.server, f.source().replace('return new Response("<main>', 'return new Promise(() => {}); return new Response("<main>'));
  const controller = new AbortController();
  const running = tryApp(f.project, { service: { name: "web", spec: f.spec, source: "declared", label: f.spec.command, frameworks: [], portFlags: true }, path: "/" }, controller.signal);
  await until(async () => (await lines(f.requests)).includes("/"));
  controller.abort();
  expect(await running).toMatchObject({ status: "not-run", cleanup: "stopped" });
  await f.stopped();
}, 20_000);

test("a recognized app without launch information says not run", async () => {
  const f = await fixture({ config: { services: {} }, manifest: { name: "app", dependencies: { react: "19" } } });
  f.edit("src/App.tsx", "export default function App() { return null; }\n");
  const task = await f.run();
  expect(task.appSmoke).toMatchObject({ status: "not-run", reason: "no start/dev command or declared service found for this app" });
  expect(f.text()).toContain("App smoke: not run");
  expect(await lines(f.starts)).toEqual([]);
});

test("a framework-less server without launch information says not run", async () => {
  const f = await fixture({ config: { services: {} } }); f.edit();
  const task = await f.run();
  expect(task.appSmoke).toMatchObject({ status: "not-run", reason: "no start/dev command or declared service found for this app" });
  expect(await lines(f.starts)).toEqual([]);
});

test("missing dependencies are reported without installing or starting the app", async () => {
  const f = await fixture({ config: { services: {} }, manifest: { scripts: { dev: "vite" }, dependencies: { vite: "6" } } });
  f.edit("src/App.tsx", "export default 1;\n");
  const task = await f.run();
  expect(task.appSmoke?.status).toBe("not-run");
  expect(task.appSmoke?.reason).toContain("node_modules is missing");
  expect(await lines(f.starts)).toEqual([]);
});

test("an unexpected HTTP response fails the smoke and still stops the app", async () => {
  const f = await fixture({ status: 500 }); f.edit();
  const task = await f.run();
  expect(task.appSmoke).toMatchObject({ status: "fail", httpStatus: 500, cleanup: "stopped", reason: "HTTP 500, expected 2xx" });
  expect(taskOutcome(undefined, task)).toBe("failed");
  expect(f.text()).toContain("Failed — app smoke");
  await f.stopped();
}, 20_000);

test("a failed page load from a fresh host report is reused as a failure, not retried", async () => {
  let loads = 0;
  const opener: PageOpener = { consoleChecked: true, async close() {}, async load(url, signal) {
    loads++;
    const response = await fetch(url, { signal }); await response.body?.cancel();
    return { status: response.status, consoleChecked: true, consoleErrors: ["fixture page error"], pageErrors: [], failedRequests: [] };
  } };
  const f = await fixture({ mode: "auto", config: { pages: ["/"] }, opener }); f.edit();
  const task = await f.run();
  expect(task.appSmoke).toMatchObject({ status: "fail", reused: true, reason: "fixture page error", cleanup: "stopped" });
  expect(loads).toBe(1);
  expect(await lines(f.starts)).toHaveLength(1);
  await f.stopped();
}, 20_000);

test("a passing page check on the final files is reused without another request", async () => {
  const f = await fixture({ mode: "auto", config: { pages: ["/"] } }); f.edit();
  expect((await f.run()).appSmoke).toMatchObject({ status: "pass", reused: true, cleanup: "stopped" });
  expect(await lines(f.requests)).toEqual(["/"]);
  await f.stopped();
}, 20_000);

test("late deferred checks invalidate the earlier page result and smoke the final server", async () => {
  const f = await fixture({ mode: "auto", config: { pages: ["/"], commands: { test: "bun test" }, verification: { mode: "auto", checks: ["test", "build"] } },
    manifest: { scripts: { test: "bun test", build: "bun late.ts" } } });
  await writeFile(path.join(f.project, "late.ts"), `require("node:fs").writeFileSync("server.ts", ${JSON.stringify(f.source(500))});\n`);
  f.runtime.turn = async () => {
    await f.runtime.write(f.server, `${f.source()}\n// changed\n`);
    await f.runtime.write(path.join(f.project, "tests/app.test.ts"), 'import { test, expect } from "bun:test"; test("fixture", () => expect(1).toBe(1));\n');
  };
  const task = await f.run();
  expect(task.verification?.pages?.status).toBe("pass");
  expect(task.appSmoke).toMatchObject({ status: "fail", httpStatus: 500, cleanup: "stopped" });
  expect(task.appSmoke?.reused).toBeUndefined();
  expect(f.runtime.prompts).toBe(1);
  expect(await lines(f.starts)).toHaveLength(2);
  await f.stopped();
}, 30_000);

for (const [label, file] of [["docs-only", "README.md"], ["tests-only", "tests/app.test.ts"], ["unchanged", undefined]] as const) {
  test(`${label} tasks start nothing`, async () => {
    const f = await fixture(); if (file) f.edit(file, "// fixture\n");
    const task = await f.run();
    expect(task.appSmoke).toBeUndefined();
    expect(await lines(f.starts)).toEqual([]);
  });
}

for (const file of ["README.md", "tests/app.test.ts"] as const) {
  test(`configured automatic smoke starts nothing for ${file}`, async () => {
    const f = await fixture({ mode: "auto", config: { smoke: [{ name: "health", service: "web", request: { method: "GET", path: "/health" }, expect: { status: 200 } }] } });
    f.edit(file, "// fixture\n"); await f.run();
    expect(await lines(f.starts)).toEqual([]);
  });
}

test("an existing configured request is reused, including its actual method", async () => {
  const f = await fixture({ mode: "auto", config: { smoke: [{ name: "notes", service: "web", request: { method: "POST", path: "/notes" }, expect: { status: 200 } }] } });
  f.edit();
  expect((await f.run()).appSmoke).toMatchObject({ status: "pass", reused: true, method: "POST", path: "/notes", cleanup: "stopped" });
  expect(await lines(f.requests)).toEqual(["/notes"]);
  await f.stopped();
}, 20_000);

test("files changed by startup cannot be reported as a passing final-file smoke", async () => {
  const f = await fixture();
  f.edit("server.ts", `require("node:fs").writeFileSync("late-change.ts", "export {};\\n");\n` + f.source());
  const task = await f.run();
  expect(task.appSmoke?.status).toBe("not-run");
  expect(task.appSmoke?.reason).toContain("files changed while trying");
  await f.stopped();
}, 20_000);

test("teardown edits invalidate a reused final-file result", async () => {
  const f = await fixture({ mode: "auto", config: { pages: ["/"] } });
  class EditingManager extends ServiceManager {
    override async stop(name: string) {
      const stopped = await super.stop(name);
      if (stopped) await writeFile(path.join(f.project, "late-change.ts"), "export {};\n");
      return stopped;
    }
  }
  f.app.services = new EditingManager({ projectRoot: f.project, services: { web: f.spec } });
  f.edit();
  const task = await f.run();
  expect(task.appSmoke).toMatchObject({ status: "not-run", cleanup: "stopped", reused: true });
  expect(task.appSmoke?.reason).toContain("files changed");
  await f.stopped();
}, 20_000);

for (const [label, options] of [["checks off", { mode: "off" as const }], ["page checks off", { homeConfig: "pages: off\n" }]] as const) {
  test(`${label} is respected and the receipt explains the opt-out`, async () => {
    const f = await fixture(options); f.edit();
    expect((await f.run()).appSmoke?.status).toBe("off");
    expect(f.text()).toContain("App smoke: not run (off)");
    expect(await lines(f.starts)).toEqual([]);
  });
}

test("a preserved running service gets one GET without starting a second copy", async () => {
  const f = await fixture();
  await f.app.runOnce("/services start web");
  const origin = f.app.services!.origin("web")!;
  f.edit(); const task = await f.run();
  expect(task.appSmoke).toMatchObject({ status: "pass", method: "GET", path: "/", httpStatus: 200, cleanup: "preserved" });
  expect(task.appSmoke?.reused).toBeUndefined();
  await until(async () => (await lines(f.requests)).length === 1);
  expect(await lines(f.requests)).toEqual(["/"]);
  expect(await lines(f.starts)).toHaveLength(1);
  expect(f.app.services!.origin("web")).toBe(origin);
  expect((await fetch(origin)).status).toBe(200);
  expect(f.app.services!.status()[0]!.state).toBe("ready");
}, 20_000);

test("a fixed-port service started by /services start web passes the smoke and remains ready", async () => {
  const port = await freePort();
  const f = await fixture({ port });
  await f.app.runOnce("/services start web");
  const before = f.app.services!.status()[0]!;
  expect(before).toMatchObject({ state: "ready", origin: `http://127.0.0.1:${port}` });
  f.edit(); const task = await f.run();
  expect(task.appSmoke).toMatchObject({ status: "pass", httpStatus: 200, cleanup: "preserved" });
  await until(async () => (await lines(f.requests)).length === 1);
  expect(await lines(f.starts)).toHaveLength(1);
  expect(f.app.services!.status()[0]).toMatchObject({ state: "ready", origin: before.origin, pid: before.pid });
  expect(alive(before.pid!)).toBe(true);
  expect(f.text()).toContain("existing service left running");
}, 20_000);

test("a failing response from a preserved service fails without launching or stopping it", async () => {
  const f = await fixture({ status: 500 });
  await f.app.runOnce("/services start web");
  f.edit(); const task = await f.run();
  expect(task.appSmoke).toMatchObject({ status: "fail", httpStatus: 500, cleanup: "preserved", reason: "HTTP 500, expected 2xx" });
  expect(taskOutcome(undefined, task)).toBe("failed");
  await until(async () => (await lines(f.requests)).length === 1);
  expect(await lines(f.starts)).toHaveLength(1);
  expect(f.app.services!.status()[0]!.state).toBe("ready");
}, 20_000);

test("a preserved app smoke reports preserved cleanup and existing service left running", () => {
  const task: TaskResult = { execution: "completed", appSmoke: { status: "pass", method: "GET", path: "/", httpStatus: 200, cleanup: "preserved" } };
  expect(formatTaskResult(task)).toContain("existing service left running");
  expect(formatReceipt(task)).toContain("existing service left running");
  expect(storedTaskResult(task).appSmoke?.cleanup).toBe("preserved");
  expect(receiptEvent(undefined, task, 0).appSmoke?.cleanup).toBe("preserved");
});

test("a service explicitly started by the model is not taken over by completion cleanup", async () => {
  const f = await fixture();
  f.runtime.turn = async () => {
    await f.runtime.write(f.server, `${f.source()}\n// changed\n`);
    await f.runtime.tools.find(tool => tool.name === "service")!.execute({ action: "start", service: "web" }, new AbortController().signal);
  };
  await f.run();
  expect(f.app.services!.status()[0]!.state).toBe("ready");
  expect((await fetch(f.app.services!.origin("web")!)).status).toBe(200);
}, 20_000);

test("an automatic service explicitly adopted by the model remains running", async () => {
  const f = await fixture();
  f.runtime.turn = async () => {
    await f.runtime.write(f.server, `${f.source()}\n// changed\n`);
    const service = f.runtime.tools.find(tool => tool.name === "service")!;
    await service.execute({ action: "check", name: "health", service: "web", request: { method: "GET", path: "/health" }, expect: { status: 200 } }, new AbortController().signal);
    expect(f.app.automaticServices.has("web")).toBe(true);
    const result = await service.execute({ action: "start", service: "web" }, new AbortController().signal);
    expect(result.isError).not.toBe(true);
  };
  await f.run();
  expect(f.app.services!.status()[0]!.state).toBe("ready");
  expect((await fetch(f.app.services!.origin("web")!)).status).toBe(200);
}, 20_000);

test("a model-recorded check's automatic server stops before the receipt", async () => {
  const f = await fixture();
  f.runtime.turn = async () => {
    const result = await f.runtime.tools.find(tool => tool.name === "service")!.execute({ action: "check", name: "health", service: "web",
      request: { method: "GET", path: "/health" }, expect: { status: 200 } }, new AbortController().signal);
    expect(result.isError).not.toBe(true);
    await f.runtime.write(f.server, `${f.source()}\n// changed\n`);
  };
  expect((await f.run()).appSmoke).toMatchObject({ cleanup: "stopped" });
  expect(f.app.services!.status()[0]!.state).toBe("stopped");
  await f.stopped();
}, 20_000);

test("the completion smoke adds no suite, crawl or repair loop", async () => {
  const marker = "suite-ran.txt";
  const f = await fixture({ status: 500, manifest: { scripts: { test: `bun -e "require('node:fs').writeFileSync('${marker}', 'ran')"` } } });
  f.edit(); await f.run();
  expect(f.runtime.prompts).toBe(1);
  expect(await lines(path.join(f.project, marker))).toEqual([]);
  expect(await lines(f.requests)).toEqual(["/"]);
  await f.stopped();
}, 20_000);

test("a successful smoke is an observation, never behavioral proof", () => {
  const task: TaskResult = { execution: "completed", changedPaths: ["server.ts"], appSmoke: { status: "pass", httpStatus: 200, cleanup: "stopped" } };
  expect(taskOutcome(undefined, task)).toBe("not_verified");
  expect(checksPassed(undefined, task)).toBe(false);
  expect(formatReceipt(task)).not.toContain("✓ Verified");
});

test("app smoke fields are redacted in saved and JSON receipts", () => {
  const appSmoke: AppSmokeReport = { status: "not-run", label: "token=fixture-secret", command: "serve --password=fixture-secret", path: "/?token=fixture-secret", reason: "password=fixture-secret", cleanup: "not-started" };
  const task: TaskResult = { execution: "completed", appSmoke };
  expect(JSON.stringify(storedTaskResult(task).appSmoke)).not.toContain("fixture-secret");
  expect(JSON.stringify(receiptEvent(undefined, task, 2).appSmoke)).not.toContain("fixture-secret");
  expect(formatTaskResult(task)).not.toContain("fixture-secret");
});

test("unknown owned-process cleanup cannot produce a passing smoke", async () => {
  const f = await fixture();
  const host = hostProcessPlatform();
  let kept: ProcessRecord | undefined;
  const manager = new ServiceManager({ projectRoot: f.project, services: { web: f.spec }, platform: { ...host, list: async () => {
    const all = await host.list();
    const service = manager.status()[0];
    if (service?.pid) kept ??= all.get(service.pid);
    if (kept) all.set(kept.pid, kept);
    return all;
  } } });
  cleanups.push(() => manager.close().catch(() => {}));
  const report = await tryApp(f.project, { service: { name: "web", spec: f.spec, source: "declared", label: f.spec.command, frameworks: [], portFlags: true }, path: "/" }, new AbortController().signal, { manager });
  expect(report.status).toBe("not-run");
  expect(report.cleanup).toBe("unconfirmed");
  expect(report.reason).toContain("could not confirm");
  await f.stopped();
}, 20_000);

test("only identical known final-file inputs reuse runtime evidence", () => {
  expect(sameRuntimeInputs(new Map([["server.ts", "old"]]), new Map([["server.ts", "new"]]))).toBe(false);
  expect(sameRuntimeInputs(undefined, undefined)).toBe(false);
  expect(sameRuntimeInputs(new Map([["server.ts", "same"]]), new Map([["server.ts", "same"]]))).toBe(true);
});
