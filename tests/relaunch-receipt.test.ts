import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { findMoves, movedInto } from "../src/task/changes";
import { formatReceipt, receiptView } from "../src/task/result";
import { cardRows, receiptCard } from "../src/tui/receipt-card";
import { checkCommand } from "./support/check-command";
import { removeTempDir } from "./support/temp-dir";

/**
 * The smoke session's "same score again": the AI moved run 1 into run-1/ and relaunched the comparison, whose runner
 * wrote a new build under runs/ and its logs. Casper then demanded a test proving an earlier turn's change, ran a repair
 * for it, and the receipt said "Changed 158 files", listed 24 moved config files, "app smoke did not finish" and
 * flagged the runner's logs as app data a repair changed.
 */

test("a move is found by content and said as where the files went", () => {
  const before = new Map([["runs/casper/app/server.js", "a"], ["builds/A/package.json", "b"], ["scripts/run.mjs", "c"]]);
  const after = new Map([["run-1/runs/casper/app/server.js", "a"], ["run-1/builds/A/package.json", "b"], ["scripts/run.mjs", "c2"]]);
  const moves = findMoves(before, after, { added: ["run-1/builds/A/package.json", "run-1/runs/casper/app/server.js"], modified: ["scripts/run.mjs"],
    removed: ["builds/A/package.json", "runs/casper/app/server.js"] });
  expect(moves).toEqual([{ from: "builds/A/package.json", to: "run-1/builds/A/package.json" }, { from: "runs/casper/app/server.js", to: "run-1/runs/casper/app/server.js" }]);
  // Written anew at the old path after the move: still a move, and the old path's new file is a change.
  expect(findMoves(new Map([["a.js", "1"]]), new Map([["a.js", "2"], ["old/a.js", "1"]]), { added: ["old/a.js"], modified: ["a.js"], removed: [] }))
    .toEqual([{ from: "a.js", to: "old/a.js", rewritten: true }]);
  expect(movedInto(moves)).toBe("run-1/");
  expect(movedInto([{ to: "a/x" }, { to: "b/y" }])).toBe("a/ and b/");
});

test("moving a run aside and relaunching it asks for no proof or repair, and the receipt says one line for the move", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-relaunch-"));
  const home = path.join(root, "home"), project = path.join(root, "project");
  try {
    await mkdir(home, { recursive: true });
    for (const folder of ["scripts", "runs/casper/app/config", "builds/A/config", "logs", ".casper"]) await mkdir(path.join(project, folder), { recursive: true });
    await writeFile(path.join(project, "scripts/run.mjs"), "export const run = 1;\n");
    await writeFile(path.join(project, "runs/casper/app/server.js"), "require('http').createServer().listen(3000);\n");
    await writeFile(path.join(project, "runs/casper/app/config/settings.yaml"), "theme: dark\n");
    await writeFile(path.join(project, "builds/A/config/widgets.yaml"), "- weather\n");
    await writeFile(path.join(project, "builds/A/package.json"), "{\"name\":\"a\"}\n");
    await writeFile(path.join(project, "logs/casper.json"), "{}\n");
    await writeFile(path.join(project, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(checkCommand())}\n`);
    const prompts: string[] = [];
    const listeners = new Set<RuntimeEventListener>();
    const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
    const runtime: AgentRuntime = {
      async start() {
        return {
          getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
          getState: () => ({ cwd: project, isStreaming: false }),
          subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
          abort: async () => {}, setTools: () => {},
          prompt: async (text: string) => {
            prompts.push(text);
            if (prompts.length > 1) return;
            const command = "mkdir run-1 && mv runs builds run-1/ && node -e 'spawn detached runner'";
            emit({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: { command } });
            await mkdir(path.join(project, "run-1"));
            await rename(path.join(project, "runs"), path.join(project, "run-1/runs"));
            await rename(path.join(project, "builds"), path.join(project, "run-1/builds"));
            // The relaunched runner: a new build and its log.
            await mkdir(path.join(project, "runs/casper/app"), { recursive: true });
            await writeFile(path.join(project, "runs/casper/app/server.js"), "require('http').createServer().listen(4000);\n");
            await writeFile(path.join(project, "logs/casper.json"), "{\"run\":2}\n");
            emit({ type: "tool_end", toolName: "bash", toolCallId: "b1", isError: false, input: { command } });
            emit({ type: "assistant_text_delta", delta: "The second comparison is running." });
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
      await app.runOnce("same score again", project);
      const task = app.getLastTaskResult()!;
      // No round asking for a test that fails without "the change": only the request's own turn ran.
      expect(prompts).toHaveLength(1);
      expect(output).not.toContain("tests fail without the change");
      expect(task.proof).toBeUndefined();
      expect(task.moved).toHaveLength(4);
      const receipt = formatReceipt(task, { surface: "interactive" });
      expect(receipt).toContain("✓ Moved 4 files into run-1/");
      expect(receipt).not.toMatch(/Incomplete — app smoke|look for test data/);
      const card = cardRows(receiptCard(receiptView(task), false)!, 160, false).join("\n");
      expect(card).not.toContain("Config");
      expect(card).not.toContain("run-1/builds/A/config");
    } finally { await app.close(); }
  } finally { await removeTempDir(root); }
}, 40_000);
