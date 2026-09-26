import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { CasperApp } from "../src/app";
import type { CasperEvent } from "../src/app/json-events";
import { receiptEvent } from "../src/app/json-events";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import type { AgentRuntime, RuntimeEventListener, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { taskExitCode } from "../src/task/result";
import { notesServer } from "./support/notes-server";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Each prompt runs the next scripted turn; the tools are the ones Casper offered for it. */
class ScriptedRuntime implements AgentRuntime {
  prompts: string[] = [];
  options?: RuntimeStartOptions;
  tools: RuntimeTool[] = [];
  turns: Array<(runtime: ScriptedRuntime) => Promise<void>> = [];
  listeners = new Set<RuntimeEventListener>();
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.options = options; this.tools = options.tools ?? [];
    const info = () => ({ cwd: options.cwd, sessionId: "fixture", sessionFile: path.join(options.cwd, "..", "session.jsonl") });
    return { prompt: async text => { this.prompts.push(text); await this.turns.shift()?.(this); }, setTools: tools => { this.tools = tools; },
      abort: async () => {}, subscribe: listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); }, getState: () => ({ cwd: options.cwd, isStreaming: false }), clearConversation: async () => {},
      getSessionInfo: info, resumeConversation: async () => {}, forkSession: async () => info(), switchSession: async () => info() };
  }
  async dispose() {}
  async service(args: Record<string, unknown>) {
    const result = await this.tools.find(tool => tool.name === "service")!.execute(args, new AbortController().signal);
    return JSON.parse(result.text).data;
  }
  /** A shell command the model ran (its effect, if any, is up to the caller): only its tool events are reported. */
  bash(command: string) { for (const listener of this.listeners) listener({ type: "tool_end", toolName: "bash", toolCallId: command, input: { command }, isError: false }); }
  /** A model edit: the file is written and reported, as Pi's edit/write tools do. */
  async write(file: string, content: string) { await writeFile(file, content); await this.options!.afterFileEdit!(file); }
}

const create = { name: "create note", service: "api", request: { method: "POST", path: "/notes", body: { title: "a" } }, expect: { status: 201, json: { title: "a" } } };
const list = { name: "list notes", service: "api", request: { method: "GET", path: "/notes" }, expect: { status: 200 } };

async function fixture(config: Record<string, unknown> = {}, options: { verbose?: boolean; command?: string } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-smoke-app-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true }); await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "src/server.ts"), notesServer(false));
  await writeFile(path.join(project, ".casper", "project.yaml"), stringify({ verification: { mode: "auto" },
    services: { api: { command: options.command ?? `"${process.execPath}" src/server.ts`, port: "auto", ready: { http: "/health" }, timeoutMs: 10_000, scope: { inputs: ["src"] } } },
    ...config }));
  await writeFile(path.join(root, "session.jsonl"), "");
  const runtime = new ScriptedRuntime();
  const output: string[] = [], events: CasperEvent[] = [];
  const app = new CasperApp({ runtimeFactory: () => runtime, output: { write: text => { output.push(text); } }, sessionHomeDir: home,
    verbose: options.verbose, onEvent: event => { events.push(event); },
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ homeDir: home, projectRoot: context.info.root }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  cleanups.push(() => app.close().catch(() => {}));
  await app.start(project);
  const server = path.join(project, "src/server.ts");
  return { app, runtime, output, events, project, server, text: () => output.join("") };
}

