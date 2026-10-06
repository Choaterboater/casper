import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { sideQuestionText } from "../src/app/side-question";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeSession } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

test("a side question is a line the person starts with ?; a bare ?, a ? inside text or a pasted ? is not", () => {
  expect(sideQuestionText("? what does ECONNRESET mean")).toBe("what does ECONNRESET mean");
  expect(sideQuestionText("?why")).toBe("why");
  for (const line of ["?", "?   ", "what? why", "fix it?", "/help ?"]) expect(sideQuestionText(line)).toBeUndefined();
  expect(sideQuestionText("? from a log", ["? from a log"])).toBeUndefined();
  // A typed ? before a paste is still the person's.
  expect(sideQuestionText("? what is this: ERR_X", ["ERR_X"])).toBe("what is this: ERR_X");
});

const SECRET = "sk-or-v1-0123456789abcdef0123456789abcdef";

/** A model that, during its task, reads a file and waits on `gate`; complete() is the side model. */
async function fixture(config = "") {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-side-"));
  const home = path.join(root, "home"); const project = path.join(root, "shop-api");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper/project.yaml"), "verification:\n  mode: off\n");
  if (config) await writeFile(path.join(home, ".casper/config.yaml"), config);
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  let gate = Promise.withResolvers<void>();
  gate.resolve();
  const prompts: string[] = [];
  const steered: string[] = [];
  const asked: Array<Parameters<NonNullable<RuntimeSession["complete"]>>[0]> = [];
  let working = false;
  const session: RuntimeSession = {
    getStatus: () => ({ provider: "fixture", model: "main", auth: "configured" }),
    getState: () => ({ cwd: project, isStreaming: working }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    abort: async () => {}, setTools: () => {},
    getUsage: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, messages: 0 }),
    complete: async (input) => {
      asked.push(input);
      return { text: "The other end closed the connection.\nRetry or check the server log.", usage: { tokens: 42, estimatedCost: 0.0003 }, model: "fixture/fast" };
    },
    steer: async (text) => { steered.push(text); return true; },
    prompt: async (text) => {
      prompts.push(text);
      working = true;
      emit({ type: "assistant_response_start", provider: "fixture", model: "main" });
      emit({ type: "tool_start", toolName: "read", toolCallId: "1", input: { path: `secrets/${SECRET}.txt` } });
      emit({ type: "tool_end", toolName: "read", toolCallId: "1", isError: false, output: { text: `KEY=${SECRET}` } as never });
      await gate.promise;
      emit({ type: "assistant_text_delta", delta: "Done.\n" });
      emit({ type: "assistant_response_end", stopReason: "stop" });
      working = false;
    },
  };
  const runtime: AgentRuntime = { start: async () => session, dispose: async () => {} };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  const waiters: Array<{ test: (output: string) => boolean; resolve: () => void }> = [];
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 140, rows: 30, write(text: string) {
    output += Bun.stripANSI(text);
    for (const waiter of [...waiters]) if (waiter.test(output)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
  } });
  const until = (test: (output: string) => boolean): Promise<void> => {
    if (test(output)) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    // State the screen does not show (a task that ended) is polled too.
    const poll = setInterval(() => { if (test(output)) done(); }, 20);
    const timer = setTimeout(() => { clearInterval(poll); reject(new Error(`screen did not match; it ends with:\n${output.slice(-2000)}`)); }, 20_000);
    const done = () => { clearTimeout(timer); clearInterval(poll); const at = waiters.indexOf(waiter); if (at !== -1) waiters.splice(at, 1); resolve(); };
    const waiter = { test, resolve: done };
    waiters.push(waiter);
    return promise;
  };
  const app = new CasperApp({
    input, output: writer, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = app.runInteractive(project);
  await until((text) => text.includes("idle"));
  /** Idle at the prompt again after `marker` was echoed (the prompt reads the next line only then). */
  const idleAfter = (marker: string) => until((text) => text.includes(marker) && text.slice(text.lastIndexOf(marker)).includes("idle") && !app.commandActive);
  return { app, input, prompts, idleAfter, steered, asked, until, screen: () => output, hold: () => { gate = Promise.withResolvers<void>(); }, release: () => gate.resolve(),
    cleanup: async () => { gate.resolve(); await until(() => !app.commandActive).catch(() => {}); input.write("/exit\r"); await interactive; await app.close(); input.destroy(); await removeTempDir(root); } };
}

test("idle: ? asks the side model with no tools; the answer shows as a side answer; the conversation gets nothing; /usage counts it", async () => {
  const f = await fixture();
  try {
    f.input.write("? what does ECONNRESET mean\r");
    await f.until((text) => text.includes("The other end closed the connection."));
    expect(f.screen()).toContain("? side answer · fixture/fast · not part of the conversation");
    expect(f.screen()).toContain("  │ Retry or check the server log.");
    expect(f.asked).toHaveLength(1);
    expect(f.asked[0]).toMatchObject({ user: "what does ECONNRESET mean", role: "fast" });
    // complete() is one tool-free call outside the conversation; nothing else is offered.
    expect(Object.keys(f.asked[0]!).sort()).toEqual(["effort", "maxTokens", "role", "signal", "systemPrompt", "user"]);
    expect(f.asked[0]!.systemPrompt).toContain("Project: shop-api");
    expect(f.prompts).toEqual([]);
    f.input.write("/usage\r");
    await f.until((text) => text.includes("Side questions (?): 1; 42 tokens; cost $0.0003 estimate"));
  } finally { await f.cleanup(); }
});

test("during work: ? goes to the side model, never to the working AI; the summary names tools, not files or secrets", async () => {
  const f = await fixture();
  try {
    f.hold();
    f.input.write("fix the login bug\r");
    await f.until(() => f.prompts.length === 1 && f.app.recentTools.includes("read"));
    f.input.write("? what does ECONNRESET mean\r");
    await f.until((text) => text.includes("The other end closed the connection."));
    expect(f.steered).toEqual([]);
    // (The task's own checklist is a separate call too; the side question is the one with the question.)
    const system = f.asked.find((call) => call.user === "what does ECONNRESET mean")!.systemPrompt;
    expect(system).toContain("Current task: fix the login bug");
    expect(system).toContain("Recent tools: read");
    expect(system).not.toContain(SECRET);
    expect(system).not.toContain("secrets/");
    f.release();
    await f.idleAfter("Done.");
    // The question never reached the conversation.
    expect(f.prompts.join("\n")).not.toContain("ECONNRESET");
  } finally { await f.cleanup(); }
});

test("a bare ?, a ? inside text, and a pasted ? line go to the AI as ordinary requests", async () => {
  const f = await fixture();
  try {
    f.input.write("why is this slow?\r");
    await f.idleAfter("Done.");
    f.input.write("\x1b[200~? pasted from a chat\x1b[201~\r");
    await f.until(() => f.prompts.length === 2);
    await f.idleAfter("❯ ? pasted from a chat");
    expect(f.prompts[1]).toContain("? pasted from a chat");
    expect(f.asked).toEqual([]);
  } finally { await f.cleanup(); }
});

test("off switch: sideQuestions: false makes a ? line an ordinary request", async () => {
  const f = await fixture("sideQuestions: false\n");
  try {
    f.input.write("? what does ECONNRESET mean\r");
    await f.until(() => f.prompts.length === 1);
    await f.idleAfter("Done.");
    expect(f.prompts[0]).toContain("? what does ECONNRESET mean");
    expect(f.asked).toEqual([]);
  } finally { await f.cleanup(); }
});

test("one-shot runs: a ? line is normal text for the AI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-side-once-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper/project.yaml"), "verification:\n  mode: off\n");
  const prompts: string[] = [];
  let completes = 0;
  const session: RuntimeSession = {
    getStatus: () => ({ provider: "fixture", model: "main", auth: "configured" }), getState: () => ({ cwd: project, isStreaming: false }),
    subscribe: () => () => {}, abort: async () => {}, setTools: () => {},
    complete: async () => { completes++; return { text: "", usage: null }; },
    prompt: async (text) => { prompts.push(text); },
  };
  const app = new CasperApp({ output: { write: () => {} }, runtimeFactory: () => ({ start: async () => session, dispose: async () => {} }), sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }), loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }) });
  try {
    await app.runOnce("? what does ECONNRESET mean", project);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("? what does ECONNRESET mean");
    expect(completes).toBe(0);
  } finally { await app.close(); await removeTempDir(root); }
});
