import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { CasperApp } from "../src/app";
import { helperActivityLine } from "../src/app/events";
import { formatBackgroundTasks, runTasksCommand, tasksChoices, TASKS_QUESTION, type BackgroundTask } from "../src/app/background";
import { SubagentManager, type HelperActivity } from "../src/agents/manager";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener, RuntimeReadOnlyStartOptions, RuntimeSession } from "../src/runtime/types";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function task(name: string, kind: BackgroundTask["kind"] = "dev server"): BackgroundTask & { stopped: number } {
  const entry = { kind, name, status: "running", stopped: 0, stop: async () => { entry.stopped++; return `Stopped ${name}.`; } };
  return entry;
}

function host(tasks: BackgroundTask[], answer?: (question: string, labels: string[]) => string | undefined, canAsk = true) {
  let text = "";
  const asked: Array<{ question: string; labels: string[] }> = [];
  return {
    get text() { return text; }, asked,
    host: { tasks: () => tasks, write: (line: string) => { text += line; }, canAsk: () => canAsk,
      pick: async (question: string, options: Array<{ label: string }>) => {
        const labels = options.map(option => option.label);
        asked.push({ question, labels });
        return answer ? answer(question, labels) : labels[0];
      } },
  };
}

test("/tasks lists what runs in one numbered list and asks 1 Keep them · 2 Stop 1 …; Enter keeps them", async () => {
  const api = task("api"), web = task("web");
  const h = host([api, web]);
  await runTasksCommand(h.host);
  expect(h.text).toContain("[tasks] Running in the background:\n  1 dev server api · running\n  2 dev server web · running\n");
  expect(h.asked).toEqual([{ question: TASKS_QUESTION, labels: ["Keep them", "Stop 1", "Stop 2", "Stop all"] }]);
  expect(h.text).toContain("Nothing was stopped.");
  expect(api.stopped + web.stopped).toBe(0);
});

test("/tasks stops only the one picked, or all", async () => {
  const api = task("api"), web = task("web");
  const one = host([api, web], (_q, labels) => labels[2]);
  await runTasksCommand(one.host);
  expect([api.stopped, web.stopped]).toEqual([0, 1]);
  expect(one.text).toContain("[tasks] Stopped web.");
  const all = host([api, web], () => "Stop all");
  await runTasksCommand(all.host);
  expect([api.stopped, web.stopped]).toEqual([1, 2]);
});

test("/tasks with one thing running offers Leave it running first", () => {
  expect(tasksChoices([task("api")]).map(choice => choice.label)).toEqual(["Leave it running", "Stop 1"]);
  expect(tasksChoices([])).toEqual([]);
});

test("a one-shot run or a pipe never waits on /tasks: it lists, stops nothing and says so", async () => {
  const api = task("api");
  const h = host([api], () => { throw new Error("must not ask"); }, false);
  await runTasksCommand(h.host);
  expect(h.asked).toEqual([]);
  expect(api.stopped).toBe(0);
  expect(h.text).toContain("Nothing was stopped: nobody is here to answer. To stop one: /tasks stop <n>");
  await runTasksCommand(h.host, "stop 1");
  expect(api.stopped).toBe(1);
  await runTasksCommand(h.host, "stop 7");
  expect(h.text).toContain("There is no 7 in the list.");
});

test("with nothing in the background, /tasks says so plainly and asks nothing", async () => {
  const h = host([]);
  await runTasksCommand(h.host);
  expect(h.text).toBe("[tasks] Nothing is running in the background.\n");
  expect(h.asked).toEqual([]);
});

test("a background entry never shows a secret in its name", () => {
  const text = formatBackgroundTasks([{ ...task("explorer: check token=0f6c1a52-8e0f-4a57-9d4e-3b3f2b1c9a77", "helper") }]);
  expect(text).not.toContain("0f6c1a52-8e0f");
});

