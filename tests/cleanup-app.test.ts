import { afterEach, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import type { AgentRuntime, RuntimeEvent } from "../src/runtime/types";
import { removeTempDir } from "./support/temp-dir";
import { CasperApp } from "../src/app";
import { handlePrompt } from "../src/app/command-loop";
import { browserSession } from "../src/app/task-tools";
import { BrowserSession } from "../src/browser/session";
import { receiptEvent, storedTaskResult } from "../src/app/json-events";
import { ReceiptStore } from "../src/task/receipts";
import { ProcessCleanupError, type CleanupOutcome } from "../src/platform/processes";
import { checksPassed, formatShortReceipt, formatTaskResult, taskExitCode, type TaskResult } from "../src/task/result";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

function fixture(interactive = true, json = false) {
  let output = "";
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const app = new CasperApp({ input, output: { write: text => { output += text; } },
    runtimeFactory: () => { throw new Error("A local command must not start a model"); },
    ...(json ? { onEvent() {} } : {}) });
  app.interactive = interactive;
  app.terminal.start();
  closes.push(async () => { await app.close(); input.destroy(); });
  return { app, input, screen: () => output };
}

const processes = [{ pid: 4321, group: 4321, command: "worker --token cleanup-sensitive-value\n\u001b[2J\u202ehidden" }];
function incident(outcome: CleanupOutcome = "unknown") {
  let stops = 0, listings = 0;
  const error = Object.assign(new ProcessCleanupError(), {
    async running() { listings++; return stops && outcome === "stopped" ? [] : processes; },
    async stop() { stops++; return outcome; },
  });
  return { error, stops: () => stops, listings: () => listings };
}
async function until(expected: () => boolean) {
  const end = Date.now() + 3000;
  while (!expected()) {
    if (Date.now() > end) throw new Error("cleanup picker did not appear");
    await Bun.sleep(5);
  }
}

for (const choice of ["1", "2"]) test(`actual app recovery picker choice ${choice} asks once and later commands work`, async () => {
  const f = fixture();
  const issue = incident();
  const pick = spyOn(f.app.terminal, "pick");
  // An owner keeps the same error identity until a genuinely new incident occurs.
  f.app.services = { assertCleanup() { throw issue.error; } } as never;
  const command = handlePrompt(f.app, "/hotkeys");
  await until(() => f.screen().includes("2 Leave them running"));
  expect(f.screen()).toContain("1 Stop them");
  expect(f.screen()).toContain("PID 4321");
  f.input.write(`${choice}\n`);
  await command;
  expect(f.app.getLastTaskResult()?.cleanup?.[0]?.state).toBe(choice === "1" ? "unconfirmed" : "left-running");
  expect(issue.stops()).toBe(choice === "1" ? 1 : 0);
  expect(issue.listings()).toBe(choice === "1" ? 2 : 1);
  expect(f.screen()).not.toContain("cleanup-sensitive-value");
  expect(f.screen()).not.toMatch(/[\u001b\u202e]/);
  await handlePrompt(f.app, "/hotkeys");
  expect(pick).toHaveBeenCalledTimes(1);
  expect(f.app.commandActive).toBe(false);
});

test("a reserved updater finishes before cleanup recovery and command dispatch", async () => {
  const f = fixture();
  const issue = incident();
  let release!: () => void;
  f.app.updateWork = new Promise<void>(resolve => { release = resolve; });
  const dispatch = spyOn(f.app.terminal, "takePastedImages");
  const pick = spyOn(f.app.terminal, "pick").mockResolvedValue("Leave them running");
  f.app.blockOnCleanupFailure(issue.error);
  const command = handlePrompt(f.app, "/hotkeys");
  try {
    expect(f.app.commandActive).toBe(true);
    expect(issue.listings()).toBe(0);
    expect(pick).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    release();
    await command;
    expect(pick).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(f.app.getCommandTaskResult()?.cleanup?.[0]?.state).toBe("left-running");
    expect(f.app.commandActive).toBe(false);
  } finally {
    release();
    await command;
    f.app.updateWork = undefined;
  }
});

test("a narrow recovery list fits each PID and command on one line without truncating receipt evidence", async () => {
  const f = fixture();
  Object.defineProperty(f.app.terminal, "columns", { get: () => 40 });
  const command = `worker ${"argument ".repeat(30)}`.trim();
  const error = Object.assign(new ProcessCleanupError(), {
    async running() { return [{ pid: 4321, group: 4321, command }]; },
  });
  spyOn(f.app.terminal, "pick").mockResolvedValue("Leave them running");
  f.app.blockOnCleanupFailure(error);
  await handlePrompt(f.app, "/hotkeys");
  const line = f.screen().split("\n").find(line => line.startsWith("PID 4321"))!;
  expect(line.length).toBeLessThan(40);
  expect(line).toEndWith("…");
  expect(f.app.getLastTaskResult()?.cleanup?.[0]?.processes[0]?.command).toBe(command.trim());
});

test("the same subsystem reports a new error identity without a successful preflight between incidents", async () => {
  const f = fixture();
  let issue = incident();
  const pick = spyOn(f.app.terminal, "pick").mockResolvedValue("Leave them running");
  f.app.services = { assertCleanup() { throw issue.error; } } as never;
  await handlePrompt(f.app, "/hotkeys");
  await handlePrompt(f.app, "/hotkeys");
  expect(pick).toHaveBeenCalledTimes(1);
  issue = incident();
  await handlePrompt(f.app, "/hotkeys");
  expect(pick).toHaveBeenCalledTimes(2);
  expect(issue.listings()).toBe(1);
});

for (const command of ["receipt", "diff", "undo", "redo"] as const) for (const priorCleanup of [false, true]) {
  test(`/${command} recovery stays separate from historical cleanup (${priorCleanup})`, async () => {
    const f = fixture();
    const historical: TaskResult = { execution: "completed", ...(priorCleanup ? {
      cleanup: [{ state: "stopped" as const, processes: [{ pid: 1234, group: 1234, command: "earlier worker" }] }],
    } : {}) };
    const before = structuredClone(historical);
    f.app.lastTaskResult = f.app.lastFinishedTask = historical;
    if (command === "diff") spyOn(f.app.taskUndo, "diff").mockResolvedValue(true);
    if (command === "undo" || command === "redo") spyOn(f.app.taskUndo, command).mockResolvedValue(undefined);
    const issue = incident();
    const pick = spyOn(f.app.terminal, "pick").mockResolvedValue("Leave them running");
    f.app.blockOnCleanupFailure(issue.error);
    await handlePrompt(f.app, `/${command}`);
    expect(f.app.cleanupReports).toMatchObject([{ state: "left-running", processes: [{ pid: 4321, group: 4321 }] }]);
    expect(f.app.getLastTaskResult()).toEqual(before);
    expect(f.app.lastFinishedTask).toEqual(before);
    await handlePrompt(f.app, "/receipt");
    expect(f.app.cleanupReports).toEqual([]);
    expect(f.app.getLastTaskResult()).toEqual(before);
    expect(pick).toHaveBeenCalledTimes(1);
  });
}

for (const json of [false, true]) for (const command of ["receipt", "diff", "undo", "redo"] as const) {
  test(`unattended /${command} (${json ? "JSON" : "one-shot"}) preserves history but reports current cleanup`, async () => {
    const f = fixture(json, json);
    const historical: TaskResult = { execution: "completed" };
    f.app.lastTaskResult = f.app.lastFinishedTask = historical;
    if (command === "diff") spyOn(f.app.taskUndo, "diff").mockResolvedValue(true);
    if (command === "undo" || command === "redo") spyOn(f.app.taskUndo, command).mockResolvedValue(undefined);
    const pick = spyOn(f.app.terminal, "pick");
    f.app.blockOnCleanupFailure(incident().error);
    await handlePrompt(f.app, `/${command}`);
    expect(f.app.getLastTaskResult()).toEqual(historical);
    expect(f.app.lastFinishedTask).toEqual(historical);
    const current = f.app.getCommandTaskResult()!;
    expect(current.cleanup?.[0]).toMatchObject({ state: "unconfirmed", unattended: true });
    expect(taskExitCode(undefined, current)).toBe(2);
    expect(receiptEvent(undefined, current, taskExitCode(undefined, current))).toMatchObject({ exitCode: 2, cleanup: current.cleanup });
    expect(pick).not.toHaveBeenCalled();
  });
}

for (const choice of ["Stop them", "Leave them running"]) test(`browser recovery ${choice} permits a fresh browser owner`, async () => {
  const f = fixture();
  const issue = incident(choice === "Stop them" ? "stopped" : "unknown");
  const previous = new BrowserSession({ projectRoot: process.cwd(), stateDirectory: os.tmpdir() });
  await previous.close();
  Object.assign(previous, { cleanupError: issue.error });
  f.app.browser = previous;
  expect(previous.status().state).toBe("failed");
  spyOn(f.app.terminal, "pick").mockResolvedValue(choice);
  f.app.blockOnCleanupFailure(issue.error);
  await handlePrompt(f.app, "/hotkeys");
  expect(previous.status().state).toBe("closed");
  f.app.projectContext = { info: { root: process.cwd() }, stateDirectory: os.tmpdir() } as never;
  const next = browserSession(f.app);
  f.app.projectContext = undefined;
  expect(next).not.toBe(previous);
  expect(next.status().state).toBe("idle");
});

test("Stop retries the owner and confirms cleanup only after a fresh empty listing", async () => {
  const f = fixture(); const issue = incident("stopped");
  const pick = spyOn(f.app.terminal, "pick").mockResolvedValue("Stop them");
  // Queuing an incident must not abort the current command or runtime session.
  f.app.commandAbort = new AbortController();
  const abort = async () => {};
  f.app.session = { abort } as never;
  const sessionAbort = spyOn(f.app.session!, "abort");
  f.app.blockOnCleanupFailure(issue.error);
  expect(f.app.commandAbort.signal.aborted).toBe(false);
  expect(sessionAbort).not.toHaveBeenCalled();
  await handlePrompt(f.app, "/hotkeys");
  expect(f.app.getLastTaskResult()?.cleanup?.[0]?.state).toBe("stopped");
  expect(issue.stops()).toBe(1); expect(issue.listings()).toBe(2); expect(pick).toHaveBeenCalledTimes(1);
  expect(taskExitCode(undefined, f.app.getLastTaskResult())).toBe(0);
});

for (const json of [false, true]) test(`unattended recovery (${json ? "JSON" : "one-shot"}) has no picker and exits nonzero`, async () => {
  const f = fixture(json, json); const issue = incident();
  const pick = spyOn(f.app.terminal, "pick");
  f.app.blockOnCleanupFailure(issue.error);
  await handlePrompt(f.app, "/hotkeys");
  const task = f.app.getLastTaskResult()!;
  expect(pick).not.toHaveBeenCalled(); expect(issue.stops()).toBe(0);
  expect(task.cleanup?.[0]).toMatchObject({ state: "unconfirmed", unattended: true });
  const code = taskExitCode(undefined, task);
  expect(code).toBe(2);
  expect(receiptEvent(undefined, task, code)).toMatchObject({ exitCode: 2, outcome: "incomplete", cleanup: task.cleanup });
  await handlePrompt(f.app, "/hotkeys");
  expect(f.app.getLastTaskResult()).toBeUndefined();
});

test("finally catches a cleanup error without wedging later commands, even after an aborted task", async () => {
  const f = fixture(); const issue = incident();
  const pick = spyOn(f.app.terminal, "pick").mockResolvedValue("Leave them running");
  const close = spyOn(f.app.terminal, "takePastedImages").mockImplementation(() => {
    f.app.commandAbort?.abort();
    f.app.checkTask = { close: async () => { throw issue.error; } } as never;
    return new Map();
  });
  await handlePrompt(f.app, "/hotkeys");
  close.mockRestore();
  expect(f.app.getLastTaskResult()?.cleanup?.[0]?.state).toBe("left-running");
  await handlePrompt(f.app, "/hotkeys");
  expect(pick).toHaveBeenCalledTimes(1);
  expect(f.app.commandActive).toBe(false);
});

test("central command errors are recovered once and do not disable later commands", async () => {
  const f = fixture(); const issue = incident();
  const pick = spyOn(f.app.terminal, "pick").mockResolvedValue("Leave them running");
  const dispatch = spyOn(f.app.terminal, "takePastedImages").mockImplementationOnce(() => { throw issue.error; });
  await handlePrompt(f.app, "/hotkeys");
  dispatch.mockRestore();
  expect(f.app.getLastTaskResult()?.cleanup?.[0]?.state).toBe("left-running");
  await handlePrompt(f.app, "/hotkeys");
  expect(pick).toHaveBeenCalledTimes(1);
  expect(f.app.commandActive).toBe(false);
});

test("page-opener cleanup failures are reported rather than swallowed", async () => {
  const f = fixture(false); const issue = incident();
  f.app.taskPageOpener = { async close() { throw issue.error; } } as never;
  await handlePrompt(f.app, "/hotkeys");
  expect(f.app.getLastTaskResult()?.cleanup?.[0]?.state).toBe("unconfirmed");
  expect(f.app.taskPageOpener).toBeUndefined();
});

test("a successful stop claim with live processes still reports unconfirmed", async () => {
  const f = fixture();
  spyOn(f.app.terminal, "pick").mockResolvedValue("Stop them");
  f.app.blockOnCleanupFailure(Object.assign(new ProcessCleanupError(), {
    async running() { return processes; }, async stop() { return "stopped" as const; },
  }));
  await handlePrompt(f.app, "/hotkeys");
  expect(f.app.getLastTaskResult()?.cleanup?.[0]?.state).toBe("unconfirmed");
});

test("ownerless errors and failed rechecks remain unconfirmed, without reprompting", async () => {
  const f = fixture();
  const pick = spyOn(f.app.terminal, "pick").mockResolvedValue("Stop them");
  const error = Object.assign(new ProcessCleanupError(), { async stop() { return "stopped" as const; },
    async running() { throw new Error("listing unavailable"); } });
  f.app.blockOnCleanupFailure(error);
  f.app.blockOnCleanupFailure(new ProcessCleanupError());
  await handlePrompt(f.app, "/hotkeys");
  expect(f.app.getLastTaskResult()?.cleanup?.map(report => report.state)).toEqual(["unconfirmed", "unconfirmed"]);
  expect(pick).toHaveBeenCalledTimes(1);
});

for (const mode of ["callback", "throw", "check-teardown", "browser-teardown"] as const) test(`a model task saves its receipt before propagating ${mode}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cleanup-app-"));
  closes.push(() => removeTempDir(root));
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(home); await mkdir(project);
  await writeFile(path.join(project, "notes.txt"), "A project for a local task.\n");
  const teardown = mode.endsWith("teardown");
  const teardownError = new Error("Task teardown failed");
  if (teardown) {
    await mkdir(path.join(project, ".casper"));
    await writeFile(path.join(project, ".casper", "project.yaml"), 'verify:\n  test: bun -e "console.log(123)"\n');
  }
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const issue = incident();
  let app: CasperApp, output = "", prompts = 0;
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        setTools() {}, async abort() {},
        async prompt(_text, signal) {
          prompts++;
          if (mode === "callback") app.blockOnCleanupFailure(issue.error);
          expect(signal?.aborted).toBe(false);
          if (mode === "throw") throw issue.error;
          if (teardown) {
            await app.checkTask!.run(["test"]);
            if (mode === "check-teardown") spyOn(app.checkTask!, "close").mockRejectedValueOnce(teardownError);
            else app.browser = { status: () => ({ state: "open" }), report: async () => ({ status: "pass", checks: [] }),
              replayStale: async () => {}, close: async () => { app.browser = undefined; throw teardownError; } } as never;
          }
          for (const event of [{ type: "assistant_response_start" }, { type: "assistant_text_delta", delta: "Here is the answer." },
            { type: "assistant_response_end", stopReason: "stop" }] as RuntimeEvent[]) {
            for (const listener of listeners) listener(event);
          }
        },
      };
    },
    async dispose() {},
  };
  const input = Object.assign(new PassThrough(), { isTTY: true });
  app = new CasperApp({ input, runtimeFactory: () => runtime, sessionHomeDir: home, verificationMode: teardown ? "offer" : "off",
    ...(mode === "throw" ? {} : { onEvent() {} }),
    output: { write: text => { output += text; } },
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  closes.push(async () => { await app.close(); input.destroy(); });
  if (mode === "throw") {
    app.interactive = true;
    app.terminal.start();
    spyOn(app.terminal, "pick").mockResolvedValue("Leave them running");
  }
  const run = app.runOnce("Explain this project", project);
  if (teardown) await expect(run).rejects.toBe(teardownError);
  else await run;
  const task = app.getLastTaskResult()!;
  expect(prompts).toBe(1);
  expect(task.execution).toBe(mode === "callback" ? "completed" : "failed");
  expect(task.receipt).toBeGreaterThan(0);
  if (teardown) {
    expect(task.verification?.results).toMatchObject([{ name: "test", status: "pass", exitCode: 0 }]);
  } else {
    expect(task.cleanup?.[0]).toMatchObject({ state: mode === "throw" ? "left-running" : "unconfirmed", processes: [{ pid: 4321, group: 4321 }] });
    expect(taskExitCode(undefined, task)).toBe(mode === "throw" ? 1 : 2);
  }
  const saved = await new ReceiptStore(app.projectContext!.stateDirectory).get(task.receipt!);
  expect(typeof saved).toBe("object");
  if (typeof saved === "string") throw new Error("Saved receipt is unavailable");
  expect(saved.task?.execution).toBe(task.execution);
  expect(saved.task?.cleanup).toEqual(storedTaskResult(task).cleanup);
  if (teardown) expect(saved.task?.verification?.results).toMatchObject([{ name: "test", status: "pass", exitCode: 0,
    command: 'bun -e "console.log(123)"' }]);
  const from = output.length;
  await handlePrompt(app, `/receipt ${task.receipt}`);
  if (teardown) {
    expect(output.slice(from)).toContain("Checks pass (command execution): 1 pass");
  } else {
    expect(output.slice(from)).toContain(mode === "throw" ? "left running by your choice" : "Owned process cleanup unconfirmed");
    expect(output.slice(from)).toContain("PID 4321");
  }
  expect(app.commandActive).toBe(false);
  expect(output).not.toContain("cleanup-sensitive-value");
});

test("cleanup receipts render PID commands safely, persist the choice, and cannot claim checks passed", () => {
  const task: TaskResult = { execution: "completed", cleanup: [{ state: "left-running", processes }],
    verification: { status: "pass", results: [], rounds: [], repairAttempts: 0 } };
  expect(taskExitCode(undefined, task)).toBe(2);
  expect(checksPassed(undefined, task)).toBe(false);
  for (const text of [formatShortReceipt(task), formatTaskResult(task), receiptEvent(undefined, task, 2).text,
    JSON.stringify(storedTaskResult(task))]) {
    expect(text).toContain("4321"); expect(text).toContain("worker");
    expect(text).not.toContain("cleanup-sensitive-value"); expect(text).not.toMatch(/[\u001b\u202e]/);
  }
  expect(formatShortReceipt(task)).toContain("left running by your choice");
  expect(storedTaskResult(task).cleanup?.[0]?.state).toBe("left-running");
});
