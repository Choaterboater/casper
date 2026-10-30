import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { leavesFilesHere } from "../src/app/local-effect";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { ATTRIBUTION_SLACK_MS } from "../src/task/attribution";
import { formatReceipt } from "../src/task/result";
import { checkCommand } from "./support/check-command";
import { removeTempDir } from "./support/temp-dir";

/**
 * On a PC whose AI only ran `ssh nas '...'` (work on another machine), files another program changed in the project
 * meanwhile were checked as the AI's work and offered as "The work is in ...". Casper now tells them apart.
 */

test("reads, searches and one plain ssh leave files here alone; anything else may change them", () => {
  const root = "/r";
  for (const [tool, input] of [["read", { path: "a" }], ["grep", {}], ["web_fetch", {}], ["bash", { command: "ssh nas uptime" }],
    ["bash", { command: "ssh -o BatchMode=yes -o ConnectTimeout=10 nas 'docker ps'" }]] as const) {
    expect([tool, input, leavesFilesHere(tool, input, root)]).toEqual([tool, input, true]);
  }
  for (const [tool, input] of [["write", { path: "a" }], ["edit", {}], ["bash", { command: "npm test" }], ["bash", { command: "ssh nas cat x > x" }],
    ["bash", { command: "ssh nas uptime; touch a" }], ["bash", { command: "scp nas:/etc/hosts ." }], ["bash", {}], ["delegate", {}], ["mcp_tool", {}]] as const) {
    expect([tool, input, leavesFilesHere(tool, input, root)]).toEqual([tool, input, false]);
  }
});

for (const command of ["ssh nas uptime", "echo hi > notes.txt"]) test(`a file another program changes while the AI runs \`${command}\``, async () => {
  const remote = command.startsWith("ssh");
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-others-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true }); await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "src/app.py"), "x = 1\n");
  await writeFile(path.join(project, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(checkCommand())}\n`);
  const listeners = new Set<RuntimeEventListener>();
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => {
          for (const listener of listeners) listener({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: { command } });
          // Another program (an editor, a second session) saves a file in the project meanwhile.
          await writeFile(path.join(project, "src/app.py"), "x = 2\n");
          for (const listener of listeners) listener({ type: "tool_end", toolName: "bash", toolCallId: "b1", isError: false, input: { command } });
          for (const listener of listeners) listener({ type: "assistant_text_delta", delta: "Done." });
        },
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
  try {
    await app.runOnce("check the nas", project);
    const result = app.getLastTaskResult()!;
    if (remote) {
      expect(result.changedPaths ?? []).toEqual([]);
      expect(result.changedNotByModel).toEqual(["src/app.py"]);
      expect(output).not.toContain("Casper checking");
      expect(formatReceipt(result, { surface: "interactive" })).toContain("– Changed by something else while Casper worked (not checked): src/app.py");
    } else {
      // A local shell command may have made the change: it stays the AI's, and is checked.
      expect(result.changedPaths).toContain("src/app.py");
      expect(result.changedNotByModel).toBeUndefined();
    }
  } finally {
    await app.close();
    await removeTempDir(root);
  }
}, 30_000);

test("only a running app's database journal changed: no checks, and the receipt says why", async () => {
  const { planAutoChecks } = await import("../src/verify/mode");
  const commands = { test: "go test ./...", build: "go build ./..." };
  expect(planAutoChecks({ commands, changedPaths: ["data/glance.db-wal", "data/glance.db-shm"] })).toEqual({ run: [], skipped: "app-data" });
  expect(planAutoChecks({ commands, changedPaths: ["data/app.sqlite-journal", "README.md"] })).toEqual({ run: [], skipped: "docs-only" });
  // The database file itself too (the app wrote it, not the AI); code beside them still runs the checks.
  expect(planAutoChecks({ commands, changedPaths: ["data/glance.db", "data/glance.db-wal", "docs/debug-report.md"] })).toEqual({ run: [], skipped: "docs-only" });
  expect(planAutoChecks({ commands, changedPaths: ["data/glance.db"] })).toEqual({ run: [], skipped: "app-data" });
  expect(planAutoChecks({ commands, changedPaths: ["data/glance.db-wal", "main.go"] }).run).toEqual(["test", "build"]);
  const receipt = formatReceipt({ execution: "completed", changedPaths: ["data/glance.db-wal"], autoSkipped: "app-data", verificationMode: "auto" }, { surface: "interactive" });
  expect(receipt).toContain("– Checks skipped — only a running app's database files changed (data/glance.db-wal); /verify runs them anyway.");
});

/** A fake model whose `turn` emits tool events and writes files; one app per call, in `home`. */
function othersApp(home: string, project: string, turn: (emit: (event: Parameters<RuntimeEventListener>[0]) => void) => Promise<void>, input?: PassThrough) {
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
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
    ...(input ? { input } : {}),
    output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  return { app, output: () => output };
}

/** Longer than the time slack: a save after this is clearly outside the command's run. */
const PAST_SLACK_MS = ATTRIBUTION_SLACK_MS + 600;

test("a file another program saves while Casper waits between commands is not the task's: not checked, and undo leaves it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-others-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, "app.py"), "x = 1\n");
  await writeFile(path.join(project, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(checkCommand())}\n`);
  const made = othersApp(home, project, async (emit) => {
    // The AI's shell command changes app.py while it runs.
    emit({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: { command: "python3 fix.py" } });
    await writeFile(path.join(project, "app.py"), "x = 2\n");
    emit({ type: "tool_end", toolName: "bash", toolCallId: "b1", isError: false, input: { command: "python3 fix.py" } });
    // Then it waits on a question (a read), and another AI tool saves its own file in the folder meanwhile.
    emit({ type: "tool_start", toolName: "ask", toolCallId: "a1", input: {} });
    await Bun.sleep(PAST_SLACK_MS);
    await writeFile(path.join(project, "PROJECT_SUMMARY.md"), "# notes from another program\n");
    await Bun.sleep(PAST_SLACK_MS);
    emit({ type: "tool_end", toolName: "ask", toolCallId: "a1", isError: false, input: {} });
  });
  try {
    await made.app.runOnce("fix app.py", project);
    const result = made.app.getLastTaskResult()!;
    expect(result.changedPaths).toEqual(["app.py"]);
    expect(result.changedNotByModel).toEqual(["PROJECT_SUMMARY.md"]);
    expect(formatReceipt(result, { surface: "interactive" })).toContain("– Changed by something else while Casper worked (not checked): PROJECT_SUMMARY.md");
  } finally { await made.app.close(); }
  const later = othersApp(home, project, async () => {});
  try {
    await later.app.runOnce("/undo", project);
    expect(await readFile(path.join(project, "app.py"), "utf8")).toBe("x = 1\n");
    // Never Casper's: it stays as the other program left it.
    expect(await readFile(path.join(project, "PROJECT_SUMMARY.md"), "utf8")).toBe("# notes from another program\n");
    expect(later.output()).toContain("– Left as it is: PROJECT_SUMMARY.md (changed by something else while Casper worked)");
  } finally {
    await later.app.close();
    await removeTempDir(root);
  }
}, 40_000);

