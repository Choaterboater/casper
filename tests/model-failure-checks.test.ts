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
          for (const listener of listeners) listener({ type: "error", message: "Provider returned an empty response" });
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
    await app.runOnce("Fix the bug in add", project);
    expect(output).toContain("[error] Provider returned an empty response");
    expect(output).toContain("• Casper checking the edits the model made before it failed: test");
    expect(output).toContain(check === "pass"
      ? "✗ Failed — the model run failed; changes already made are kept; the checks pass on those changes"
      : "✗ Failed — the model run failed; changes already made are kept; on those changes test failed");
    expect(output).toContain(`– Next: casper --model <provider/id> "…" to try another model`);
    // One automatic retry of the provider failure, then the edits are checked.
    expect(output).toContain("[model] The model failed; trying once more.");
    expect(prompts).toBe(2);
    expect(app.getLastTaskResult()?.verification?.repairAttempts).toBe(0);
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
    output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  try {
    await app.runOnce("Write the notes", project);
    expect(prompts).toBe(2);
    expect(output).toContain("[model] The model failed; trying once more.");
    expect(app.getLastTaskResult()?.execution).toBe("completed");
    expect(output).not.toContain("the model run failed");
  } finally {
    await app.close();
    await removeTempDir(root);
  }
}, 30_000);

test("in the terminal, a second provider failure asks whether to retry or stop", async () => {
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
    input.write("fix it\r");
    await screen.until((output) => Bun.stripANSI(output).includes("The model failed again. What now?"));
    expect(prompts).toBe(2);
    input.write("\r"); // Enter picks 1 Stop: no more tokens.
    await screen.until((output) => { const text = Bun.stripANSI(output); const at = text.lastIndexOf("✗ Failed — the model run failed"); return at >= 0 && text.lastIndexOf("idle") > at; });
    expect(prompts).toBe(2);
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
  await writeFile(path.join(project, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(checkCommand("exit:1"))}\nverification:\n  mode: auto\n`);
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
    await screen.until((output) => { const text = Bun.stripANSI(output); const at = text.lastIndexOf("✗ Failed — test failed"); return at >= 0 && text.lastIndexOf("idle") > at; });
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
