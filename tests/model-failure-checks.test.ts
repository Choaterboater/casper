import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { formatReceipt } from "../src/task/result";
import { checkCommand } from "./support/check-command";

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
    expect(output).toContain("… Casper checking the edits the model made before it failed: test");
    expect(output).toContain(check === "pass"
      ? "✗ Failed — the model run failed; changes already made are kept; the checks pass on those changes"
      : "✗ Failed — the model run failed; changes already made are kept; on those changes test failed");
    expect(output).toContain(`• Next: casper --model <provider/id> "…" to try another model`);
    expect(prompts).toBe(1);
    expect(app.getLastTaskResult()?.verification?.repairAttempts).toBe(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("a failed run that changed nothing says so and points to another model", () => {
  expect(formatReceipt({ execution: "failed", changedPaths: [] }, { surface: "interactive" }))
    .toBe("✗ Failed — the model run failed; changes already made are kept\n• No files changed\n• Nothing was changed. /model picks another model");
});