test("a file deleted while no tool of the AI's ran: Casper can't tell, so undo asks, and a run that can't ask leaves it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-others-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, "notes"), { recursive: true });
  await writeFile(path.join(project, "app.py"), "x = 1\n");
  await writeFile(path.join(project, "notes/old.md"), "old\n");
  const made = othersApp(home, project, async (emit) => {
    emit({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: { command: "python3 fix.py" } });
    await writeFile(path.join(project, "app.py"), "x = 2\n");
    emit({ type: "tool_end", toolName: "bash", toolCallId: "b1", isError: false, input: { command: "python3 fix.py" } });
    await Bun.sleep(PAST_SLACK_MS);
    await rm(path.join(project, "notes/old.md"));
    await Bun.sleep(PAST_SLACK_MS);
  });
  try {
    await made.app.runOnce("fix app.py", project);
    const result = made.app.getLastTaskResult()!;
    // On the receipt it stays the task's change: a deletion has no time of its own.
    expect(result.changedPaths).toEqual(["app.py", "notes/old.md"]);
    expect(result.changedUnsure).toEqual(["notes/old.md"]);
  } finally { await made.app.close(); }
  const later = othersApp(home, project, async () => {});
  try {
    await later.app.runOnce("/undo", project);
    expect(await readFile(path.join(project, "app.py"), "utf8")).toBe("x = 1\n");
    expect(await readFile(path.join(project, "notes/old.md"), "utf8").catch(() => "gone")).toBe("gone");
    expect(later.output()).toContain("– Left as it is: notes/old.md (Casper can't tell whether task 1 changed it)");
  } finally {
    await later.app.close();
    await removeTempDir(root);
  }
}, 40_000);

test("in a session, undo asks about a file it can't tell is the task's, and Enter leaves it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-others-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, "notes"), { recursive: true });
  await writeFile(path.join(project, "app.py"), "x = 1\n");
  await writeFile(path.join(project, "notes/old.md"), "old\n");
  const input = new PassThrough();
  const made = othersApp(home, project, async (emit) => {
    emit({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: { command: "python3 fix.py" } });
    await writeFile(path.join(project, "app.py"), "x = 2\n");
    emit({ type: "tool_end", toolName: "bash", toolCallId: "b1", isError: false, input: { command: "python3 fix.py" } });
    await Bun.sleep(PAST_SLACK_MS);
    await rm(path.join(project, "notes/old.md"));
    await Bun.sleep(PAST_SLACK_MS);
  }, input);
  const running = made.app.runInteractive(project);
  const send = async (line: string, done: RegExp = /\n> $/) => {
    const from = made.output().length;
    input.write(`${line}\n`);
    const deadline = Date.now() + 25_000;
    while (!done.test(made.output().slice(from))) {
      if (Date.now() > deadline) throw new Error(`no ${done} in:\n${made.output().slice(from)}`);
      await Bun.sleep(20);
    }
    return made.output().slice(from);
  };
  try {
    await send("fix app.py");
    const asked = await send("/undo", /Type 1 or 2: $/);
    expect(asked).toContain("Casper can't tell whether task 1 changed notes/old.md: another program may have.\n  1 Leave it · it stays as it is now\n  2 Undo it too · put it back as before the task\n");
    expect(await send("")).toContain("– Left as it is: notes/old.md (Casper can't tell whether task 1 changed it)");
    expect(await readFile(path.join(project, "app.py"), "utf8")).toBe("x = 1\n");
    expect(await readFile(path.join(project, "notes/old.md"), "utf8").catch(() => "gone")).toBe("gone");
  } finally {
    input.end(); await running; await made.app.close();
    await removeTempDir(root);
  }
}, 40_000);
