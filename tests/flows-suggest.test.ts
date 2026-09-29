import { describe, expect, test } from "bun:test";
import { rememberableTestCommand } from "../src/flows/runners";
import {
  beforeWorkPanel, countAsks, formatSuggestionRow, MAX_SUGGESTIONS, readBeforeWorkAnswer, suggestBeforeWork,
  SuggestionRules, type AfterReceiptContext, type SuggestionRule,
} from "../src/flows/suggest";
import type { ProjectModel } from "../src/project/model";
import { classifyTask } from "../src/task/classify";
import type { ObservedCheck, TaskResult } from "../src/task/result";
import type { VerificationReport } from "../src/verify/evidence";
import type { ChangeProof } from "../src/verify/proof";

const project = (commands: ProjectModel["commands"] = {}): ProjectModel => ({
  schemaVersion: 1, project: { name: "demo", root: "/demo", git: true }, languages: ["python"], frameworks: [],
  packageManager: "uv", commands, architecture: {}, conventions: [], detectedAt: "2026-01-01T00:00:00.000Z",
});

const passed: VerificationReport = {
  status: "pass", repairAttempts: 0, rounds: [], results: [{ name: "test", status: "pass", command: "uv run pytest", cwd: "/demo",
    exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 100, freshness: "fresh" }],
};
const unproven: ChangeProof = { status: "unproven", check: "test", command: "uv run pytest", testsChanged: false,
  without: { exitCode: 0, ended: "pass" } };
const proven: ChangeProof = { ...unproven, status: "proven", without: { exitCode: 1, ended: "fail" } };
const observed = (command: string, toolStatus: ObservedCheck["toolStatus"] = "success"): ObservedCheck =>
  ({ name: "test", command, toolStatus, output: "", truncated: false });

function context(task: Partial<TaskResult>, request = "Fix the crash when the hostname is empty", extra: Partial<AfterReceiptContext> = {}): AfterReceiptContext {
  return { request, task: { execution: "completed", ...task }, classification: classifyTask(request), project: project(), interactive: true, ...extra };
}

