import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { stringify } from "yaml";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { asksBeforeShell, ShellSandbox } from "../src/sandbox/manager";
import { SkillRegistry } from "../src/skills/registry";
import type { AgentRuntime, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { COMMANDS } from "../src/tui/commands";
import { FULL_HELP_TEXT, HELP_TEXT } from "../src/tui/help";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const SERVER = path.join(import.meta.dir, "fixtures", "service-server.ts");

async function until(condition: () => boolean | Promise<boolean>, deadline = 5000): Promise<void> {
  const limit = performance.now() + deadline;
  while (performance.now() < limit) { if (await condition()) return; await Bun.sleep(20); }
  throw new Error("Condition was not reached before its deadline");
}
const gone = (pid: number) => until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });

class ScriptedRuntime implements AgentRuntime {
  starts = 0;
  resumed: string[] = [];
  options?: RuntimeStartOptions;
  tools: RuntimeTool[] = [];
  action: (signal?: AbortSignal) => Promise<void> = async () => {};
  constructor(private readonly sessionFile: string) {}
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.starts++; this.options = options; this.tools = options.tools ?? [];
    const info = () => ({ cwd: options.cwd, sessionId: "fixture", sessionFile: this.sessionFile });
    return { prompt: async (_text, signal) => this.action(signal), setTools: tools => { this.tools = tools; }, abort: async () => {}, subscribe: () => () => {},
      getState: () => ({ cwd: options.cwd, isStreaming: false }), clearConversation: async () => {}, getSessionInfo: info,
      resumeConversation: async (id: string) => { this.resumed.push(id); },
      forkSession: async () => info(), switchSession: async () => info() };
  }
  async dispose() {}
}

async function fixture(env: Record<string, string> = {}, options: { input?: PassThrough; declare?: boolean; noSandbox?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-services-app-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true });
  const marker = path.join(root, "grandchild.pid");
  await writeFile(path.join(project, ".casper", "project.yaml"), options.declare === false ? "{}\n" : stringify({ services: { api: {
    command: `"${process.execPath}" "${SERVER}"`, port: "auto", ready: { http: "/health" }, timeoutMs: 10_000,
    scope: { inputs: ["src"] }, env: { SPAWN_CHILD: marker, ...env } } } }));
  const sessionFile = path.join(root, "session.jsonl"); await writeFile(sessionFile, "");
  const runtime = new ScriptedRuntime(sessionFile);
  const output: string[] = [];
  const app = new CasperApp({ runtimeFactory: () => runtime, output: { write: text => { output.push(text); } }, sessionHomeDir: home,
    ...(options.input ? { input: options.input } : {}),
    ...(options.noSandbox ? { noSandbox: true } : {}),
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ homeDir: home, projectRoot: context.info.root }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  cleanups.push(() => app.close().catch(() => {}));
  const grandchild = async () => { await until(async () => (await readFile(marker, "utf8").catch(() => "")).length > 0); return Number(await readFile(marker, "utf8")); };
  return { app, runtime, output, project, grandchild, marker, text: () => output.join("") };
}

const origin = (text: string) => text.match(/http:\/\/127\.0\.0\.1:\d+/g)?.at(-1);
const pid = (text: string) => Number(text.match(/pid (\d+)/g)?.at(-1)?.slice(4));

test("/services lists, starts, shows logs, restarts and stops a declared service without a model", async () => {
  const f = await fixture();
  await f.app.start(f.project);
  await f.app.runOnce("/services");
  expect(f.text()).toContain("api  idle");
  await f.app.runOnce("/services start api");
  const url = origin(f.text())!;
  expect(f.text()).toContain(`api  ready  ${url}`);
  expect((await fetch(`${url}/health`)).status).toBe(200);
  const first = pid(f.text()), grandchild = await f.grandchild();
  // The server answers /health before its "listening" line has come through the output pipe: ask again until it has.
  await until(async () => { const start = f.text().length; await f.app.runOnce("/services logs api"); return f.text().slice(start).includes("listening"); });
  await f.app.runOnce("/services restart api");
  const second = pid(f.text());
  expect(second).not.toBe(first);
  await gone(first); await gone(grandchild);
  await f.app.runOnce("/services stop api");
  expect(f.text()).toContain("[services] Stopped api.");
  await f.app.runOnce("/services");
  expect(f.text()).toContain("api  stopped");
  await gone(second);
  await expect(f.app.runOnce("/services start web")).rejects.toThrow('No service named "web"');
  await expect(f.app.runOnce("/services start")).rejects.toThrow("Usage: /services");
  expect(f.runtime.starts).toBe(0);
}, 30_000);

