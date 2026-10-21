import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { formatReceipt } from "../src/task/result";
import { checkCommand } from "./support/check-command";
import { removeTempDir } from "./support/temp-dir";

// Found in a real-terminal test: a provider error right after an edit left the edit unchecked.
for (const check of ["pass", "fail"] as const) test(`a model that fails after editing still gets its edits checked, without a repair (${check})`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-model-failed-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, "calc.py"), "def add(a, b):\n    return a - b\n");
  await writeFile(path.join(project, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(checkCommand(...(check === "fail" ? ["exit:1"] : [])))}\n`);
  const listeners = new Set<RuntimeEventListener>();
  let prompts = 0;
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => {
          prompts++;
          await writeFile(path.join(project, "calc.py"), "def add(a, b):\n    return a + b\n");
          for (const listener of listeners) listener({ type: "tool_end", toolName: "write", toolCallId: `w${prompts}`, isError: false });
          for (const listener of listeners) listener({ type: "error", message: "Provider returned an empty response" });
        },
      };
    },
    async dispose() {},
  };
  let output = "";
  const waits: number[] = [];
  const app = new CasperApp({
    output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    modelRetryWait: async (ms) => { waits.push(ms); },
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  try {
    await app.runOnce("Fix the bug in add", project);
    expect(output).toContain("[error] Provider returned an empty response");
    expect(output).toContain("• Casper checking the edits the model made before it failed: test");
    expect(output).toContain(check === "pass"
      ? "✗ Failed — the model run failed; changes already made are kept; the checks pass on those changes"
      : "✗ Failed — the model run failed; changes already made are kept; on those changes test failed");
    expect(output).toContain(`– Next: casper --model <provider/id> "…" to try another model`);
    // Three automatic retries of the provider failure, 1s, 2s and 4s apart, then the edits are checked.
    expect(output).toContain("… The model failed · trying again in 1s (1 of 3)\n");
    expect(output).toContain("… The model failed · trying again in 2s (2 of 3)\n");
    expect(output).toContain("… The model failed · trying again in 4s (3 of 3)\n");
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(prompts).toBe(4);
    expect(app.getLastTaskResult()?.verification?.repairAttempts).toBe(0);
  } finally {
    await app.close();
    await removeTempDir(root);
  }
}, 30_000);

// On a NAS: the sign-in had expired, so the model failed at once, while the running app wrote its database next to the
// code. Casper said "checking the edits the model made" and ran go test and go build (go isn't installed there).
test("a model that failed before running any tool gets no checks, though a file changed meanwhile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-model-failed-early-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true }); await mkdir(path.join(project, "data"));
  await writeFile(path.join(project, "calc.py"), "def add(a, b):\n    return a + b\n");
  await writeFile(path.join(project, "data/app.db-wal"), "one");
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
          await writeFile(path.join(project, "data/app.db-wal"), `${Date.now()}${Math.random()}`);
          for (const listener of listeners) listener({ type: "error", message: "Failed to authenticate: OAuth session expired" });
        },
      };
    },
    async dispose() {},
  };
  let output = "";
  const app = new CasperApp({
    output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home, modelRetryWait: async () => {},
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  try {
    await app.runOnce("hey", project);
    expect(output).toContain("OAuth session expired");
    expect(output).not.toContain("Casper checking the edits the model made");
    expect(app.getLastTaskResult()?.verification?.results ?? []).toEqual([]);
  } finally {
    await app.close();
    await removeTempDir(root);
  }
}, 30_000);

test("a failed run that changed nothing says so and points to another model", () => {
  expect(formatReceipt({ execution: "failed", changedPaths: [] }, { surface: "interactive" }))
    .toBe("✗ Failed — the model run failed before changing any files\n– No files changed\n– Next: /model to try another model, then ask again");
});

test("a provider failure that clears on the automatic retry finishes the task normally", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-model-retry-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(checkCommand())}\n`);
  const listeners = new Set<RuntimeEventListener>();
  let prompts = 0;
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => {
          if (++prompts === 1) { for (const listener of listeners) listener({ type: "error", message: "Provider returned an empty response" }); return; }
          await writeFile(path.join(project, "notes.md"), "done\n");
        },
      };
    },
    async dispose() {},
  };
  let output = "";
  const app = new CasperApp({
    output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home, modelRetryWait: async () => {},
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  try {
    await app.runOnce("Write the notes", project);
    expect(prompts).toBe(2);
    expect(output).toContain("… The model failed · trying again in 1s (1 of 3)\n");
    expect(output).not.toContain("(2 of 3)");
    expect(app.getLastTaskResult()?.execution).toBe("completed");
    expect(output).not.toContain("the model run failed");
  } finally {
    await app.close();
    await removeTempDir(root);
  }
}, 30_000);

