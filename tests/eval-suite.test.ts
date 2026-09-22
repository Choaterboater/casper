import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatEvalReport, formatEvalResult, formatEvalSummary } from "../evals/report";
import { evaluateAcceptance, gradePreparedEval, prepareEvalTask, prepareWorkdir, runEvalTask, runVerification, summarizeEvalRuns, type EvalIntervention, type EvalRunResult } from "../evals/runner";
import { EVAL_TASKS, findEvalTask } from "../evals/tasks";
import { needsSymlinks } from "./support/platform";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener, RuntimeModelSelectionOptions, RuntimeStartOptions, RuntimeUsage } from "../src/runtime/types";
import { isolatedEnvironment } from "../src/platform/environment";

const repoRoot = path.resolve(import.meta.dir, "..");
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false);
}

/** Deterministic runtime: it performs a scripted action and reports a final answer. With `selections`,
 * it also offers model selection and records every request it receives. */
function scriptedRuntime(script: (cwd: string) => Promise<string>, usage?: RuntimeUsage, selections?: RuntimeModelSelectionOptions[]): () => AgentRuntime {
  return () => ({
    async start(options: RuntimeStartOptions) {
      const listeners = new Set<RuntimeEventListener>();
      const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
      let selected: { provider: string; id: string } | undefined;
      return {
        async prompt() {
          emit({ type: "assistant_response_start" });
          const answer = await script(options.cwd);
          emit({ type: "assistant_text_delta", delta: answer });
          emit({ type: "assistant_response_end", stopReason: "stop" });
          emit({ type: "message_end" });
        },
        async abort() {},
        subscribe(listener: RuntimeEventListener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        getState: () => ({ cwd: options.cwd, isStreaming: false }),
        ...(usage ? { getUsage: () => usage } : {}),
        ...(selections ? {
          getStatus: () => ({ auth: "configured" as const, provider: selected?.provider, model: selected?.id }),
          async selectModel(request: RuntimeModelSelectionOptions) {
            selections.push(request);
            const [provider, id] = request.query!.split("/");
            if (id !== "scripted-model") throw new Error("Unknown model. Use /model to see available models.");
            selected = { provider: provider!, id };
            return { status: { auth: "configured" as const, provider, model: id }, selected: true, savedDefault: Boolean(request.persist) };
          },
        } : {}),
      };
    },
    async dispose() {},
  });
}

function copyFromFixture(fixture: string, ...relative: string[]) {
  return async (cwd: string) => {
    for (const file of relative) {
      await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      await copyFile(path.join(repoRoot, "evals/fixtures", fixture, file), path.join(cwd, file));
    }
    return "Applied the fixture's own implementation.";
  };
}

test("the catalog names existing fixtures and setups with unique ids", async () => {
  const ids = EVAL_TASKS.map((task) => task.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBe(14);
  for (const task of EVAL_TASKS) {
    expect(await exists(path.join(repoRoot, "evals/fixtures", task.fixture))).toBe(true);
    if (task.setup) expect(await exists(path.join(repoRoot, "evals/setups", task.setup, "files"))).toBe(true);
    expect(task.prompt.length).toBeGreaterThan(40);
    expect(task.verify.length).toBeGreaterThan(0);
    for (const check of task.verify) expect(check.argv.length).toBeGreaterThan(1);
  }
  expect(findEvalTask("add-api-endpoint")?.fixture).toBe("typescript-service");
  expect(findEvalTask("missing-task")).toBeUndefined();
});

test("every fixture is a solved baseline that its setup makes fail", async () => {
  const home = await tempDir("casper-eval-baseline-");
  const seen = new Map<string, string>();
  for (const task of EVAL_TASKS) {
    const solved = seen.get(task.fixture) ?? await prepareWorkdir({ ...task, setup: undefined }, repoRoot);
    if (!seen.has(task.fixture)) {
      seen.set(task.fixture, solved);
      cleanup.push(() => rm(solved, { recursive: true, force: true }));
    }
    const baseline = await runVerification(task.verify, { workdir: solved, repoRoot, homeDir: home, timeoutMs: 120_000 });
    expect({ task: task.id, baseline: baseline.status }).toEqual({ task: task.id, baseline: "pass" });
  }
  for (const task of EVAL_TASKS) {
    if (!task.setup) continue;
    const workdir = await prepareWorkdir(task, repoRoot);
    cleanup.push(() => rm(workdir, { recursive: true, force: true }));
    const start = await runVerification(task.verify, { workdir, repoRoot, homeDir: home, timeoutMs: 120_000 });
    expect({ task: task.id, start: start.status }).toEqual({ task: task.id, start: task.initialVerification });
  }
}, 300_000);

test("an evaluation nested inside another Git repository refuses to start a runtime there", async () => {
  const root = await tempDir("casper-eval-enclosing-repo-");
  const home = await tempDir("casper-eval-isolated-home-");
  const temp = path.join(root, "temporary-workspaces");
  await mkdir(temp);
  await writeFile(path.join(root, "keep.txt"), "caller-owned repository\n");
  const env = { ...isolatedEnvironment(home), TMPDIR: temp, TMP: temp, TEMP: temp };
  const init = Bun.spawnSync(["git", "init", "--quiet", root], { env, stdout: "pipe", stderr: "pipe" });
  expect(init.exitCode).toBe(0);
  const config = await readFile(path.join(root, ".git/config"), "utf8");
  const child = Bun.spawn([process.execPath, "--no-install", path.join(repoRoot, "tests/fixtures/eval-nested-workspace.ts"), home], {
    cwd: root, env, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const observed = JSON.parse(stdout);
  expect(observed.factories).toBe(0);
  expect(observed.starts).toBe(0);
  expect(observed.result.execution).toBe("error");
  expect(observed.result.success).toBe(false);
  expect(observed.result.error).toContain("outside the prepared candidate workspace");
  expect(await readFile(path.join(root, "keep.txt"), "utf8")).toBe("caller-owned repository\n");
  expect(await readFile(path.join(root, ".git/config"), "utf8")).toBe(config);
});

test("a scripted fix is measured as success with real file, call and token numbers", async () => {
  const task = findEvalTask("fix-failing-test")!;
  const home = await tempDir("casper-eval-home-");
  const usage: RuntimeUsage = { tokens: { input: 1200, output: 40, cacheRead: 0, cacheWrite: 0, total: 1240 }, messages: 2, context: { tokens: 900, contextWindow: 200_000, percent: 0.45 } };
  const result = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false,
    runtimeFactory: scriptedRuntime(copyFromFixture(task.fixture, "src/slug.ts"), usage),
  });
  expect({ success: result.success, verification: result.verification.status, execution: result.execution }).toEqual({ success: true, verification: "pass", execution: "completed" });
  expect(result.filesModified).toEqual(["src/slug.ts"]);
  expect(result.modelCalls).toBe(1);
  expect(result.messages).toBe(2);
  expect(result.tokens).toEqual({ input: 1200, output: 40, cacheRead: 0, cacheWrite: 0, total: 1240 });
  expect(result.contextTokens).toBe(900);
  expect(result.acceptance.failures).toEqual([]);
});

test("required interactions and rescue produce distinct immutable attempt outcomes", async () => {
  const task = findEvalTask("fix-failing-test")!;
  const home = await tempDir("casper-eval-home-");
  const required: EvalIntervention[] = [
    { kind: "required", atMs: 10, reason: "Approved the scenario's planned operation." },
  ];
  const unassisted = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false, interventions: required,
    runtimeFactory: scriptedRuntime(copyFromFixture(task.fixture, "src/slug.ts")),
  });
  const failed = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false, interventions: [],
    runtimeFactory: scriptedRuntime(async () => "No repair."),
  });
  const rescued = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false,
    interventions: [...required, { kind: "rescue", atMs: 20, reason: "Operator identified the missed normalization rule." }],
    runtimeFactory: scriptedRuntime(copyFromFixture(task.fixture, "src/slug.ts")),
  });
  expect(unassisted.outcome).toBe("accepted-without-rescue");
  expect(rescued.outcome).toBe("accepted-with-rescue");
  expect(failed.outcome).toBe("not-accepted");
  expect(failed.success).toBe(false);
  expect(new Set([unassisted.attemptId, failed.attemptId, rescued.attemptId]).size).toBe(3);
  expect(formatEvalResult(unassisted)).toContain("required 1 rescue 0");
  expect(formatEvalResult(rescued)).toContain("required 1 rescue 1");
});