test("a helper whose goal holds a lab login or a Proxmox token never shows it in /tasks", () => {
  const tasks = [
    task("explorer: log in to the lab as root / Example-Pass-2024! and list the VMs", "helper"),
    task("explorer: query pve with root@pam!sampleapp=3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f", "helper"),
  ];
  const text = formatBackgroundTasks(tasks) + tasksChoices(tasks).map(choice => choice.description).join("\n");
  expect(text).not.toContain("Example-Pass-2024");
  expect(text).not.toContain("3f2a9c1e-5b7d");
  expect(text).toContain("root / <secret hidden>");
});

class ChildRuntime implements AgentRuntime {
  release!: () => void;
  readonly held = new Promise<void>(resolve => { this.release = resolve; });
  async start(): Promise<RuntimeSession> { throw new Error("read-only only"); }
  async startReadOnly(options: RuntimeReadOnlyStartOptions): Promise<RuntimeSession> {
    const listeners = new Set<RuntimeEventListener>();
    const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
    return {
      prompt: async () => {
        emit({ type: "tool_start", toolName: "read", toolCallId: "r1", input: { path: `${options.cwd}/src/app.ts` } });
        emit({ type: "tool_end", toolName: "read", toolCallId: "r1", input: { path: `${options.cwd}/src/app.ts` }, isError: false });
        await this.held;
        emit({ type: "assistant_text_delta", delta: "Found it." });
      },
      abort: async () => { this.release(); },
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

test("a running helper is listed, reports its steps for the side pane, and can be stopped by itself", async () => {
  const child = new ChildRuntime();
  const activity: HelperActivity[] = [];
  const agents = new SubagentManager({ runtimeFactory: () => child, cleanupGraceMs: 20, onActivity: event => { activity.push(event); } });
  cleanups.push(() => agents.close());
  const work = agents.run({ role: "explorer", goal: "Find the login code", cwd: "/repo", projectContext: "rules" });
  const limit = performance.now() + 5000;
  while (!activity.some(event => event.kind === "tool" && event.event.type === "tool_end") && performance.now() < limit) await Bun.sleep(5);
  const [run] = agents.runs();
  expect(run).toMatchObject({ role: "explorer", goal: "Find the login code" });
  expect(activity.map(event => helperActivityLine(event, "/repo"))).toEqual([
    "helper explorer started: Find the login code", "helper explorer · • read · src/app.ts", "helper explorer · ✓ read · src/app.ts",
  ]);
  expect(agents.cancelRun(run!.id)).toBe(true);
  expect((await work).status).toBe("cancelled");
  expect(agents.runs()).toEqual([]);
  expect(helperActivityLine(activity.at(-1)!)).toBe("helper explorer stopped (cancelled)");
  expect(agents.cancelRun(run!.id)).toBe(false);
});

const SERVER = path.join(import.meta.dir, "fixtures", "service-server.ts");

test("/tasks in Casper lists a running dev server with plain words and stops it", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-tasks-app-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper", "project.yaml"), stringify({ services: { api: {
    command: `"${process.execPath}" "${SERVER}"`, port: "auto", ready: { http: "/health" }, timeoutMs: 10_000 } } }));
  const output: string[] = [];
  const app = new CasperApp({ runtimeFactory: () => { throw new Error("no model"); }, output: { write: text => { output.push(text); } }, sessionHomeDir: home,
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ homeDir: home, projectRoot: context.info.root }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }) });
  cleanups.push(() => app.close().catch(() => {}));
  await app.start(project);
  await app.runOnce("/tasks");
  expect(output.join("")).toContain("[tasks] Nothing is running in the background.");
  await app.runOnce("/services start api");
  output.length = 0;
  await app.runOnce("/tasks");
  expect(output.join("")).toMatch(/1 dev server api · running at http:\/\/127\.0\.0\.1:\d+ · just started/);
  expect(output.join("")).toContain("Nothing was stopped: nobody is here to answer.");
  expect(app.services!.status()[0]!.state).toBe("ready");
  await app.runOnce("/tasks stop 1");
  expect(output.join("")).toContain("[tasks] Stopped api.");
  expect(app.services!.status()[0]!.state).toBe("stopped");
});