describe("after-receipt rules", () => {
  const rules = new SuggestionRules();

  test("prove-fix fires for a fix whose checks pass but whose proof is unproven, and not once it is proven", () => {
    const fired = rules.afterReceipt(context({ verification: passed, proof: unproven }));
    expect(fired.map((choice) => choice.id)).toEqual(["prove-fix"]);
    expect(fired[0]).toMatchObject({ label: "Add a test that proves this bug stays fixed", why: "the tests pass without your fix too", cost: "tokens",
      action: { kind: "flow", flow: "prove-fix" } });
    expect(rules.afterReceipt(context({ verification: passed, proof: proven }))).toEqual([]);
  });

  test("prove-fix also fires when Casper skipped the comparison, but not for failing checks or a feature", () => {
    expect(rules.afterReceipt(context({ verification: passed, proofSkipped: "only non-code files changed" }))[0]?.why).toBe("no test shows the fix works");
    expect(rules.afterReceipt(context({ verification: { ...passed, status: "fail" }, proof: unproven }))).toEqual([]);
    expect(rules.afterReceipt(context({ verification: passed, proof: unproven }, "Add a --verbose flag to the CLI"))).toEqual([]);
    expect(rules.afterReceipt(context({ execution: "cancelled", verification: passed, proof: unproven }))).toEqual([]);
  });

  test("remember-test fires for a known runner the model ran without error, and shows the exact line it saves", () => {
    const fired = rules.afterReceipt(context({ observedChecks: [observed("uv run pytest")] }));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      id: "remember-test", cost: "free", label: "Remember uv run pytest as this project's test command",
      action: { kind: "remember-command", name: "test", command: "uv run pytest", line: "verify.test: uv run pytest" },
    });
    expect(fired[0]!.why).toContain("saves verify.test: uv run pytest in .casper/project.yaml");
  });

  test("remember-test also offers a known runner the model ran while no test command was set", () => {
    expect(rules.afterReceipt(context({ testRunner: "python -m pytest tests" })).map((choice) => choice.label))
      .toEqual(["Remember python -m pytest tests as this project's test command"]);
    expect(rules.afterReceipt(context({ testRunner: "pytest -p evil" }))).toEqual([]);
  });

  test("remember-test does not fire for unknown shapes, failed runs or a project that has a test command", () => {
    for (const command of ["pytest; rm -rf x", "python -c 'import os'", "uv run --with evil pytest", "pytest -p plugin", "bash -c pytest"]) {
      expect(rules.afterReceipt(context({ observedChecks: [observed(command)] }))).toEqual([]);
    }
    expect(rules.afterReceipt(context({ observedChecks: [observed("uv run pytest", "error")] }))).toEqual([]);
    expect(rules.afterReceipt(context({ observedChecks: [observed("uv run pytest")] }, undefined, { project: project({ test: "make test" }) }))).toEqual([]);
  });

  test("one-shot and --json runs get no suggestions", () => {
    expect(rules.afterReceipt(context({ verification: passed, proof: unproven }, undefined, { interactive: false }))).toEqual([]);
  });

  test("no more than three choices, in priority order, and off or faded rules are left out", () => {
    const many = new SuggestionRules();
    for (const [index, id] of ["extra-a", "extra-b", "extra-c"].entries()) {
      many.register({ id, priority: 30 + index, evaluate: () => ({ id, label: id, why: "test", cost: "free", action: { kind: "run", run: async () => {} } }) });
    }
    const all = context({ verification: passed, proof: unproven, observedChecks: [observed("uv run pytest")] });
    expect(many.afterReceipt(all).map((choice) => choice.id)).toEqual(["prove-fix", "remember-test", "extra-a"]);
    expect(many.afterReceipt(all)).toHaveLength(MAX_SUGGESTIONS);
    const hidden = new Set(["prove-fix", "extra-a"]);
    expect(many.afterReceipt(all, { visible: (id) => !hidden.has(id) }).map((choice) => choice.id)).toEqual(["remember-test", "extra-b", "extra-c"]);
  });

  test("a rule that throws is skipped and a duplicate id is refused", () => {
    const broken: SuggestionRule = { id: "broken", priority: 0, evaluate: () => { throw new Error("boom"); } };
    const set = new SuggestionRules([broken]);
    expect(set.afterReceipt(context({}))).toEqual([]);
    expect(() => set.register(broken)).toThrow("already registered");
    expect(() => set.register({ ...broken, id: "Bad Id" })).toThrow("invalid suggestion id");
  });
});

describe("the receipt row", () => {
  const choices = new SuggestionRules().afterReceipt(context({ verification: passed, proof: unproven, observedChecks: [observed("uv run pytest")] }));

  test("numbers suggestions after the row's own items and says what each costs", () => {
    const row = formatSuggestionRow(choices, { start: 3, hint: true });
    expect(row.lines).toEqual([
      "Suggested next:",
      "  3 Add a test that proves this bug stays fixed — the tests pass without your fix too (uses tokens)",
      "  4 Remember uv run pytest as this project's test command — the model ran it without error; saves verify.test: uv run pytest in .casper/project.yaml so Casper can check every change (free)",
      "  A number picks one · type to ask something else · /suggestions off stops these",
    ]);
    expect(row.keys.map(({ key, choice }) => [key, choice.id])).toEqual([[3, "prove-fix"], [4, "remember-test"]]);
  });

  test("the hint is left out when not due, nothing prints when nothing fired, and keys stop at 9", () => {
    expect(formatSuggestionRow(choices, { start: 1 }).lines.some((line) => line.includes("/suggestions off"))).toBe(false);
    expect(formatSuggestionRow([], { start: 3, hint: true })).toEqual({ lines: [], keys: [], hint: false });
    expect(formatSuggestionRow(choices, { start: 9 }).keys.map(({ key }) => key)).toEqual([9]);
  });
});