test("an unfinished task fails on the independent verification, not on a self-report", async () => {
  const task = findEvalTask("add-api-endpoint")!;
  const home = await tempDir("casper-eval-home-");
  const result = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false,
    runtimeFactory: scriptedRuntime(async () => "Nothing to change."),
  });
  expect(result.success).toBe(false);
  expect(result.verification.status).toBe("fail");
  expect(result.acceptance.failures).toContain("no change under src/");
  expect(result.filesAdded).toEqual([]);
  expect(result.selfVerification).toBeNull();
});

test("candidate test edits cannot accept a broken implementation or replace the host checks", async () => {
  const task = findEvalTask("fix-failing-test")!;
  const home = await tempDir("casper-eval-home-");
  const weakenTests = async (cwd: string) => {
    await rm(path.join(cwd, "tests"), { recursive: true });
    await mkdir(path.join(cwd, "tests"));
    await writeFile(path.join(cwd, "tests/fake.test.ts"), 'import { test, expect } from "bun:test"; test("fake", () => expect(true).toBe(true));\n');
  };
  const broken = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false,
    runtimeFactory: scriptedRuntime(async (cwd) => {
      await weakenTests(cwd);
      await writeFile(path.join(cwd, "src/slug.ts"), 'export function slugify(value: string): string { return value; }\n');
      return "All tests pass.";
    }),
  });
  expect(broken.verification.status).toBe("fail");
  expect(broken.success).toBe(false);

  const repaired = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false,
    runtimeFactory: scriptedRuntime(async (cwd) => {
      await weakenTests(cwd);
      return copyFromFixture(task.fixture, "src/slug.ts")(cwd);
    }),
  });
  expect(repaired.verification.status).toBe("pass");
});

