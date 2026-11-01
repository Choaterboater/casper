import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { backgroundCommands } from "../src/app/runtime-start";
import { readsAsQuestion } from "../src/app/task-run";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { formatReceipt } from "../src/task/result";
import { planAutoChecks } from "../src/verify/mode";
import { checkCommand } from "./support/check-command";
import { removeTempDir } from "./support/temp-dir";

/**
 * The smoke session (v0.4.2): the AI started a 90-minute comparison in the background and ended its turn. The receipt
 * said done and passed; "is it still runing?" ran the 45 s tests and listed the runner's own log files as its changes.
 */

type Emit = (event: Parameters<RuntimeEventListener>[0]) => void;

test("a job left running: its receipt says so, a question about it runs no checks and claims none of its files, and its end is told", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-bg-receipt-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true }); await mkdir(path.join(project, "scripts")); await mkdir(path.join(project, "logs"));
  await writeFile(path.join(project, "scripts/run.mjs"), "export const model = 'anthropic';\n");
  await writeFile(path.join(project, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(checkCommand())}\n`);
  let app!: CasperApp;
  let tick = 0;
  let writer: ReturnType<typeof setInterval> | undefined;
  const job = Promise.withResolvers<{ exitCode: number | null }>();
  const runner = () => {
    // The comparison runner, as Casper can't see it: it writes its log and its JSON every 100 ms, between tasks too.
    writer = setInterval(() => {
      tick++;
      void writeFile(path.join(project, "logs/casper.json"), `{"tick":${tick}}\n`).catch(() => {});
      void writeFile(path.join(project, "logs/casper.stderr.log"), `line ${tick}\n`).catch(() => {});
    }, 100);
  };
  const turns: Array<(emit: Emit) => Promise<void>> = [
    async (emit) => {
      emit({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: { command: "node scripts/run.mjs --force" } });
      await writeFile(path.join(project, "scripts/run.mjs"), "export const model = 'claude-subscription';\n");
      runner();
      backgroundCommands(app)!.adopt({ command: "node scripts/run.mjs --force", startedAt: Date.now(), output: "run casper (cap 45 min) ...\n", done: job.promise, stop: () => job.resolve({ exitCode: null }) });
      emit({ type: "tool_end", toolName: "bash", toolCallId: "b1", isError: false, input: { command: "node scripts/run.mjs --force" } });
      emit({ type: "assistant_text_delta", delta: "The comparison is running in the background as cmd-1." });
    },
    async (emit) => {
      const command = "cat compare.out; ps -axo pid=,etime=,command=; tail -c 600 logs/casper.stderr.log";
      emit({ type: "tool_start", toolName: "bash", toolCallId: "b2", input: { command } });
      await Bun.sleep(400);
      emit({ type: "tool_end", toolName: "bash", toolCallId: "b2", isError: false, input: { command } });
      emit({ type: "assistant_text_delta", delta: "Yes, it's still running." });
    },
    async (emit) => {
      // A status question whose command writes a small state file: not code, not tests, not output.
      const command = "node scripts/status.mjs > state.yaml";
      emit({ type: "tool_start", toolName: "bash", toolCallId: "b3", input: { command } });
      await writeFile(path.join(project, "state.yaml"), "casper: done\n");
      emit({ type: "tool_end", toolName: "bash", toolCallId: "b3", isError: false, input: { command } });
      emit({ type: "assistant_text_delta", delta: "Both runs are done." });
    },
  ];
  const listeners = new Set<RuntimeEventListener>();
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => { await turns.shift()!((event) => { for (const listener of listeners) listener(event); }); },
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
  const running = app.runInteractive(project);
  const waitFor = async (done: RegExp, from: number) => {
    const deadline = Date.now() + 25_000;
    while (!done.test(output.slice(from))) {
      if (Date.now() > deadline) throw new Error(`no ${done} in:\n${output.slice(from)}`);
      await Bun.sleep(20);
    }
    return output.slice(from);
  };
  const send = async (line: string) => { const from = output.length; input.write(`${line}\n`); return waitFor(/\n> $/, from); };
  try {
    await waitFor(/> $/, 0);
    const launched = await send("launch omp and Casper for the comparison");
    // The scripts changed, so the tests ran; but line 1 says the work goes on, never done.
    expect(launched).toContain("Casper checking: test");
    expect(launched).toContain("◐ Still running — node scripts/run.mjs --force (cmd-1) in the background; Casper says here when it ends");
    expect(launched).not.toMatch(/^✓ Checks passed/m);
    expect(app.getLastTaskResult()?.stillRunning?.map((entry) => entry.id)).toEqual(["cmd-1"]);
    // The runner writes between the tasks.
    await Bun.sleep(400);
    const asked = await send("is it still runing?");
    expect(asked).not.toContain("Casper checking");
    const status = app.getLastTaskResult()!;
    expect(status.verification).toBeUndefined();
    expect(status.changedPaths ?? []).toEqual([]);
    expect(status.changedNotByModel).toEqual(["logs/casper.json", "logs/casper.stderr.log"]);
    // The job ends: one line where you are, and at the prompt the row to carry on.
    clearInterval(writer); writer = undefined;
    const from = output.length;
    job.resolve({ exitCode: 0 });
    const told = await waitFor(/Next: 1 Carry on now that cmd-1 ended \(uses tokens\)/, from);
    expect(told).toMatch(/◐ Background job cmd-1 ended with exit code 0 after [\d.]+s: node scripts\/run\.mjs --force/);
    // A status question whose own command wrote a non-code file: no checks for it, and the receipt says why.
    const statusOut = await send("status");
    expect(statusOut).not.toContain("Casper checking");
    const third = app.getLastTaskResult()!;
    expect(third.changedPaths).toEqual(["state.yaml"]);
    expect(third.autoSkipped).toBe("question");
    expect(formatReceipt(third, { surface: "interactive" })).toContain("– Checks skipped — this read as a question, and the AI's own tools changed no code or tests; /verify runs them anyway.");
    // Nothing of this asked you anything: lines and a row only.
    expect(output).not.toMatch(/Type 1|Type a number/);
  } finally {
    if (writer) clearInterval(writer);
    job.resolve({ exitCode: null });
    input.end(); await running; await app.close();
    await removeTempDir(root);
  }
}, 60_000);

test("only output files changed (results/, logs/, *.out): no checks, and the receipt says so; code beside them still runs them", () => {
  const commands = { test: "npm run test" };
  // The smoke session's receipt 7: the evaluation and the blind review wrote 22 files, all under results/.
  const evaluated = ["results/blindness.json", "results/checks/A.json", "results/report.html", "results/review/answer.json", "results/review/packet.md",
    "results/score.out", "results/screens/A-dashboard.png"];
  expect(planAutoChecks({ commands, changedPaths: evaluated })).toEqual({ run: [], skipped: "output" });
  expect(planAutoChecks({ commands, changedPaths: ["compare.out", "logs/casper.json", "logs/casper.stderr.log"] })).toEqual({ run: [], skipped: "output" });
  // Receipt 5: the runner's logs and its scripts: the scripts are code.
  expect(planAutoChecks({ commands, changedPaths: ["compare.out", "logs/casper.json", "scripts/run.mjs"] }).run).toEqual(["test"]);
  // Code or tests in such a folder are never output; a config file outside one still runs the checks.
  for (const file of ["logs/logger.ts", "out/test_report.py", "config.yaml", "results.json"]) expect([file, planAutoChecks({ commands, changedPaths: [file] }).run]).toEqual([file, ["test"]]);
  const receipt = formatReceipt({ execution: "completed", changedPaths: ["results/report.html", "results/scores.json"], autoSkipped: "output", verificationMode: "auto" }, { surface: "interactive" });
  expect(receipt).toContain("– Checks skipped — only output files changed (results/report.html, results/scores.json); /verify runs them anyway.");
});

test("what reads as a question: Casper's question intent, a closing ?, or a bare status", () => {
  for (const text of ["is it still runing?", "status", "Status.", "progress", "what does run.mjs do"]) {
    expect([text, readsAsQuestion(text, { intent: text.startsWith("what") ? "inspect" : "general" })]).toEqual([text, true]);
  }
  for (const text of ["launch omp and Casper for the comparison", "carry on", "set the port to 8080 in config.yaml", "fix the status page"]) {
    expect([text, readsAsQuestion(text, { intent: "general" })]).toEqual([text, false]);
  }
});
