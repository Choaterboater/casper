import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { leavesFilesHere } from "../src/app/local-effect";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
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
      expect(formatReceipt(result, { surface: "interactive" })).toContain("– Changed meanwhile by another program, not the AI (not checked): src/app.py");
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
  // The database itself, or code beside it, still runs them.
  expect(planAutoChecks({ commands, changedPaths: ["data/glance.db"] }).run).toEqual(["test", "build"]);
  expect(planAutoChecks({ commands, changedPaths: ["data/glance.db-wal", "main.go"] }).run).toEqual(["test", "build"]);
  const receipt = formatReceipt({ execution: "completed", changedPaths: ["data/glance.db-wal"], autoSkipped: "app-data", verificationMode: "auto" }, { surface: "interactive" });
  expect(receipt).toContain("– Checks skipped — only a running app's database files changed (data/glance.db-wal); /verify runs them anyway.");
});