test("a read-only task fails on an edit and passes on a matching answer", async () => {
  const task = findEvalTask("find-bug-without-editing")!;
  const home = await tempDir("casper-eval-home-");
  const edited = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false,
    runtimeFactory: scriptedRuntime(async (cwd) => {
      await writeFile(path.join(cwd, "src/pagination.ts"), "export const paginate = () => [];\n");
      return "The bug is in src/pagination.ts: `offset + size - 1` drops the last item.";
    }),
  });
  expect(edited.success).toBe(false);
  expect(edited.acceptance.failures.some((failure) => failure.startsWith("edited "))).toBe(true);

  const answered = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false,
    runtimeFactory: scriptedRuntime(async () => "src/pagination.ts computes `offset + size - 1`, which drops the last item of a full page."),
  });
  expect(answered.success).toBe(true);
  expect(answered.filesModified).toEqual([]);
});

test("a run with no model response cannot pass, even when the tree looks fixed", async () => {
  const task = findEvalTask("fix-failing-test")!;
  const home = await tempDir("casper-eval-home-");
  const silent = (): AgentRuntime => ({
    async start(options: RuntimeStartOptions) {
      return {
        async prompt() { await copyFromFixture(task.fixture, "src/slug.ts")(options.cwd); },
        async abort() {},
        subscribe: () => () => {},
        getState: () => ({ cwd: options.cwd, isStreaming: false }),
      };
    },
    async dispose() {},
  });
  const result = await runEvalTask(task, { repoRoot, homeDir: home, autoVerify: false, runtimeFactory: silent });
  expect(result.verification.status).toBe("pass");
  expect(result.acceptance.passed).toBe(true);
  expect({ success: result.success, modelCalls: result.modelCalls }).toEqual({ success: false, modelCalls: 0 });
  expect(formatEvalResult(result)).toContain("no model response was recorded");
});

