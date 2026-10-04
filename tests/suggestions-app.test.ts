import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { bundledFlows, findFlow } from "../src/flows/catalog";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { checkCommand } from "./support/check-command";

/** An interactive app on the plain terminal. The fake model edits calc.py; `shell` makes it also run that command
 * through bash first. */
async function fixture(options: { projectYaml: string; shell?: string }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-suggestions-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home, { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, "calc.py"), "def add(a, b):\n    return a - b\n");
  await writeFile(path.join(project, ".casper/project.yaml"), options.projectYaml);
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const prompts: string[] = [];
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async (text) => {
          prompts.push(text);
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          if (options.shell) {
            emit({ type: "tool_start", toolName: "bash", toolCallId: `t${prompts.length}`, input: { command: options.shell } });
            emit({ type: "tool_end", toolName: "bash", toolCallId: `t${prompts.length}`, input: { command: options.shell }, output: { text: "1 passed", truncated: false }, isError: false });
          }
          await writeFile(path.join(project, "calc.py"), `def add(a, b):\n    return a + b  # ${prompts.length}\n`);
          emit({ type: "assistant_text_delta", delta: "Done.\n" });
          emit({ type: "assistant_response_end", stopReason: "stop" });
        },
      };
    },
    async dispose() {},
  };
  const input = new PassThrough();
  let output = "";
  const waiters: Array<{ test: () => boolean; resolve: () => void }> = [];
  const app = new CasperApp({
    input, output: { write: (text: string) => {
      output += text;
      for (const waiter of [...waiters]) if (waiter.test()) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
    } },
    runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const until = (test: () => boolean) => {
    if (test()) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push({ test, resolve });
    return promise;
  };
  const interactive = app.runInteractive(project);
  /** Sends a line and waits for Casper to be back at the prompt after the work it started. */
  const send = async (line: string, done: RegExp) => {
    const from = output.length;
    input.write(`${line}\n`);
    await until(() => done.test(output.slice(from)));
    return output.slice(from);
  };
  const receipt = /(?:✓ Verified|• Not verified|• Checks passed|✗ Failed|• No files changed|✓ Changed)[\s\S]*\n> $/;
  return { app, project, home, prompts, send, receipt, output: () => output, close: async () => {
    input.end(); await interactive; await app.close(); await rm(root, { recursive: true, force: true });
  } };
}

const PASSING = `verify:\n  test: ${JSON.stringify(checkCommand())}\nverification:\n  mode: auto\n  checklist: false\nrepair:\n  maxAttempts: 0\n`;

test("a fix whose tests pass without it gets \"Add a test\" on the row; its number sends the prove-fix flow", async () => {
  const f = await fixture({ projectYaml: PASSING });
  try {
    const first = await f.send("fix the add function in calc.py", f.receipt);
    expect(first).toContain("Next: 1 Show diff · 2 Undo · 3 Add a test that proves this bug stays fixed (uses tokens)\n  3: the tests pass without your fix too\n");
    expect(first).toContain("  A number picks one · type to ask something else · /suggestions off stops these\n");
    // Slots 1 and 2 are Undo and Show diff of this task.
    expect(first).toContain("Next: 1 Show diff · 2 Undo · 3 Add a test");
    const flow = findFlow(bundledFlows(), "prove-fix")!;
    await f.send("3", f.receipt);
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain(flow.body.trim());
    expect(f.prompts[1]).toContain("Add a test that proves this bug stays fixed");
    expect(f.prompts[1]).toContain("The fix was for: fix the add function in calc.py");
    // A number typed later is not a pick: nothing is on offer from a receipt that was left.
    const stale = await f.send("/suggestion prove-fix", /\n> $/);
    expect(stale).toContain("[suggestions] That suggestion is not on offer now.");
    expect(f.prompts).toHaveLength(2);
  } finally { await f.close(); }
}, 60_000);

test("ignored three times in a row, a suggestion fades in this project; typed text is simply the next request", async () => {
  const f = await fixture({ projectYaml: PASSING });
  try {
    expect(await f.send("fix the add function in calc.py", f.receipt)).toContain("Next: 1 Show diff · 2 Undo · 3 Add a test");
    expect(await f.send("fix the add function in calc.py again", f.receipt)).toContain("Next: 1 Show diff · 2 Undo · 3 Add a test");
    expect(f.prompts[1]).toContain("fix the add function in calc.py again");
    expect(await f.send("fix the add function in calc.py once more", f.receipt)).toContain("Next: 1 Show diff · 2 Undo · 3 Add a test");
    const faded = await f.send("fix the add function in calc.py for the last time", f.receipt);
    expect(faded).not.toContain("Add a test");
    const listed = await f.send("/suggestions", /\n> $/);
    expect(listed).toMatch(/prove-fix\s+faded \(hidden here until \d{4}-\d\d-\d\d\)/);
    await f.send("/suggestions on prove-fix", /\n> $/);
    expect(await f.send("fix the add function in calc.py", f.receipt)).toContain("Next: 1 Show diff · 2 Undo · 3 Add a test");
  } finally { await f.close(); }
}, 60_000);

test("/suggestions off silences the row on the next task, and on brings it back", async () => {
  const f = await fixture({ projectYaml: PASSING });
  try {
    expect(await f.send("/suggestions off", /\n> $/)).toContain("[suggestions] All suggestions off everywhere.");
    expect(await f.send("fix the add function in calc.py", f.receipt)).not.toContain("Add a test");
    expect(await f.send("/suggestions", /\n> $/)).toMatch(/prove-fix\s+off/);
    await f.send("/suggestions on", /\n> $/);
    expect(await f.send("fix the add function in calc.py", f.receipt)).toContain("Next: 1 Show diff · 2 Undo · 3 Add a test");
  } finally { await f.close(); }
}, 60_000);

test("Remember saves the test command the model ran, exactly as shown, and keeps the file's comments", async () => {
  const yaml = "# Casper settings for this project\nverification:\n  checklist: false # no list before work\n";
  const f = await fixture({ projectYaml: yaml, shell: "uv run pytest" });
  try {
    const first = await f.send("fix the add function in calc.py", f.receipt);
    expect(first).toContain("Next: 1 Show diff · 2 Undo · 3 Remember uv run pytest as this project's test command (free)\n"
      + "  3: the model ran it without error; saves verify.test: uv run pytest in .casper/project.yaml so Casper can check every change\n");
    const saved = await f.send("3", /\n> $/);
    expect(saved).toContain("[project] Saved verify.test: uv run pytest in .casper/project.yaml");
    expect(f.prompts).toHaveLength(1);
    const text = await readFile(path.join(f.project, ".casper/project.yaml"), "utf8");
    expect(text).toContain("# Casper settings for this project");
    expect(text).toContain("checklist: false # no list before work");
    expect(text).toContain("verify:\n  test: uv run pytest\n");
    // Saving is undoable: its own receipt takes the file back to what it was, and /redo saves it again.
    expect(saved).toContain("[project] Saved verify.test: uv run pytest in .casper/project.yaml. /undo 2 takes it back\nNext: 2 Undo\n");
    const undone = await f.send("2", /\n> $/);
    expect(undone).toContain("✓ Undone — .casper/project.yaml is back as it was before task 2 (verify.test: uv run pytest is no longer saved).");
    expect(await readFile(path.join(f.project, ".casper/project.yaml"), "utf8")).toBe(yaml);
    await f.send("/redo", /\n> $/);
    expect(await readFile(path.join(f.project, ".casper/project.yaml"), "utf8")).toBe(text);
  } finally { await f.close(); }
}, 60_000);

test("a command that is not a known test runner is never offered", async () => {
  const f = await fixture({ projectYaml: "verification:\n  checklist: false\n", shell: "uv run --with evil pytest" });
  try {
    expect(await f.send("fix the add function in calc.py", f.receipt)).not.toContain("Remember");
  } finally { await f.close(); }
}, 60_000);

test("a one-shot run never shows suggestions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-suggestions-once-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, "calc.py"), "def add(a, b):\n    return a - b\n");
  await writeFile(path.join(project, ".casper/project.yaml"), PASSING);
  let output = "";
  const runtime: AgentRuntime = {
    start: async () => ({
      getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
      getState: () => ({ cwd: project, isStreaming: false }),
      subscribe: () => () => {}, abort: async () => {}, setTools: () => {},
      prompt: async () => { await writeFile(path.join(project, "calc.py"), "def add(a, b):\n    return a + b\n"); },
    }),
    dispose: async () => {},
  };
  const app = new CasperApp({ output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }) });
  try {
    await app.runOnce("fix the add function in calc.py", project);
    expect(output).toContain("Not proven");
    expect(output).not.toContain("Next:");
    expect(output).not.toContain("Add a test that proves");
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