describe("before-work plan-first suggestion", () => {
  const ask = (request: string) => suggestBeforeWork(request, classifyTask(request), { interactive: true });

  test("fires on a request with four separate asks and not on a small fix", () => {
    const request = "Add a /health endpoint. Then add a login page, and also add rate limiting to the API; update the README with the new routes.";
    expect(countAsks(request)).toBe(4);
    expect(ask(request)).toEqual({ id: "plan-first", reason: "this asks for 4 things" });
    expect(ask("fix the typo in README")).toBeUndefined();
    expect(ask("Add a --verbose flag to src/cli.ts")).toBeUndefined();
  });

  test("counts list lines, fires on long requests, and stays quiet when the user already mentions a plan or is not interactive", () => {
    const listed = "Add these to the netbox sync:\n- read sites\n- read devices\n- write a report";
    expect(ask(listed)?.reason).toBe("this asks for 4 things");
    const long = `Add a command that ${"reads the interface table from the lab router and ".repeat(6)}prints it.`;
    expect(ask(long)?.reason).toBe("this is a long request");
    expect(ask(`${listed}\nMake a plan for it.`)).toBeUndefined();
    expect(suggestBeforeWork(listed, classifyTask(listed), { interactive: false })).toBeUndefined();
  });

  test("folds into the checklist panel: plan first is choice 1, then build with the cases, then edit", () => {
    const panel = beforeWorkPanel({ id: "plan-first", reason: "this asks for 4 things" }, ["empty host is an error", "port 22 is default", "IPv6 works", "names are trimmed"]);
    expect(panel.question).toBe("Suggested: plan first — this asks for 4 things");
    expect(panel.options.map((option) => option.label)).toEqual(["Plan first", "Just build", "Edit the cases first"]);
    expect(panel.options[0]!.description).toContain("Casper blocks file changes it can see until you choose Build (uses tokens)");
    expect(panel.options[0]!.description).not.toMatch(/read-only/i);
    expect(panel.options[1]!.description).toBe("with these 4 cases: empty host is an error; port 22 is default; IPv6 works; and 1 more");
    const noCases = beforeWorkPanel({ id: "plan-first", reason: "this is a long request" });
    expect(noCases.options.map((option) => [option.label, option.description.slice(0, 9)])).toEqual([["Plan first", "the model"], ["Just build", "start now"]]);
  });

  test("reads the panel's answer: a label, Esc or typed text", () => {
    const panel = beforeWorkPanel({ id: "plan-first", reason: "r" }, ["one case"]);
    expect(panel.options[1]!.description).toBe("with this case: one case");
    expect(readBeforeWorkAnswer(panel, ["Plan first"])).toEqual({ kind: "plan-first" });
    expect(readBeforeWorkAnswer(panel, ["Just build"])).toEqual({ kind: "build" });
    expect(readBeforeWorkAnswer(panel, ["Edit the cases first"])).toEqual({ kind: "edit" });
    expect(readBeforeWorkAnswer(panel, undefined)).toEqual({ kind: "skipped" });
    expect(readBeforeWorkAnswer(panel, ["also keep the old flag"])).toEqual({ kind: "typed", text: "also keep the old flag" });
    // A typed yes or no answers the question: "no" never becomes a case to test.
    for (const typed of ["no", "No.", "n", "not now", "skip"]) expect(readBeforeWorkAnswer(panel, [typed])).toEqual({ kind: "build" });
    for (const typed of ["yes", "y", "OK"]) expect(readBeforeWorkAnswer(panel, [typed])).toEqual({ kind: "plan-first" });
  });
});

describe("rememberable test commands", () => {
  test("known runner shapes with plain paths are offered exactly as they will be saved", () => {
    expect(rememberableTestCommand("uv run pytest")).toBe("uv run pytest");
    expect(rememberableTestCommand("  python -m pytest  tests/test_api.py -q ")).toBe("python -m pytest tests/test_api.py -q");
    expect(rememberableTestCommand("bun test")).toBe("bun test");
    expect(rememberableTestCommand("npm test")).toBe("npm test");
    expect(rememberableTestCommand("go test ./...")).toBe("go test ./...");
  });

  test("anything else is not offered", () => {
    for (const command of [
      "python -c 'print(1)'", "uv run --with evil pytest", "pytest -p plugin", "pytest; rm -rf x", "pytest && curl x",
      "pytest $(cat x)", "pytest ../outside", "pytest /etc/passwd", "pytest\ttests", "npm test -- --exec x", "npx vitest",
      "PYTHONPATH=x pytest", "pytest --rootdir=/", "make test", "",
    ]) expect(rememberableTestCommand(command)).toBeUndefined();
  });
});
