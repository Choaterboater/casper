import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { backgroundCommands } from "../src/app/runtime-start";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { ATTRIBUTION_SLACK_MS } from "../src/task/attribution";
import { formatReceipt } from "../src/task/result";
import { checkCommand } from "./support/check-command";
import { cleanEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";

/**
 * Another process (an app's own subagent, a second AI tool, an editor) changes and adds files in the project while a
 * Casper task runs. The receipt names them, Casper's checks leave them out, and /undo leaves them as they are.
 */

type Emit = (event: Parameters<RuntimeEventListener>[0]) => void;

/** A fake model whose `turn` emits tool events and writes files; one app per call, in `home`. */
function fixtureApp(home: string, project: string, turn: (emit: Emit) => Promise<void>) {
  const listeners = new Set<RuntimeEventListener>();
  const emit: Emit = (event) => { for (const listener of listeners) listener(event); };
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => { await turn(emit); emit({ type: "assistant_text_delta", delta: "Done." }); },
      };
    },
    async dispose() {},
  };
  let output = "";
  const app = new CasperApp({
    output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  return { app, output: () => output };
}

/** Longer than the time slack: a save after this is clearly outside any tool's run. */
const PAST_SLACK_MS = ATTRIBUTION_SLACK_MS + 600;

/** A temp project with app.py and notes.md, whose check appends a line to `runs` (outside the project) (one "x") each time it runs. */
async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-outside-process-"));
  const home = path.join(root, "home"), folder = path.join(root, "project"), runs = path.join(root, "check-runs");
  await mkdir(home); await mkdir(path.join(folder, ".casper"), { recursive: true });
  await writeFile(path.join(folder, "app.py"), "x = 1\n");
  await writeFile(path.join(folder, "notes.md"), "first notes\n");
  await writeFile(path.join(folder, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(checkCommand(`append:${runs}`))}\n`);
  // The other process: a separate program that edits notes.md and adds helper.py, then exits.
  const script = path.join(root, "other-process.js");
  await writeFile(script, [
    "const fs = require('node:fs'), path = require('node:path');",
    "const folder = process.argv[2];",
    "fs.writeFileSync(path.join(folder, 'notes.md'), 'notes from the other process\\n');",
    "fs.writeFileSync(path.join(folder, 'helper.py'), 'def helper():\\n    return 2\\n');",
  ].join("\n"));
  const otherProcess = async () => {
    const child = Bun.spawn([process.execPath, script, folder], { cwd: root, env: cleanEnv({ HOME: home }), stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).toBe(0);
  };
  const checkRuns = async () => (await readFile(runs, "utf8").catch(() => "")).length;
  return { root, home, folder, otherProcess, checkRuns };
}

async function expectOthersLeftByUndo(home: string, folder: string, undone: Record<string, string>) {
  const later = fixtureApp(home, folder, async () => {});
  try {
    await later.app.runOnce("/undo", folder);
    for (const [file, text] of Object.entries(undone)) expect([file, await readFile(path.join(folder, file), "utf8")]).toEqual([file, text]);
    // Never Casper's: both stay as the other process left them, and the new file is not deleted.
    expect(await readFile(path.join(folder, "notes.md"), "utf8")).toBe("notes from the other process\n");
    expect(await readFile(path.join(folder, "helper.py"), "utf8")).toBe("def helper():\n    return 2\n");
    return later.output();
  } finally { await later.app.close(); }
}

test("another process changes and adds files while the AI waits: the receipt names them, checks and /undo leave them", async () => {
  const { root, home, folder, otherProcess, checkRuns } = await project();
  const made = fixtureApp(home, folder, async (emit) => {
    // The AI's shell command changes app.py while it runs.
    emit({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: { command: "python3 fix.py" } });
    await writeFile(path.join(folder, "app.py"), "x = 2\n");
    emit({ type: "tool_end", toolName: "bash", toolCallId: "b1", isError: false, input: { command: "python3 fix.py" } });
    // Then it waits on a question, and the other process does its work meanwhile.
    emit({ type: "tool_start", toolName: "ask", toolCallId: "a1", input: {} });
    await Bun.sleep(PAST_SLACK_MS);
    await otherProcess();
    await Bun.sleep(PAST_SLACK_MS);
    emit({ type: "tool_end", toolName: "ask", toolCallId: "a1", isError: false, input: {} });
  });
  try {
    try {
      await made.app.runOnce("fix app.py", folder);
      const result = made.app.getLastTaskResult()!;
      expect(result.changedPaths).toEqual(["app.py"]);
      expect(result.changedNotByModel).toEqual(["helper.py", "notes.md"]);
      expect(formatReceipt(result, { surface: "interactive" })).toContain("– Changed by something else while Casper worked (not checked): helper.py, notes.md");
      // The AI's own change is checked, once.
      expect(made.output()).toContain("Casper checking: test");
      expect(await checkRuns()).toBe(1);
    } finally { await made.app.close(); }
    const undo = await expectOthersLeftByUndo(home, folder, { "app.py": "x = 1\n" });
    expect(undo).toContain("– Left as they are: helper.py, notes.md (changed by something else while Casper worked)");
  } finally { await removeTempDir(root); }
}, 40_000);

test("another process is the only one that changes files while the AI reads: nothing is checked and /undo leaves them", async () => {
  const { root, home, folder, otherProcess, checkRuns } = await project();
  const made = fixtureApp(home, folder, async (emit) => {
    emit({ type: "tool_start", toolName: "read", toolCallId: "r1", input: { path: "app.py" } });
    await Bun.sleep(PAST_SLACK_MS);
    await otherProcess();
    await Bun.sleep(PAST_SLACK_MS);
    emit({ type: "tool_end", toolName: "read", toolCallId: "r1", isError: false, input: { path: "app.py" } });
  });
  try {
    try {
      await made.app.runOnce("what does app.py do?", folder);
      const result = made.app.getLastTaskResult()!;
      expect(result.changedPaths ?? []).toEqual([]);
      expect(result.changedNotByModel).toEqual(["helper.py", "notes.md"]);
      expect(formatReceipt(result, { surface: "interactive" })).toContain("– Changed by something else while Casper worked (not checked): helper.py, notes.md");
      expect(made.output()).not.toContain("Casper checking");
      expect(await checkRuns()).toBe(0);
    } finally { await made.app.close(); }
    // No change of the task's: a one-shot /undo has nothing to put back, and leaves both files.
    await expect(expectOthersLeftByUndo(home, folder, {})).rejects.toThrow("Nothing to undo in this folder yet.");
    expect(await readFile(path.join(folder, "notes.md"), "utf8")).toBe("notes from the other process\n");
    expect(await readFile(path.join(folder, "helper.py"), "utf8")).toBe("def helper():\n    return 2\n");
  } finally { await removeTempDir(root); }
}, 40_000);

// With no tool of the AI's run at all, everything that changed is another program's (src/app/task-run.ts).
test("another process changes files while the AI only answers in words: the receipt names them, checks and /undo leave them", async () => {
  const { root, home, folder, otherProcess, checkRuns } = await project();
  const made = fixtureApp(home, folder, async () => {
    await Bun.sleep(PAST_SLACK_MS);
    await otherProcess();
    await Bun.sleep(PAST_SLACK_MS);
  });
  try {
    try {
      await made.app.runOnce("what does app.py do?", folder);
      const result = made.app.getLastTaskResult()!;
      expect(result.changedPaths ?? []).toEqual([]);
      expect(result.changedNotByModel).toEqual(["helper.py", "notes.md"]);
      expect(await checkRuns()).toBe(0);
    } finally { await made.app.close(); }
    await expectOthersLeftByUndo(home, folder, { "app.py": "x = 1\n" }).catch((error) => { if (!/Nothing to undo/.test(String(error))) throw error; });
    expect(await readFile(path.join(folder, "notes.md"), "utf8")).toBe("notes from the other process\n");
    expect(await readFile(path.join(folder, "helper.py"), "utf8")).toBe("def helper():\n    return 2\n");
  } finally { await removeTempDir(root); }
}, 40_000);

// Esc while the AI's shell command writes: the stop can come before the tool reports its end (Pi reports it afterwards,
// as a failed tool, or not at all when the run is torn down). What the command wrote is still the AI's, so /undo puts it back.
for (const toolEnd of [false, true]) for (const throws of [true, false]) test(`the task is stopped while the AI's command writes${toolEnd ? ", its tool ends as failed after the stop" : ", its tool never ends"}${throws ? "" : ", the model's turn returns"}: /undo still puts back its files`, async () => {
  const { root, home, folder } = await project();
  const listeners = new Set<RuntimeEventListener>();
  const emit: Emit = (event) => { for (const listener of listeners) listener(event); };
  let app: CasperApp | undefined;
  const command = { command: "python3 fix.py > made.py" };
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: folder, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: (_text: string, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
          signal?.addEventListener("abort", () => {
            if (toolEnd) emit({ type: "tool_end", toolName: "bash", toolCallId: "b1", isError: true, input: command });
            emit({ type: "assistant_response_end", stopReason: "aborted", errorMessage: "Request was aborted" });
            // Pi's adapter rethrows the AbortError; another runtime's turn may just end.
            if (!throws) { resolve(); return; }
            const error = new DOMException("The operation was aborted.", "AbortError");
            emit({ type: "error", message: error.message });
            reject(error);
          }, { once: true });
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          emit({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: command });
          void (async () => {
            await writeFile(path.join(folder, "app.py"), "x = 2\n");
            await writeFile(path.join(folder, "made.py"), "made = True\n");
            // Esc, while the command still runs.
            app!.interrupt();
          })();
        }),
      };
    },
    async dispose() {},
  };
  const input = new PassThrough();
  let output = "";
  const stopped = Promise.withResolvers<void>();
  app = new CasperApp({
    input, output: { write: (text: string) => { output += text; if (output.includes("✗ Stopped")) stopped.resolve(); } },
    runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  try {
    const interactive = app.runInteractive(folder);
    try {
      input.write("fix app.py\n");
      await stopped.promise;
      const result = app.getLastTaskResult()!;
      expect(result.changedPaths).toEqual(["app.py", "made.py"]);
      expect(result.changedNotByModel ?? []).toEqual([]);
      input.end();
      await interactive;
    } finally { await app.close(); }
    const later = fixtureApp(home, folder, async () => {});
    try { await later.app.runOnce("/undo", folder); } finally { await later.app.close(); }
    expect(await readFile(path.join(folder, "app.py"), "utf8")).toBe("x = 1\n");
    expect(await readFile(path.join(folder, "made.py"), "utf8").catch(() => "deleted")).toBe("deleted");
  } finally { await removeTempDir(root); }
}, 40_000);

