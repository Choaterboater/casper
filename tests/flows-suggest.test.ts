import { describe, expect, test } from "bun:test";
import { rememberableTestCommand } from "../src/flows/runners";
import {
  countAsks, formatSuggestionRow, MAX_SUGGESTIONS, specificRequest, suggestBeforeWork,
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
    expect(rules.afterReceipt(context({ verification: passed, proofSkipped: "no app code changed, only tests, data or docs" }))[0]?.why).toBe("no test shows the fix works");
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

  test("save-network-check offers a found Ansible check after a YAML change, and shows the exact setting it saves", () => {
    const found = { ...project(), foundChecks: { "aruba-syntax": { kind: "offline" as const, preset: "ansible-syntax" as const, playbooks: ["site.yml"], after: "each-change" as const } } };
    const fired = rules.afterReceipt(context({ changedPaths: ["site.yml"] }, "Add VLAN 30 to the access switches", { project: found }));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ id: "save-network-check", cost: "free",
      label: "Save aruba-syntax: it checks your playbooks with ansible-playbook --syntax-check after each change",
      action: { kind: "save-check", name: "aruba-syntax", line: "verify.checks.aruba-syntax: { preset: ansible-syntax, playbooks: [ site.yml ] }" } });
    // No YAML changed, or nothing found: nothing is offered.
    expect(rules.afterReceipt(context({ changedPaths: ["README.md"] }, "Add VLAN 30 to the access switches", { project: found }))).toEqual([]);
    expect(rules.afterReceipt(context({ changedPaths: ["site.yml"] }, "Add VLAN 30 to the access switches"))).toEqual([]);
  });

  test("found Ansible checks are suggested only for changes to their playbooks, not arbitrary YAML", () => {
    const found: ProjectModel = { ...project(), foundChecks: {
      "aruba-syntax": { kind: "offline", preset: "ansible-syntax", playbooks: ["site.yml"], after: "each-change" },
      "junos-render": { kind: "offline", preset: "ansible-render", playbooks: ["checks/render.yml"], after: "each-change" },
    } };
    for (const file of ["src/network/assets/junos_commit_check.yml", "src/bundled/example.yml", "config.yml", "tests/fixtures/site.yml"]) {
      expect(rules.afterReceipt(context({ changedPaths: [file] }, "Update the YAML data", { project: found }))).toEqual([]);
    }
    const choices = rules.afterReceipt(context({ changedPaths: ["checks\\render.yml"] }, "Update the Junos playbook", { project: found }));
    expect(choices).toHaveLength(1);
    expect(choices[0]?.action).toMatchObject({ kind: "save-check", name: "junos-render" });
    const row = formatSuggestionRow(choices);
    expect(row.keys.map(({ key }) => key)).toEqual([1]);
    expect(row.lines[1]).toStartWith("  1 Save junos-render:");
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

  test("\"make it polished\" and a sentence saying how the ask works are not more asks", () => {
    // From a real session: one feature, a sentence saying how it works, and a polish wish was "a big job (3 things)".
    const feature = "Add a form on the page to add a book (title and author). New books are saved to the JSON file and show in the list without a reload. and make it polished";
    expect(countAsks(feature)).toBe(1);
    expect(ask(feature)).toBeUndefined();
    expect(countAsks("Add a settings page, and make it look nice")).toBe(1);
    expect(countAsks("Add login, then a dashboard, and also email alerts")).toBe(3);
    expect(countAsks("Add login. Make it remember the user. Then add a dashboard.")).toBe(3);
  });

  test("counts list lines, fires on long requests, and stays quiet when the user already mentions a plan or is not interactive", () => {
    const listed = "Add these to the netbox sync:\n- read sites\n- read devices\n- write a report";
    expect(ask(listed)?.reason).toBe("this asks for 4 things");
    const long = `Add a command that ${"reads the interface table from the lab router and ".repeat(6)}prints it.`;
    expect(ask(long)?.reason).toBe("this is a long request");
    expect(ask(`${listed}\nMake a plan for it.`)).toBeUndefined();
    expect(suggestBeforeWork(listed, classifyTask(listed), { interactive: false })).toBeUndefined();
  });

  test("a request that already lists concrete requirements is built as asked; a big vague one still gets the question", () => {
    // The shape of a real benchmark prompt: six requirements, each with a detail to check against.
    const detailed = [
      "Build a small web app in this empty folder: a unit converter.",
      "- Input a length with a unit (for example 12 ft). Show it in metres, centimetres, inches and yards.",
      "- Also convert a list of values at once and show them in a table.",
      "- Handle zero and negative values correctly, and reject bad input with a clear message.",
      "- Use Bun and TypeScript, no framework. `bun run dev` serves the page; the math lives in its own module.",
      "- Include unit tests for the math (`bun test`), with edge cases, and a short README saying how to run it.",
      "When you're done, run the tests and make sure they pass.",
    ].join("\n");
    expect(countAsks(detailed)).toBeGreaterThanOrEqual(3);
    expect(specificRequest(detailed)).toBe(true);
    expect(ask(detailed)).toBeUndefined();
    // Short list lines with nothing to check against are still vague, and so is a long list of bare features.
    const vague = "Build me a store app:\n- login\n- payments\n- a dashboard\n- notifications\n- an admin panel";
    expect(specificRequest(vague)).toBe(false);
    expect(ask(vague)).toEqual({ id: "plan-first", reason: "this asks for 6 things" });
    // Mostly vague: one detailed line does not make the list specific.
    expect(specificRequest("Add:\n- auth\n- billing\n- a chart of monthly revenue per customer on the home page")).toBe(false);
    // A numbered list counts, and its numbers are not a detail.
    expect(specificRequest("Add these:\n1. read sites\n2. read devices")).toBe(false);
    expect(specificRequest("Add these:\n1. read sites from `sites.csv`\n2. write devices to report.json")).toBe(true);
    // The user asking for a plan still turns it off either way.
    expect(ask(`${vague}\nPlan it first.`)).toBeUndefined();
  });
});