test("/permissions says /services runs the project's declared commands", async () => {
  const f = await fixture();
  await f.app.start(f.project);
  await f.app.runOnce("/permissions");
  expect(f.text()).toContain("/verify and /services may execute project scripts");
  expect(f.runtime.starts).toBe(0);
});

test("help and command discovery list /services", () => {
  expect(FULL_HELP_TEXT).toContain("/services ");
  for (const entry of ["/services logs <name>", "/services start|restart|stop <name>"]) expect(FULL_HELP_TEXT).toContain(entry);
  expect(COMMANDS.some(command => command.name === "services")).toBe(true);
});

test("services persist across tasks, a model edit in scope marks them stale, and /clear stops them", async () => {
  const f = await fixture();
  await f.app.start(f.project);
  await f.app.runOnce("/services start api");
  const url = origin(f.text())!, root = pid(f.text()), grandchild = await f.grandchild();
  f.runtime.action = async () => { expect((await fetch(`${url}/health`)).status).toBe(200); };
  await f.app.runOnce("hello");
  await f.app.runOnce("hello again");
  f.runtime.action = async () => { await f.runtime.options!.afterFileEdit!(path.join(f.project, "src", "server.ts")); };
  await f.app.runOnce("edit the server");
  expect((await fetch(`${url}/health`)).status).toBe(200);
  await f.app.runOnce("/services");
  expect(f.text()).toContain("stale");
  await f.app.runOnce("/clear");
  await gone(root); await gone(grandchild);
  await expect(fetch(`${url}/health`)).rejects.toThrow();
  await f.app.runOnce("/services");
  expect(f.text().split("[services]").at(-1)).toContain("api  idle");
}, 30_000);

test("/resume <id> stops the session's services before switching conversations", async () => {
  const f = await fixture();
  await f.app.start(f.project);
  await f.app.runOnce("/services start api");
  const url = origin(f.text())!, root = pid(f.text()), grandchild = await f.grandchild();
  await f.app.runOnce("/resume other-conversation");
  expect(f.runtime.resumed).toEqual(["other-conversation"]);
  await gone(root); await gone(grandchild);
  await expect(fetch(`${url}/health`)).rejects.toThrow();
  await f.app.runOnce("/services");
  expect(f.text().split("[services]").at(-1)).toContain("api  idle");
}, 30_000);

test("closing the app stops its services and their children", async () => {
  const f = await fixture();
  await f.app.start(f.project);
  await f.app.runOnce("/services start api");
  const root = pid(f.text()), grandchild = await f.grandchild();
  await f.app.close();
  await gone(root); await gone(grandchild);
}, 20_000);