// A command the AI moved to the background in an earlier task still runs: it may write at any time, so what changes
// while the AI only answers in words may be its work or another program's. Casper can't tell, and /undo asks.
for (const deleted of [false, true]) test(`a command the AI left running may write while the AI only answers in words: /undo asks about the ${deleted ? "deleted file" : "changed files"}, Enter leaves them`, async () => {
  const { root, home, folder, otherProcess } = await project();
  const listeners = new Set<RuntimeEventListener>();
  const emit: Emit = (event) => { for (const listener of listeners) listener(event); };
  const job = Promise.withResolvers<{ exitCode: number | null }>();
  let app!: CasperApp;
  const command = { command: "node watch.js" };
  const turns: Array<() => Promise<void>> = [
    async () => {
      emit({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: command });
      backgroundCommands(app)!.adopt({ command: command.command, startedAt: Date.now(), output: "", done: job.promise, stop: () => job.resolve({ exitCode: null }), logDir: root });
      emit({ type: "tool_end", toolName: "bash", toolCallId: "b1", isError: false, input: command });
      emit({ type: "assistant_text_delta", delta: "It runs in the background as cmd-1." });
    },
    async () => {
      // No tool: the AI answers in words while something writes or deletes files.
      await Bun.sleep(PAST_SLACK_MS);
      if (deleted) await rm(path.join(folder, "notes.md")); else await otherProcess();
      await Bun.sleep(PAST_SLACK_MS);
      emit({ type: "assistant_text_delta", delta: "It is still running." });
    },
  ];
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: folder, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => { await turns.shift()!(); },
      };
    },
    async dispose() {},
  };
  const input = new PassThrough();
  let output = "";
  app = new CasperApp({
    input, output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const running = app.runInteractive(folder);
  const send = async (line: string, done: RegExp = /\n> $/) => {
    const from = output.length;
    input.write(`${line}\n`);
    const deadline = Date.now() + 25_000;
    while (!done.test(output.slice(from))) {
      if (Date.now() > deadline) throw new Error(`no ${done} in:\n${output.slice(from)}`);
      await Bun.sleep(20);
    }
    return output.slice(from);
  };
  const changed = deleted ? ["notes.md"] : ["helper.py", "notes.md"];
  try {
    await send("start the watcher");
    await send("is it still running?");
    const result = app.getLastTaskResult()!;
    expect(result.changedUnsure).toEqual(changed);
    expect(result.changedNotByModel).toBeUndefined();
    const asked = await send("/undo", /Type 1 or 2: $/);
    // Task 1 changed nothing, so the words-only turn is task 1 of this folder's receipts.
    expect(asked).toContain(deleted
      ? "Casper can't tell whether task 1 changed notes.md: another program may have.\n  1 Leave it · it stays as it is now\n  2 Undo it too · put it back as before the task\n"
      : "Casper can't tell whether task 1 changed helper.py, notes.md: another program may have.\n  1 Leave them · they stay as they are now\n  2 Undo them too · put them back as before the task\n");
    const left = await send("");
    expect(left).toContain(deleted ? "– Left as it is: notes.md (Casper can't tell whether task 1 changed it)" : "– Left as they are: helper.py, notes.md (Casper can't tell whether task 1 changed them)");
    // Both stay as the running command (or another program) left them.
    if (deleted) expect(await readFile(path.join(folder, "notes.md"), "utf8").catch(() => "gone")).toBe("gone");
    else {
      expect(await readFile(path.join(folder, "notes.md"), "utf8")).toBe("notes from the other process\n");
      expect(await readFile(path.join(folder, "helper.py"), "utf8")).toBe("def helper():\n    return 2\n");
    }
  } finally {
    job.resolve({ exitCode: null });
    input.end(); await running; await app.close();
    await removeTempDir(root);
  }
}, 60_000);