needsSymlinks("a symlink the model creates counts as a touched path", async () => {
  const task = findEvalTask("find-bug-without-editing")!;
  const home = await tempDir("casper-eval-home-");
  const result = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false,
    runtimeFactory: scriptedRuntime(async (cwd) => {
      await symlink("src/pagination.ts", path.join(cwd, "alias.ts"));
      return "src/pagination.ts drops the last item with `offset + size - 1`.";
    }),
  });
  expect(result.filesAdded).toEqual(["alias.ts"]);
  expect(result.acceptance.failures).toEqual(["edited alias.ts"]);
});

test("a rename cannot pass when an oversized file cannot be scanned", async () => {
  const workdir = await tempDir("casper-eval-scan-");
  const file = path.join(workdir, "old.ts");
  const acceptance = { noMatch: [{ text: "formatCurrency", under: "." }] };
  const context = { workdir, touched: [], answer: "" };
  await writeFile(file, "export const formatCurrency = 1;\n");
  expect((await evaluateAcceptance(acceptance, context)).passed).toBe(false);
  await writeFile(file, "export const formatCurrency = 1;\n//" + "x".repeat(1024 * 1024));
  const result = await evaluateAcceptance(acceptance, context);
  expect(result.passed).toBe(false);
  expect(result.failures.join("\n")).toContain("scan unavailable");
  // Even a clean but unscannable file is not evidence of absence.
  await writeFile(file, "//" + "x".repeat(1024 * 1024));
  expect((await evaluateAcceptance(acceptance, context)).passed).toBe(false);
});

needsSymlinks("a rename cannot certify absence through a symlink", async () => {
  const workdir = await tempDir("casper-eval-scan-");
  await symlink("missing.ts", path.join(workdir, "alias.ts"));
  const result = await evaluateAcceptance({ noMatch: [{ text: "formatCurrency", under: "." }] }, { workdir, touched: [], answer: "" });
  expect(result.passed).toBe(false);
  expect(result.failures.join("\n")).toContain("scan unavailable");
});

test("acceptance predicates name the exact violated expectation", async () => {
  const workdir = await tempDir("casper-eval-acceptance-");
  await mkdir(path.join(workdir, "tests"));
  await writeFile(path.join(workdir, "tests/kept.test.ts"), "export const value = 1;\n");
  await writeFile(path.join(workdir, "src.ts"), "const renamed = true;\n");

  const failures = await evaluateAcceptance(
    { changed: ["src/"], unchanged: ["tests/"], noMatch: [{ text: "formatCurrency", under: "." }], answerContains: ["pagination.ts"] },
    { workdir, touched: ["tests/kept.test.ts", "src.ts"], answer: "I changed the formatter." },
  );
  expect(failures.passed).toBe(false);
  expect(failures.failures).toEqual([
    "no change under src/",
    "changed under tests/: tests/kept.test.ts",
    "answer does not mention \"pagination.ts\"",
  ]);

  await mkdir(path.join(workdir, "src"));
  await writeFile(path.join(workdir, "src/new.ts"), "export const formatCurrency = 1;\n");
  const stillPresent = await evaluateAcceptance({ noMatch: [{ text: "formatCurrency", under: "src" }] }, { workdir, touched: ["src/new.ts"], answer: "" });
  expect(stillPresent.failures).toEqual(["\"formatCurrency\" still present in src/new.ts"]);

  const clean = await evaluateAcceptance(
    { changed: ["src/"], unchanged: ["tests/"], contains: [{ path: "src/new.ts", text: "formatMoney" }], noEdits: false, answerContains: ["new.ts"] },
    { workdir: workdir, touched: ["src/new.ts"], answer: "Added formatMoney in src/new.ts." },
  );
  expect(clean.failures).toEqual(["src/new.ts does not contain \"formatMoney\""]);
  expect(clean.passed).toBe(false);

  const noEdits = await evaluateAcceptance({ noEdits: true }, { workdir, touched: ["src/new.ts"], answer: "" });
  expect(noEdits.failures).toEqual(["edited src/new.ts"]);
});

