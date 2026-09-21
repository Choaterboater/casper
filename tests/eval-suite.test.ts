import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatEvalResult } from "../evals/report";
import { evaluateAcceptance, prepareWorkdir, runEvalTask, runVerification } from "../evals/runner";
import { EVAL_TASKS, findEvalTask } from "../evals/tasks";
import { needsSymlinks } from "./support/platform";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener, RuntimeStartOptions, RuntimeUsage } from "../src/runtime/types";

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

/** Deterministic runtime: it performs a scripted action and reports a final answer. */
function scriptedRuntime(script: (cwd: string) => Promise<string>, usage?: RuntimeUsage): () => AgentRuntime {
  return () => ({
    async start(options: RuntimeStartOptions) {
      const listeners = new Set<RuntimeEventListener>();
      const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
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
  for (const task of EVAL_TASKS) {
    expect(await exists(path.join(repoRoot, "evals/fixtures", task.fixture))).toBe(true);
    if (task.setup) expect(await exists(path.join(repoRoot, "evals/setups", task.setup, "files"))).toBe(true);
    expect(task.prompt.length).toBeGreaterThan(40);
    expect(task.verify.argv.length).toBeGreaterThan(1);
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
