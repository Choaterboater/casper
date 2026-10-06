import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeSession, RuntimeStatus } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

function screen() {
  let output = "";
  const waiters: Array<{ test: (output: string) => boolean; resolve: () => void }> = [];
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 140, rows: 30, write(text: string) {
    output += Bun.stripANSI(text);
    for (const waiter of [...waiters]) if (waiter.test(output)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
  } });
  return {
    writer,
    get output() { return output; },
    until(test: (output: string) => boolean): Promise<void> {
      if (test(output)) return Promise.resolve();
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const timer = setTimeout(() => reject(new Error(`screen did not match; it ends with:\n${output.slice(-2500)}`)), 20_000);
      waiters.push({ test, resolve: () => { clearTimeout(timer); resolve(); } });
      return promise;
    },
  };
}

/** A model "fixture/main" on effort auto; roles as given. Each prompt records the model, the effort and the text. */
async function fixture(roles: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-words-app-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper/project.yaml"), "verification:\n  mode: off\n");
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  let model = "fixture/main";
  let configured = "auto";
  let level = "medium";
  const prompts: Array<{ model: string; configured: string; level: string; text: string; classified: boolean }> = [];
  const efforts: string[] = [];
  const selections: string[] = [];
  const status = (): RuntimeStatus => ({ provider: "fixture", model: model.split("/")[1], auth: "configured", configuredEffort: configured,
    thinkingLevel: level, availableThinkingLevels: ["off", "low", "medium", "high", "xhigh"] });
  const session: RuntimeSession = {
    getStatus: status,
    getState: () => ({ cwd: project, isStreaming: false }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    abort: async () => {}, setTools: () => {},
    getModelRoles: () => ({ ...roles }),
    describeModel: (query) => {
      const selector = query.startsWith("@") ? roles[query.slice(1)] : query;
      return selector ? { provider: "fixture", id: selector.split("/")[1]! } : undefined;
    },
    selectModel: async (selection) => {
      const query = selection.query!;
      selections.push(query);
      model = query.startsWith("@") ? roles[query.slice(1)]! : query;
      return { status: status(), selected: true, savedDefault: false };
    },
    setEffort: async (next) => {
      efforts.push(next);
      configured = next;
      if (next !== "auto") level = next;
      return status();
    },
    prompt: async (text) => {
      // Automatic effort classifies only while the effort is auto, as PiModels.preparePrompt does.
      prompts.push({ model, configured, level, text, classified: configured === "auto" });
      emit({ type: "assistant_response_start", provider: "fixture", model });
      emit({ type: "assistant_text_delta", delta: "Done.\n" });
      emit({ type: "assistant_response_end", stopReason: "stop" });
    },
  };
  const runtime: AgentRuntime = { start: async () => session, dispose: async () => {} };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const view = screen();
  const app = new CasperApp({
    input, output: view.writer, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = app.runInteractive(project);
  await view.until((output) => output.includes("idle"));
  /** Send a line and wait until the task after it is over. */
  const send = async (line: string, raw = line) => {
    const before = prompts.length;
    input.write(`${raw}\r`);
    await view.until((output) => prompts.length > before && output.slice(output.lastIndexOf(line.split("\n")[0]!.slice(-12))).includes("idle"));
    await view.until(() => !app.commandActive);
  };
  return { app, view, input, prompts, efforts, selections, send, model: () => model,
    cleanup: async () => { input.write("/exit\r"); await interactive; await app.close(); input.destroy(); await removeTempDir(root); } };
}

test("big model: this task runs on the reason role, the words are not sent, and the next task is back on your model", async () => {
  const f = await fixture({ reason: "fixture/big" });
  try {
    await f.send("big model: find the race in the queue");
    expect(f.prompts[0]!.model).toBe("fixture/big");
    expect(f.prompts[0]!.text).toContain("find the race in the queue");
    expect(f.prompts[0]!.text).not.toContain("big model");
    expect(f.view.output).toContain("[model] big model for this task: fixture/big (you asked)");
    await f.view.until((output) => output.includes("Back on fixture/main"));
    await f.send("now list the files");
    expect(f.prompts[1]!.model).toBe("fixture/main");
    expect(f.selections).toEqual(["@reason", "fixture/main"]);
  } finally { await f.cleanup(); }
});

test("think hard: top effort for this task only; automatic effort does not override it; back to auto after", async () => {
  const f = await fixture();
  try {
    await f.send("think hard: why does the cache miss");
    expect(f.prompts[0]).toMatchObject({ configured: "xhigh", level: "xhigh", classified: false });
    expect(f.prompts[0]!.text).not.toContain("think hard");
    expect(f.view.output).toContain("[effort] xhigh for this task (you asked)");
    expect(f.view.output).toContain("[effort] Back to auto for your next request.");
    await f.send("and the next one");
    expect(f.prompts[1]).toMatchObject({ configured: "auto", classified: true });
    expect(f.efforts).toEqual(["xhigh", "auto"]);
  } finally { await f.cleanup(); }
});

test("quick: low effort; ultrathink anywhere in the typed line: top effort", async () => {
  const f = await fixture();
  try {
    await f.send("quick, rename foo to bar");
    expect(f.prompts[0]).toMatchObject({ configured: "low" });
    await f.send("please ultrathink about the lock order");
    expect(f.prompts[1]).toMatchObject({ configured: "xhigh" });
    expect(f.prompts[1]!.text).toContain("please about the lock order");
    expect(f.prompts[1]!.text).not.toContain("ultrathink");
  } finally { await f.cleanup(); }
});

test("a pasted block starting with big model: does nothing; it goes to the model as it is", async () => {
  const f = await fixture({ reason: "fixture/big" });
  try {
    const block = "big model: this line came from a log";
    await f.send(block, `\x1b[200~${block}\x1b[201~`);
    expect(f.prompts[0]!.model).toBe("fixture/main");
    expect(f.prompts[0]!.text).toContain(block);
    expect(f.selections).toEqual([]);
    expect(f.view.output).not.toContain("for this task (you asked)");
  } finally { await f.cleanup(); }
});

test("a role that is not set up: one line on how to set it, and the task runs as normal", async () => {
  const f = await fixture();
  try {
    await f.send("fast model: list the files");
    expect(f.view.output).toContain("[model] No fast model is set up; /model role fast <provider/id> sets one. This task runs on fixture/main.");
    expect(f.prompts[0]!.model).toBe("fixture/main");
    expect(f.prompts[0]!.text).not.toContain("fast model");
  } finally { await f.cleanup(); }
});

test("plan first: the task plans before it builds, like /plan", async () => {
  const f = await fixture();
  try {
    f.input.write("plan first: add a login page\r");
    // The fixture's answer has no Plan: steps, so the plan turn stops before any build.
    await f.view.until((output) => output.includes("nothing was built"));
    expect(f.view.output).toContain("[plan] Plan first for this task (you asked).");
    expect(f.prompts[0]!.text).not.toContain("plan first");
  } finally { await f.cleanup(); }
});