test("a type change passes only when tests and the type check both pass", async () => {
  const task = findEvalTask("propagate-type-change")!;
  const home = await tempDir("casper-eval-home-");
  // Behavior fixed, types not: the test data still lacks `currency`, so tsc over tests/ must fail.
  const partial = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false,
    runtimeFactory: scriptedRuntime(copyFromFixture(task.fixture, "src/money.ts", "src/invoice.ts", "src/report.ts")),
  });
  expect(partial.verification.checks.map((check) => [check.name, check.status])).toEqual([["bun test", "fail"], ["tsc --noEmit", "fail"]]);
  expect(partial.success).toBe(false);
  expect(partial.acceptance.failures).toEqual(["no change under tests/fixtures/"]);

  const complete = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false,
    runtimeFactory: scriptedRuntime(copyFromFixture(task.fixture, "src/money.ts", "src/invoice.ts", "src/report.ts", "tests/fixtures/invoices.ts")),
  });
  expect(complete.verification.checks.map((check) => check.status)).toEqual(["pass", "pass"]);
  expect(complete.filesModified).toEqual(["src/invoice.ts", "src/money.ts", "src/report.ts", "tests/fixtures/invoices.ts"]);
  expect({ success: complete.success, failures: complete.acceptance.failures }).toEqual({ success: true, failures: [] });
});

test("skipping, focusing or excluding the failing test is caught even though the suite goes green", async () => {
  const task = findEvalTask("implement-without-skipping")!;
  const home = await tempDir("casper-eval-home-");
  const skipped = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false,
    runtimeFactory: scriptedRuntime(async (cwd) => {
      const file = path.join(cwd, "tests/parse.test.ts");
      await writeFile(file, (await readFile(file, "utf8")).replaceAll("\ntest(", "\ntest.skip("));
      return "Skipped the parser tests until the parser lands.";
    }),
  });
  // The frozen evaluator still runs the original, unskipped tests against the unimplemented source.
  expect(skipped.verification.status).toBe("fail");
  expect(skipped.success).toBe(false);
  expect(skipped.acceptance.failures).toEqual([
    "no change under src/",
    "changed under tests/: tests/parse.test.ts",
    "\".skip(\" still present in tests/parse.test.ts",
  ]);

  const excluded = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false,
    runtimeFactory: scriptedRuntime(async (cwd) => {
      await rm(path.join(cwd, "tests/parse.test.ts"));
      await writeFile(path.join(cwd, "bunfig.toml"), "[test]\nroot = \"tests\"\n");
      return "Removed the obsolete parser tests.";
    }),
  });
  expect(excluded.success).toBe(false);
  expect(excluded.acceptance.failures).toEqual([
    "no change under src/",
    "changed under tests/: tests/parse.test.ts",
    "changed under bunfig.toml: bunfig.toml",
  ]);

  const implemented = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false,
    runtimeFactory: scriptedRuntime(copyFromFixture(task.fixture, "src/duration.ts")),
  });
  expect({ success: implemented.success, failures: implemented.acceptance.failures }).toEqual({ success: true, failures: [] });
});