test("a model check that failed before the change and passes after it verifies the task; the receipt and JSON show it", async () => {
  const f = await fixture();
  f.runtime.turns.push(async runtime => {
    expect((await runtime.service({ action: "check", ...create })).check).toMatchObject({ id: "smoke-1", baseline: "fail" });
    await runtime.write(f.server, notesServer(true));
  });
  await f.app.runOnce("Add POST /notes");
  const result = f.app.getLastTaskResult()!;
  expect(result.verification).toMatchObject({ status: "pass", repairAttempts: 0, smoke: { status: "pass", checks: [
    { id: "smoke-1", name: "create note", source: "model", baseline: "fail", status: "pass", evidence: true, restarted: true }] } });
  expect(taskExitCode(undefined, result)).toBe(0);
  const origin = result.services![0]!.origin!;
  expect(result.services).toEqual([{ name: "api", origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), state: "ready" }]);
  expect(f.text()).toContain(`✓ Service api at ${origin.slice(7)}; smoke 1/1 passed (model-declared, run by Casper: create note failed before the change)`);
  const receipt = receiptEvent(undefined, result, 0);
  expect({ outcome: receipt.outcome, services: receipt.services, smoke: receipt.smoke?.status }).toEqual({ outcome: "verified", services: [{ name: "api", origin, state: "ready" }], smoke: "pass" });
  const phases = f.events.flatMap(event => event.type === "phase" ? [`${event.phase}:${event.state}`] : []);
  expect(phases).toEqual(["task:start", "task:end", "checks:start", "smoke:start", "smoke:end", "checks:end"]);
}, 30_000);

test("a model check that already passed before the change is shown as an observation and does not verify the task", async () => {
  const f = await fixture();
  f.runtime.turns.push(async runtime => {
    await runtime.service({ action: "check", ...list });
    await runtime.write(f.server, notesServer(true));
  });
  await f.app.runOnce("Add POST /notes");
  const result = f.app.getLastTaskResult()!;
  expect(result.verification?.smoke?.checks[0]).toMatchObject({ baseline: "pass", status: "pass", evidence: false });
  expect(receiptEvent(undefined, result, 0).outcome).toBe("not_verified");
  expect(f.text()).toContain("list notes passed before the change too — an observation, not proof");
}, 30_000);

test("a failing configured smoke check gets the normal repair round with its evidence; the repair makes it verified", async () => {
  const f = await fixture({ smoke: [create] }, { verbose: true });
  f.runtime.turns.push(async runtime => { await runtime.write(path.join(f.project, "src/notes.ts"), "export {};\n"); });
  f.runtime.turns.push(async runtime => { await runtime.write(f.server, notesServer(true)); });
  await f.app.runOnce("Tidy the notes module");
  expect(f.runtime.prompts).toHaveLength(2);
  expect(f.runtime.prompts[1]).toContain("Casper verification repair 1/3.");
  expect(f.runtime.prompts[1]).toContain("Smoke failure evidence");
  expect(f.runtime.prompts[1]).toContain("status 404, expected 201");
  const result = f.app.getLastTaskResult()!;
  expect(result.verification).toMatchObject({ status: "pass", repairAttempts: 1, smoke: { status: "pass", checks: [{ name: "create note", source: "config", status: "pass", evidence: true }] } });
  expect(receiptEvent(undefined, result, 0).outcome).toBe("verified");
  // The verbose receipt lists every check.
  expect(f.text()).toMatch(/smoke +pass: create note \[config\] api POST \/notes: pass \(201\)/);
}, 30_000);

test("a smoke failure the repairs leave in place fails the task; a service that will not start leaves it incomplete", async () => {
  const f = await fixture({ smoke: [create], repair: { maxAttempts: 1 } });
  f.runtime.turns.push(async runtime => { await runtime.write(path.join(f.project, "src/notes.ts"), "export {};\n"); });
  f.runtime.turns.push(async () => {});
  await f.app.runOnce("Tidy the notes module");
  const failed = f.app.getLastTaskResult()!;
  expect(failed.verification).toMatchObject({ status: "fail", repairAttempts: 1, smoke: { status: "fail" } });
  expect(receiptEvent(undefined, failed, 1).outcome).toBe("failed");
  expect(f.text()).toContain("✗ Service api");
  expect(f.text()).toContain("smoke 0/1 passed; failed: create note (status 404, expected 201)");

  const g = await fixture({ smoke: [list] }, { command: `"${process.execPath}" -e "process.exit(4)"` });
  g.runtime.turns.push(async runtime => { await runtime.write(path.join(g.project, "src/notes.ts"), "export {};\n"); });
  await g.app.runOnce("Tidy the notes module");
  const incomplete = g.app.getLastTaskResult()!;
  expect(incomplete.verification).toMatchObject({ status: "incomplete", repairAttempts: 0, smoke: { status: "incomplete" } });
  expect(receiptEvent(undefined, incomplete, 2).outcome).toBe("incomplete");
  expect(g.runtime.prompts).toHaveLength(1);
}, 30_000);