// The command left running writes its build output and exits while the AI answers in words: when the task ends nothing
// runs any more, but it was running during the task, so Casper still can't tell, and /undo asks.
test("a command the AI left running writes a file and exits while the AI only answers in words: /undo asks about it", async () => {
  const { root, home, folder } = await project();
  const listeners = new Set<RuntimeEventListener>();
  const emit: Emit = (event) => { for (const listener of listeners) listener(event); };
  const job = Promise.withResolvers<{ exitCode: number | null }>();
  let app!: CasperApp;
  const command = { command: "npm run build" };
  const turns: Array<() => Promise<void>> = [
    async () => {
      emit({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: command });
      backgroundCommands(app)!.adopt({ command: command.command, startedAt: Date.now(), output: "", done: job.promise, stop: () => job.resolve({ exitCode: null }), logDir: root });
      emit({ type: "tool_end", toolName: "bash", toolCallId: "b1", isError: false, input: command });
      emit({ type: "assistant_text_delta", delta: "The build runs in the background as cmd-1." });
    },
    async () => {
      // No tool: the build writes its output and ends while the AI answers in words.
      await Bun.sleep(PAST_SLACK_MS);
      await mkdir(path.join(folder, "dist"));
      await writeFile(path.join(folder, "dist/app.js"), "built();\n");
      job.resolve({ exitCode: 0 });
      const deadline = Date.now() + 10_000;
      while (backgroundCommands(app)!.list().length) {
        if (Date.now() > deadline) throw new Error("the build never ended");
        await Bun.sleep(20);
      }
      emit({ type: "assistant_text_delta", delta: "The build is done." });
    },
  ];
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: folder, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => { await turns.shift()?.(); },
      };
    },
    async dispose() {},
  };
  const input = new PassThrough();
  let output = "";
  app = new CasperApp({
    input, output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const running = app.runInteractive(folder);
  const send = async (line: string, done: RegExp = /\n> $/) => {
    const from = output.length;
    input.write(`${line}\n`);
    const deadline = Date.now() + 25_000;
    while (!done.test(output.slice(from))) {
      if (Date.now() > deadline) throw new Error(`no ${done} in:\n${output.slice(from)}`);
      await Bun.sleep(20);
    }
    return output.slice(from);
  };
  try {
    await send("start the build");
    await send("is the build done?");
    const result = app.getLastTaskResult()!;
    expect(backgroundCommands(app)!.list()).toEqual([]);
    expect(result.changedUnsure).toEqual(["dist/app.js"]);
    expect(result.changedNotByModel).toBeUndefined();
    const asked = await send("/undo", /Type 1 or 2: $/);
    expect(asked).toContain("Casper can't tell whether task 1 changed dist/app.js: another program may have.\n");
    const left = await send("");
    expect(left).toContain("– Left as it is: dist/app.js (Casper can't tell whether task 1 changed it)");
    expect(await readFile(path.join(folder, "dist/app.js"), "utf8")).toBe("built();\n");
  } finally {
    job.resolve({ exitCode: null });
    input.end(); await running; await app.close();
    await removeTempDir(root);
  }
}, 60_000);