describe("rememberable test commands", () => {
  test("known runner shapes with plain paths are offered exactly as they will be saved", () => {
    expect(rememberableTestCommand("uv run pytest")).toBe("uv run pytest");
    expect(rememberableTestCommand("  python -m pytest  tests/test_api.py -q ")).toBe("python -m pytest tests/test_api.py -q");
    expect(rememberableTestCommand("bun test")).toBe("bun test");
    expect(rememberableTestCommand("npm test")).toBe("npm test");
    expect(rememberableTestCommand("go test ./...")).toBe("go test ./...");
    expect(rememberableTestCommand("python -m unittest")).toBe("python -m unittest");
    expect(rememberableTestCommand("python3 -m unittest -v")).toBe("python3 -m unittest -v");
  });

  test("a test script inside the project is offered: bash, sh, ./ or python with a relative path", () => {
    expect(rememberableTestCommand("bash tests/check_deliverables.sh")).toBe("bash tests/check_deliverables.sh");
    expect(rememberableTestCommand("sh scripts/test.sh -v")).toBe("sh scripts/test.sh -v");
    expect(rememberableTestCommand("./tests/run.sh")).toBe("./tests/run.sh");
    expect(rememberableTestCommand("python3 tests/verify_artifact.py")).toBe("python3 tests/verify_artifact.py");
    for (const command of [
      "bash -c 'curl x'", "bash /tmp/x.sh", "bash ../x.sh", "sh tests/x.py", "bash tests/x", "./x.sh; rm -rf y", "python3 -c 'x'",
      "python3 /etc/x.py", "python3 tests/x.sh", "bash tests/x.sh --exec=y", "./../x.sh", "bash ~/x.sh",
    ]) expect(rememberableTestCommand(command)).toBeUndefined();
  });

  test("anything else is not offered", () => {
    for (const command of [
      "python -c 'print(1)'", "uv run --with evil pytest", "pytest -p plugin", "pytest; rm -rf x", "pytest && curl x",
      "pytest $(cat x)", "pytest ../outside", "pytest /etc/passwd", "pytest\ttests", "npm test -- --exec x", "npx vitest",
      "PYTHONPATH=x pytest", "pytest --rootdir=/", "make test", "",
    ]) expect(rememberableTestCommand(command)).toBeUndefined();
  });
});