test("a model check recorded after an edit in this task is never evidence; the receipt says it failed when recorded, after edits", async () => {
  const f = await fixture();
  f.runtime.turns.push(async runtime => {
    await runtime.write(path.join(f.project, "src/notes.ts"), "export {};\n");
    const recorded = await runtime.service({ action: "check", ...create });
    expect(recorded.check).toMatchObject({ baseline: "fail", baselineAfterEdits: true, evidence: false });
    expect(recorded.guidance).toContain("after edits");
    await runtime.write(f.server, notesServer(true));
  });
  await f.app.runOnce("Add POST /notes");
  const result = f.app.getLastTaskResult()!;
  expect(result.verification?.smoke?.checks[0]).toMatchObject({ baseline: "fail", baselineAfterEdits: true, status: "pass", evidence: false });
  expect(receiptEvent(undefined, result, 0).outcome).toBe("not_verified");
  expect(f.text()).toContain("create note failed when recorded, after edits — an observation, not proof");
  expect(f.text()).not.toContain("failed before the change");
}, 30_000);

test("a shell command that changed the workspace before the check makes its baseline after edits; a read-only one does not", async () => {
  const f = await fixture();
  f.runtime.turns.push(async runtime => {
    runtime.bash("cat src/server.ts");
    expect((await runtime.service({ action: "check", ...create })).check).toMatchObject({ baseline: "fail", evidence: false });
    await writeFile(path.join(f.project, "src/notes.ts"), "export {};\n");
    runtime.bash("echo 'export {};' > src/notes.ts");
    expect((await runtime.service({ action: "check", ...create, name: "create again" })).check).toMatchObject({ baseline: "fail", baselineAfterEdits: true });
    await runtime.write(f.server, notesServer(true));
  });
  await f.app.runOnce("Add POST /notes");
  const checks = f.app.getLastTaskResult()!.verification!.smoke!.checks;
  expect(checks.map(({ name, evidence, baselineAfterEdits }) => ({ name, evidence, baselineAfterEdits }))).toEqual([
    { name: "create note", evidence: true, baselineAfterEdits: undefined }, { name: "create again", evidence: false, baselineAfterEdits: true }]);
}, 30_000);

test("a model check recorded during a repair round is never evidence", async () => {
  const f = await fixture({ smoke: [{ ...create, name: "configured create" }] });
  f.runtime.turns.push(async runtime => { await runtime.write(path.join(f.project, "src/notes.ts"), "export {};\n"); });
  f.runtime.turns.push(async runtime => {
    expect((await runtime.service({ action: "check", ...create })).check).toMatchObject({ baseline: "fail", baselineAfterEdits: true, evidence: false });
    await runtime.write(f.server, notesServer(true));
  });
  await f.app.runOnce("Tidy the notes module");
  const result = f.app.getLastTaskResult()!;
  expect(f.runtime.prompts[1]).toContain("Casper verification repair 1/3.");
  expect(result.verification?.smoke?.checks.map(({ name, evidence }) => ({ name, evidence }))).toEqual([
    { name: "configured create", evidence: true }, { name: "create note", evidence: false }]);
  expect(f.text()).toContain("create note failed when recorded, after edits");
}, 30_000);
