import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { formatReceipt, receiptView } from "../src/task/result";
import { cardRows, receiptCard } from "../src/tui/receipt-card";
import { removeTempDir } from "./support/temp-dir";

/**
 * Run 8's "rerun the test with sonnet 4.6 - test 2" (v0.4.7), in a folder whose checks are opt-in ("offered with /verify"):
 * run 7 moved into run-7/, then builds/, runs/, results/, logs/ and compare.out written again. The receipt said "⚠ Not
 * verified: run /verify to check these changes" and "Proof 2 cases from your request not confirmed: no checks ran".
 */

type Emit = (event: Parameters<RuntimeEventListener>[0]) => void;

for (const mode of ["offer", "auto"] as const) {
  test(`only moved and output files changed, checks ${mode === "offer" ? "opt-in" : "automatic"}: grey "only output files", no proof row and no /verify push`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "casper-run-score-"));
    const home = path.join(root, "home"), project = path.join(root, "project");
    await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true });
    await writeFile(path.join(project, ".casper/project.yaml"), `verify:\n  test: npm test\nverification:\n  mode: ${mode}\n  checklist: true\n`);
    for (const dir of ["scripts", "runs/casper", "results"]) await mkdir(path.join(project, dir), { recursive: true });
    await writeFile(path.join(project, "scripts/run.mjs"), "export const run = 1;\n");
    await writeFile(path.join(project, "runs/casper/app.js"), "run 7\n");
    await writeFile(path.join(project, "results/score.json"), "{\"run\":7}\n");
    const turn = async (emit: Emit) => {
      const command = "mkdir run-7 && mv runs results run-7/ && node scripts/run.mjs";
      emit({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: { command } });
      await mkdir(path.join(project, "run-7"));
      await rename(path.join(project, "runs"), path.join(project, "run-7/runs"));
      await rename(path.join(project, "results"), path.join(project, "run-7/results"));
      for (const [file, text] of [["builds/A/server.js", "a\n"], ["runs/casper/app.js", "run 8\n"], ["results/score.json", "{\"run\":8}\n"],
        ["logs/casper.json", "{}\n"], ["compare.out", "exit 0\n"]] as const) {
        await mkdir(path.dirname(path.join(project, file)), { recursive: true });
        await writeFile(path.join(project, file), text);
      }
      emit({ type: "tool_end", toolName: "bash", toolCallId: "b1", isError: false, input: { command } });
      emit({ type: "assistant_text_delta", delta: "Run 8 is done and scored." });
    };
    const listeners = new Set<RuntimeEventListener>();
    const runtime: AgentRuntime = {
      async start() {
        return {
          getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
          getState: () => ({ cwd: project, isStreaming: false }),
          subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
          abort: async () => {}, setTools: () => {},
          // The checklist call lists what run 8's checklist did.
          complete: async () => ({ text: JSON.stringify(['Rerun "test 2" (not other tests)', 'Use "sonnet 4.6" as the model for the rerun']), usage: { tokens: 100, estimatedCost: 0 } }),
          prompt: async () => { await turn((event) => { for (const listener of listeners) listener(event); }); },
        };
      },
      async dispose() {},
    };
    const app = new CasperApp({
      input: new PassThrough(), output: { write: () => {} }, runtimeFactory: () => runtime, sessionHomeDir: home,
      loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
      loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
      loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    });
    try {
      await app.runOnce("rerun the test with sonnet 4.6 - test 2", project);
      const task = app.getLastTaskResult()!;
      expect(task.checklist).toHaveLength(2);
      expect(task.verification).toBeUndefined();
      expect(task.autoSkipped).toBe("output");
      const receipt = formatReceipt(task, { surface: "interactive" });
      expect(receipt).toContain("– Checks skipped — only output files changed (");
      expect(receipt).not.toMatch(/Not verified|not confirmed|\/verify/);
      const card = cardRows(receiptCard(receiptView(task, { surface: "interactive" }), false)!, 160, false).join("\n");
      expect(card).not.toMatch(/Proof|\/verify/);
    } finally { await app.close(); await removeTempDir(root); }
  }, 60_000);
}