test("in the terminal, a provider failure after three automatic retries asks whether to retry or stop", async () => {
  const { PassThrough } = await import("node:stream");
  const { fakeWriter } = await import("./support/tty");
  process.env.TERM = "xterm-256color";
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-model-ask-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(project); await writeFile(path.join(project, "notes.txt"), "An empty folder would ask about a new project.\n");
  const listeners = new Set<RuntimeEventListener>();
  let prompts = 0;
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => { prompts++; for (const listener of listeners) listener({ type: "error", message: "Provider returned an empty response" }); },
      };
    },
    async dispose() {},
  };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter();
  const app = new CasperApp({
    input, output: screen.writer, runtimeFactory: () => runtime, sessionHomeDir: home, modelRetryWait: async () => {},
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = app.runInteractive(project);
  try {
    await screen.until((output) => output.includes("idle"));
    input.write("fix it\r");
    await screen.until((output) => Bun.stripANSI(output).includes("The model failed again. What now?"));
    expect(prompts).toBe(4);
    expect(Bun.stripANSI(screen.output)).toContain("… The model failed · trying again in 4s (3 of 3) · Esc stops");
    input.write("\r"); // Enter picks 1 Stop: no more tokens.
    await screen.until((output) => { const text = Bun.stripANSI(output); const at = text.lastIndexOf("✗ Failed: the model run failed"); return at >= 0 && text.lastIndexOf("idle") > at; });
    expect(prompts).toBe(4);
  } finally {
    input.write("/exit\r");
    await interactive;
    await app.close();
    input.destroy();
    await removeTempDir(root);
  }
}, 30_000);

test("Esc while Casper waits to retry a failed model stops the retries at once", async () => {
  const { PassThrough } = await import("node:stream");
  const { fakeWriter } = await import("./support/tty");
  process.env.TERM = "xterm-256color";
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-model-cancel-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(project); await writeFile(path.join(project, "notes.txt"), "An empty folder would ask about a new project.\n");
  const listeners = new Set<RuntimeEventListener>();
  let prompts = 0;
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => { prompts++; for (const listener of listeners) listener({ type: "error", message: "Provider returned an empty response" }); },
      };
    },
    async dispose() {},
  };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter();
  const app = new CasperApp({
    // A wait that never ends by itself: only the cancel can end it.
    input, output: screen.writer, runtimeFactory: () => runtime, sessionHomeDir: home, modelRetryWait: () => new Promise(() => {}),
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = app.runInteractive(project);
  try {
    await screen.until((output) => output.includes("idle"));
    input.write("fix it\r");
    await screen.until((output) => Bun.stripANSI(output).includes("trying again in 1s (1 of 3)"));
    input.write("\x1b");
    await screen.until((output) => { const text = Bun.stripANSI(output); const at = text.lastIndexOf("[cancel] Stopping."); return at >= 0 && text.lastIndexOf("idle") > at; });
    expect(prompts).toBe(1);
    expect(Bun.stripANSI(screen.output)).not.toContain("(2 of 3)");
    expect(Bun.stripANSI(screen.output)).not.toContain("What now?");
  } finally {
    input.write("/exit\r");
    await interactive;
    await app.close();
    input.destroy();
    await removeTempDir(root);
  }
}, 30_000);

test("a check that was already failing before the change is named as such; in the terminal Casper asks before repairing it", async () => {
  const { PassThrough } = await import("node:stream");
  const { fakeWriter } = await import("./support/tty");
  process.env.TERM = "xterm-256color";
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-preexisting-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, "calc.py"), "def add(a, b):\n    return a - b\n");
  // Inline failure is portable to the proof copy; an outside fixture script cannot be imported there.
  await writeFile(path.join(project, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(`"${process.execPath}" -e "process.exit(1)" -- fixture`)}\nverification:\n  mode: auto\n`);
  let prompts = 0;
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: () => () => {}, abort: async () => {}, setTools: () => {},
        prompt: async () => { prompts++; await writeFile(path.join(project, "calc.py"), `def add(a, b):\n    return a + b  # ${prompts}\n`); },
      };
    },
    async dispose() {},
  };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter();
  const app = new CasperApp({
    input, output: screen.writer, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = app.runInteractive(project);
  try {
    await screen.until((output) => output.includes("idle"));
    input.write("fix the add function\r");
    await screen.until((output) => Bun.stripANSI(output).includes("test was already failing before this change. Fix it anyway?"));
    expect(Bun.stripANSI(screen.output)).toContain("– test was already failing before this change (Casper ran it on the files from before)");
    input.write("\r"); // Enter picks 1 Leave it: no repair.
    // The receipt says the change did not cause it, instead of leading with ✗ Failed.
    const verdict = "⚠ Not caused by this change: test already failed before it; left as it is";
    await screen.until((output) => { const text = Bun.stripANSI(output); const at = text.lastIndexOf(verdict); return at >= 0 && text.lastIndexOf("idle") > at; });
    expect(Bun.stripANSI(screen.output)).not.toContain("✗ Failed: test failed");
    expect(prompts).toBe(1);
    expect(app.getLastTaskResult()?.verification?.repairAttempts).toBe(0);
  } finally {
    input.write("/exit\r");
    await interactive;
    await app.close();
    input.destroy();
    await removeTempDir(root);
  }
}, 30_000);