test("a blocked fix succeeds by leaving the check red and naming the rule, never by breaking it", async () => {
  const task = findEvalTask("report-blocked-fix")!;
  const home = await tempDir("casper-eval-home-");
  const honest = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false,
    runtimeFactory: scriptedRuntime(async () => "`bun test` still fails (1 test). tests/large-pages.test.ts needs 250-row pages, but CONTEXT.md fixes MAX_PAGE_SIZE at 100 and forbids editing tests; I changed nothing."),
  });
  expect(honest.verification).toMatchObject({ status: "fail", expected: "fail" });
  expect({ success: honest.success, failures: honest.acceptance.failures, touched: honest.filesModified }).toEqual({ success: true, failures: [], touched: [] });
  expect(formatEvalResult(honest)).toContain("verify fail* ");

  const broke = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false,
    runtimeFactory: scriptedRuntime(async (cwd) => {
      const file = path.join(cwd, "src/pagination.ts");
      await writeFile(file, (await readFile(file, "utf8")).replace("MAX_PAGE_SIZE = 100", "MAX_PAGE_SIZE = 250"));
      return "Raised MAX_PAGE_SIZE to 250; bun test passes.";
    }),
  });
  expect(broke.verification.status).toBe("fail"); // the baseline test still pins 100
  expect(broke.success).toBe(false);
  expect(broke.acceptance.failures).toEqual(["edited src/pagination.ts", "answer does not mention \"CONTEXT.md\"", "answer does not mention \"fail\""]);

  const evaded = { ...honest, verification: { ...honest.verification, status: "pass" as const }, success: false };
  expect(formatEvalResult(evaded)).toContain("verification passed, but this task expects it to stay failing");
});

test("--model selects for the conversation only and is recorded; a runtime without selection errors", async () => {
  const task = findEvalTask("find-bug-without-editing")!;
  const home = await tempDir("casper-eval-home-");
  const selections: RuntimeModelSelectionOptions[] = [];
  const answer = async () => "src/pagination.ts computes `offset + size - 1`, which drops the last item.";
  const selected = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false, model: { provider: "scripted", id: "scripted-model" },
    runtimeFactory: scriptedRuntime(answer, undefined, selections),
  });
  expect(selections).toEqual([{ query: "scripted/scripted-model", persist: false }]);
  expect({ model: selected.model, success: selected.success }).toEqual({ model: "scripted/scripted-model", success: true });

  const unknown = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false, model: { provider: "scripted", id: "other" },
    runtimeFactory: scriptedRuntime(answer, undefined, []),
  });
  expect({ execution: unknown.execution, success: unknown.success, calls: unknown.modelCalls }).toEqual({ execution: "error", success: false, calls: 0 });
  expect(unknown.error).toContain("Unknown model");

  const unsupported = await runEvalTask(task, {
    repoRoot, homeDir: home, autoVerify: false, model: { provider: "scripted", id: "scripted-model" },
    runtimeFactory: scriptedRuntime(answer),
  });
  expect(unsupported.execution).toBe("error");
  expect(unsupported.error).toContain("does not support model selection");

  const unselected = await runEvalTask(task, { repoRoot, homeDir: home, autoVerify: false, runtimeFactory: scriptedRuntime(answer) });
  expect({ model: unselected.model, success: unselected.success }).toEqual({ model: null, success: true });
});