test("Ctrl+C during a task leaves a ready service running, and during startup leaves no process", async () => {
  const input = new PassThrough();
  const f = await fixture({ SLOW_READY_MS: "1500" }, { input });
  const prompted = Promise.withResolvers<void>();
  f.runtime.action = signal => new Promise<void>((resolve) => {
    prompted.resolve();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  const session = f.app.runInteractive(f.project);
  input.write("/services start api\n");
  await until(() => f.text().includes("api  ready"), 10_000);
  const url = origin(f.text())!, first = pid(f.text());
  input.write("do something slow\n");
  await prompted.promise;
  expect(f.app.interrupt()).toBe(true);
  await until(() => f.text().includes("✗ Stopped"));
  expect((await fetch(`${url}/health`)).status).toBe(200);
  // The stopped task is wrapped up and Casper reads commands again ("> " after the receipt), so the
  // restart below starts now and the waits on it measure only the restart.
  const stopped = f.text().indexOf("✗ Stopped");
  await until(() => f.text().endsWith("> ") && f.text().lastIndexOf("> ") > stopped, 15_000);
  // A startup in progress is what Ctrl+C cancels.
  await rm(f.marker, { force: true });
  input.write("/services restart api\n");
  await gone(first);
  const grandchild = await f.grandchild();
  expect(f.app.interrupt()).toBe(true);
  await gone(grandchild);
  await until(() => f.app.services?.status()[0]?.state === "stopped");
  input.end();
  await session;
}, 30_000);

test("a workspace transition (/branch) stops the session's services", async () => {
  const f = await fixture();
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const git = (...args: string[]) => promisify(execFile)("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: f.project });
  await git("init", "-b", "main"); await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
  await git("add", "."); await git("commit", "-m", "Fixture baseline");
  const home = path.join(path.dirname(f.marker), "home");
  const main = path.join(home, "main.jsonl"); await writeFile(main, "main");
  let info = { cwd: f.project, sessionId: "main", sessionFile: main };
  const session: RuntimeSession = {
    getSessionInfo: () => ({ ...info }), getState: () => ({ cwd: info.cwd, isStreaming: false }),
    forkSession: async options => {
      const child = path.join(home, "child.jsonl"); await writeFile(child, "child");
      info = { cwd: options.cwd, sessionId: "child", sessionFile: child }; return { ...info };
    },
    switchSession: async options => { info = { ...info, ...options }; return { ...info }; },
    setTools: () => {}, appendContext: async () => {}, prompt: async () => {}, abort: async () => {}, subscribe: () => () => {},
  };
  const input = new PassThrough();
  let prompts = 0;
  const branching = new CasperApp({ input, sessionHomeDir: home, runtimeFactory: () => ({ start: async () => session, dispose: async () => {} }),
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    output: { write(text) {
      f.output.push(text);
      if (text.endsWith("Type 1 or 2: ")) queueMicrotask(() => input.write("2\n"));
      if (text === "> ") queueMicrotask(() => input.write(["/branch services-rebind\n", "/exit\n"][prompts++] ?? "/exit\n"));
    } } });
  cleanups.push(() => branching.close().catch(() => {}));
  await branching.runOnce("/services start api", f.project);
  const root = pid(f.text()), grandchild = await f.grandchild();
  await branching.runInteractive();
  expect(info.cwd).toContain(path.join(".casper", "worktrees"));
  // You typed /branch: it doesn't ask again.
  expect(f.text()).not.toContain("Create this exact session branch?");
  await gone(root); await gone(grandchild);
  expect(branching.services).toBeUndefined();
}, 30_000);

test("/services start restarts a stale service, and leaves a fresh one running", async () => {
  const f = await fixture();
  await f.app.start(f.project);
  await f.app.runOnce("/services start api");
  const first = pid(f.text());
  await f.app.runOnce("/services start api");
  expect(pid(f.text())).toBe(first);
  f.app.services!.markEdited(path.join(f.project, "src", "server.ts"));
  await f.app.runOnce("/services start api");
  expect(f.text()).toContain("[services] Restarted api: edits made it stale.");
  const second = pid(f.text());
  expect(second).not.toBe(first);
  await gone(first);
  expect(f.app.services!.status()[0]).toMatchObject({ state: "ready", stale: false });
}, 30_000);

test("/services stop says a service that is not running is not running", async () => {
  const f = await fixture();
  await f.app.start(f.project);
  await f.app.runOnce("/services stop api");
  expect(f.text()).toContain("[services] api is not running.");
  expect(f.text()).not.toContain("Stopped api");
  await f.app.runOnce("/services start api");
  await f.app.runOnce("/services stop api");
  expect(f.text()).toContain("[services] Stopped api.");
  await f.app.runOnce("/services stop api");
  expect(f.text().trimEnd()).toEndWith("[services] api is not running.");
  await expect(f.app.runOnce("/services stop web")).rejects.toThrow('No service named "web"');
}, 30_000);

const offered = (runtime: ScriptedRuntime) => runtime.tools.some(tool => tool.name === "service");

test("the service tool is offered for declared services; elsewhere only for server tasks or while one runs, and /clear stops ad-hoc services", async () => {
  const declared = await fixture();
  let seen: boolean[] = [];
  declared.runtime.action = async () => { seen.push(offered(declared.runtime)); };
  await declared.app.runOnce("fix the parser", declared.project);
  expect(seen).toEqual([true]);

  // Where no sandbox runs (Windows), the AI's service start asks first, and runOnce can't ask: allow it as --no-sandbox does.
  const f = await fixture({}, { declare: false, noSandbox: asksBeforeShell(ShellSandbox.detect({})) });
  seen = [];
  let pid = 0;
  f.runtime.action = async () => {
    seen.push(offered(f.runtime));
    const tool = f.runtime.tools.find(entry => entry.name === "service");
    if (!tool || pid) return;
    const result = await tool.execute({ action: "start", command: `"${process.execPath}" "${SERVER}"`, ready: { http: "/health" } }, new AbortController().signal);
    pid = JSON.parse(result.text).data.service.pid;
  };
  await f.app.start(f.project);
  await f.app.runOnce("fix the parser");
  await f.app.runOnce("start the dev server and check it");
  expect(pid).toBeGreaterThan(0);
  await f.app.runOnce("fix the parser again");
  expect(seen).toEqual([false, true, true]);
  await f.app.runOnce("/clear");
  await gone(pid);
  await f.app.runOnce("fix the parser once more");
  expect(seen).toEqual([false, true, true, false]);
}, 30_000);