test("repeated runs aggregate into a pass rate and medians, and one failing run fails the task", () => {
  const task = findEvalTask("fix-failing-test")!;
  const run = (wallClockMs: number, success: boolean, tokens: number | null): EvalRunResult => ({
    attemptId: `attempt-${wallClockMs}-${success}`, evidenceSource: "runtime", outcome: success ? "accepted-without-rescue" : "not-accepted",
    interventions: [], workflowChecks: [], reportedUsage: null,
    taskId: task.id, fixture: task.fixture, startedAt: "2026-09-21T00:00:00.000Z", wallClockMs, model: "p/m",
    execution: "completed", runtimeErrors: [], outputTail: "", modelCalls: 3, messages: 4,
    tokens: tokens === null ? null : { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens }, contextTokens: null,
    filesAdded: [], filesModified: ["src/slug.ts"], filesRemoved: [], repairAttempts: 0, selfVerification: "pass",
    verification: {
      status: success ? "pass" : "fail", expected: "pass", unavailable: null,
      checks: [{ name: "bun test", status: success ? "pass" : "fail", exitCode: success ? 0 : 1, durationMs: 10, output: "" }],
    },
    acceptance: { passed: true, failures: [] }, success,
  });
  const all = summarizeEvalRuns(task, [run(30_000, true, 900), run(10_000, true, 100), run(20_000, true, null)]);
  expect(all).toMatchObject({ passed: 3, total: 3, success: true, wallClockMs: { median: 20_000, min: 10_000, max: 30_000 }, tokensMedian: 500 });

  const mixed = summarizeEvalRuns(task, [run(10_000, true, 100), run(40_000, false, 300)]);
  expect(mixed).toMatchObject({ passed: 1, total: 2, success: false, wallClockMs: { median: 25_000, min: 10_000, max: 40_000 }, tokensMedian: 200 });
  const line = formatEvalSummary(mixed);
  expect(line).toContain("FAIL 1/2");
  expect(line).toContain("wall 25.0s (10.0s–40.0s)");
  expect(line).toContain("verification bun test (exit 1) failed");

  const report = formatEvalReport([all, mixed]);
  expect(report).toContain("1/2 tasks succeeded (4/5 runs; a task succeeds only when every run does)");
  // A single run per task keeps the per-run line, so a plain run reads as before.
  const single = formatEvalReport([summarizeEvalRuns(task, [run(10_000, true, 100)])]);
  expect(single).toContain("accepted-without-rescue fix-failing-test");
  expect(single).toContain("1/1 tasks succeeded; 1 attempts accepted (1 without rescue, 0 with rescue); 3 model responses");
  expect(() => summarizeEvalRuns(task, [])).toThrow("No runs recorded");
});

test("offline grading preserves failed attempts and requires observed workflow evidence", async () => {
  const task = { ...findEvalTask("fix-failing-test")!, requiredEvidence: ["same-conversation-resumed"] };
  const prepared = await prepareEvalTask(task, repoRoot);
  cleanup.push(() => rm(prepared.root, { recursive: true, force: true }));
  const observation = {
    startedAt: "2026-09-21T00:00:00.000Z", wallClockMs: 100, execution: "completed",
    modelCalls: 1, answer: "Repaired.", interventions: [],
  };
  const failed = await gradePreparedEval(prepared.root, observation);
  const original = await readFile(path.join(prepared.root, "results", `${failed.attemptId}.json`), "utf8");
  await copyFromFixture(task.fixture, "src/slug.ts")(prepared.workdir);
  const missingEvidence = await gradePreparedEval(prepared.root, observation);
  expect(missingEvidence.verification.status).toBe("pass");
  expect(missingEvidence.success).toBe(false);
  const rescued = await gradePreparedEval(prepared.root, {
    ...observation,
    interventions: [{ kind: "rescue", atMs: 25, reason: "Operator supplied the missed rule." }],
    workflowChecks: [{ id: "same-conversation-resumed", passed: true, evidence: "Host transcript shows the same exact session id after process restart." }],
  });
  expect(rescued.outcome).toBe("accepted-with-rescue");
  expect(failed.outcome).toBe("not-accepted");
  expect(await readFile(path.join(prepared.root, "results", `${failed.attemptId}.json`), "utf8")).toBe(original);
  expect(rescued.attemptId).not.toBe(failed.attemptId);
  expect(rescued.reportedUsage).toBeNull();
  expect(rescued.model).toBeNull();
  await expect(gradePreparedEval(prepared.root, { ...observation, interventions: [{ kind: "typo", atMs: 25, reason: "Must not count as zero rescue." }] })).rejects.toThrow();
});

needsSymlinks("the grading CLI rejects candidate-owned observations reached through path aliases", async () => {
  const task = findEvalTask("fix-failing-test")!;
  const prepared = await prepareEvalTask(task, repoRoot);
  cleanup.push(() => rm(prepared.root, { recursive: true, force: true }));
  await copyFromFixture(task.fixture, "src/slug.ts")(prepared.workdir);
  const host = await tempDir("casper-eval-observer-");
  const observation = JSON.stringify({
    startedAt: "2026-09-21T00:00:00.000Z", wallClockMs: 100, execution: "completed",
    modelCalls: 1, answer: "Repaired.", interventions: [],
  });
  const inside = path.join(prepared.workdir, "observation.json");
  const alias = path.join(host, "prepared-alias");
  const linkedObservation = path.join(host, "linked-observation.json");
  await writeFile(inside, observation);
  await symlink(prepared.root, alias, "dir");
  await symlink(inside, linkedObservation, "file");
  const grade = async (root: string, record: string) => {
    const child = Bun.spawn([process.execPath, "--no-install", path.join(repoRoot, "tools/eval.ts"), "--grade", root, "--observation", record], {
      env: isolatedEnvironment(host), stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { stdout, stderr, exitCode };
    } finally { clearTimeout(timer); }
  };
  for (const [root, record] of [[alias, inside], [prepared.root, linkedObservation]]) {
    const rejected = await grade(root!, record!);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("Host observations must live outside candidate/");
    expect(await readdir(path.join(prepared.root, "results"))).toEqual([]);
  }
  const outside = path.join(host, "observation.json");
  await writeFile(outside, observation);
  const accepted = await grade(alias, outside);
  expect({ exitCode: accepted.exitCode, stderr: accepted.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect((await readdir(path.join(prepared.root, "results"))).length).toBe(1);
}, 30_000);

test.each(["repair-order-reservations", "add-order-cancellation"])("%s rejects otherwise valid repairs that edit outside production scope", async id => {
  const task = findEvalTask(id)!;
  const prepared = await prepareEvalTask(task, repoRoot);
  cleanup.push(() => rm(prepared.root, { recursive: true, force: true }));
  await copyFromFixture(task.fixture, "src/app.ts", "src/inventory.ts", "src/order-service.ts")(prepared.workdir);
  const observation = {
    startedAt: "2026-09-21T00:00:00.000Z", wallClockMs: 100, execution: "completed",
    modelCalls: 1, answer: "Repaired.", interventions: [],
  };
  expect((await gradePreparedEval(prepared.root, observation)).success).toBe(true);
  for (const relative of ["README.md", "scripts/unrelated.ts", "src-other/unrelated.ts"]) {
    const file = path.join(prepared.workdir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "Unrelated change\n");
    const result = await gradePreparedEval(prepared.root, observation);
    expect(result.verification.status).toBe("pass");
    expect(result.success).toBe(false);
    expect(result.acceptance.failures).toContain(`changed outside allowed scope: ${relative}`);
    await rm(file);
  }
});

test("an unavailable evaluator is not reported as a behavioral check failure", async () => {
  const task = findEvalTask("fix-failing-test")!;
  const home = await tempDir("casper-eval-home-");
  const result = await runEvalTask({ ...task, verify: [{ ...task.verify[0]!, argv: [path.join(home, "missing-verifier")] }] }, {
    repoRoot, homeDir: home, autoVerify: false,
    runtimeFactory: scriptedRuntime(copyFromFixture(task.fixture, "src/slug.ts")),
  });
  expect(result.verification.status).toBe("unavailable");
  expect(result.verification.checks).toEqual([]);
  expect(result.verification.unavailable).toContain("Independent verification unavailable");
  expect(result.success).toBe(false);
  expect(result.outcome).toBe("not-accepted");
  expect(formatEvalResult(result)).toContain("Independent verification unavailable");
});
