import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { snapshotTree } from "../src/task/changes";
import { taskOutcome, formatReceipt, formatTaskResult, type TaskResult } from "../src/task/result";
import { acceptanceTarget, failedTestNames, independentAcceptance, unextendableReason, type AcceptanceCompletion } from "../src/verify/acceptance";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

async function project(withTests = true): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-acceptance-")); roots.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/value.js"), "export const value = \"FIXED\";\n");
  if (withTests) {
    await mkdir(path.join(root, "tests"));
    await writeFile(path.join(root, "tests/value.test.js"), "import { expect, test } from \"bun:test\";\nimport { value } from \"../src/value.js\";\ntest(\"value\", () => expect(value).toBe(\"FIXED\"));\n");
  }
  return root;
}

const answer = (text: string, usage: { tokens: number; estimatedCost: number } | null = { tokens: 42, estimatedCost: 0.001 }): AcceptanceCompletion =>
  async () => ({ text, usage });
const file = (assertion: string) => `\`\`\`js\nimport { expect, test } from "bun:test";\nimport { value } from "../src/value.js";\ntest("\\"value is FIXED\\"", () => { ${assertion}; });\n\`\`\``;

async function run(root: string, complete: AcceptanceCompletion) {
  const files = await snapshotTree(root);
  return independentAcceptance({ complete, request: "Make value FIXED.", root, changes: { added: [], modified: ["src/value.js"], removed: [] },
    files, testCommand: `"${process.execPath}" test`, timeoutMs: 60_000 });
}

test("tests written from the request that fail the change make the check fail, name the failing tests, and the file is removed", async () => {
  const root = await project();
  const result = await run(root, answer(file("expect(value).toBe(\"OTHER\")")));
  expect(result.status).toBe("fail");
  expect(result.output).toContain("OTHER");
  expect(result.unconfirmed).toEqual(["\"value is FIXED\""]);
  expect(result.usage).toEqual({ tokens: 42, estimatedCost: 0.001 });
  expect(await readdir(path.join(root, "tests"))).toEqual(["value.test.js"]);
});

test("failing test names are read from bun, jest, vitest and pytest output, deduplicated and bounded", () => {
  expect(failedTestNames([
    "(pass) keeps the rest [0.10ms]",
    "\x1b[31m(fail)\x1b[0m suite > \"rejects over 5 per minute\" [1.52ms]",
    "  ✕ \"counts per key\" (3 ms)",
    "   × \"resets after the window\" 4ms",
    "FAILED tests/test_limiter.py::test_burst - AssertionError: 6 != 5",
    "(fail) suite > \"rejects over 5 per minute\"",
  ].join("\n"))).toEqual(["suite > \"rejects over 5 per minute\"", "\"counts per key\"", "\"resets after the window\"", "test_burst"]);
  const many = Array.from({ length: 30 }, (_, index) => `(fail) ${index}${"x".repeat(300)}`).join("\n");
  const names = failedTestNames(many);
  expect(names).toHaveLength(20);
  expect(names[0]).toHaveLength(200);
  expect(failedTestNames("error: Cannot find module '../src/value.js'")).toEqual([]);
});

test("tests that pass the change make the check pass", async () => {
  const root = await project();
  expect((await run(root, answer(file("expect(value).toBe(\"FIXED\")")))).status).toBe("pass");
});

test("an answer without a fenced file, or a failed call, is an error that ran nothing", async () => {
  const root = await project();
  expect(await run(root, answer("I think it works."))).toEqual({ status: "error", reason: "the acceptance answer had no test file", usage: { tokens: 42, estimatedCost: 0.001 } });
  const failed = await run(root, async () => ({ text: "", error: "rate limited", usage: null }));
  expect(failed).toEqual({ status: "error", reason: "the acceptance model call failed: rate limited", usage: null });
});

test("without a test directory the file goes into a new tests/ that is removed afterwards", async () => {
  const root = await project(false);
  expect((await run(root, answer(file("expect(value).toBe(\"FIXED\")")))).status).toBe("pass");
  expect(await readdir(root)).toEqual(["src"]);
});

test("the target sits beside the first test file and keeps its language", () => {
  expect(acceptanceTarget(["node_modules/x/a.test.js", "tests/b.test.ts", "spec/a.test.mjs"], "abcd1234").relative).toBe("spec/casper-acceptance-abcd1234.test.mjs");
  expect(acceptanceTarget(["pkg/tests/test_x.py"], "abcd1234").relative).toBe("pkg/tests/test_casper_acceptance_abcd1234.py");
  expect(acceptanceTarget(["README.md"], "abcd1234").relative).toBe("tests/casper-acceptance-abcd1234.test.ts");
});

test("a failed acceptance check downgrades verified to not verified; a pass or an error never changes it", () => {
  const verified: TaskResult = { execution: "completed", changedPaths: ["src/value.js"], verification: { status: "pass", repairAttempts: 0, rounds: [],
    results: [{ name: "test", command: "bun test", cwd: "/", status: "pass", exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 1, freshness: "fresh" }] },
    proof: { status: "proven", check: "test", command: "bun test", testsChanged: true, without: { exitCode: 1, ended: "fail" } } };
  expect(taskOutcome(undefined, verified)).toBe("verified");
  expect(taskOutcome(undefined, { ...verified, acceptance: { status: "pass", mode: "verdict" } })).toBe("verified");
  expect(taskOutcome(undefined, { ...verified, acceptance: { status: "error", reason: "x", mode: "verdict" } })).toBe("verified");
  const failed = { ...verified, acceptance: { status: "fail" as const, mode: "verdict" as const } };
  expect(taskOutcome(undefined, failed)).toBe("not_verified");
  expect(formatReceipt(failed)).toContain("✗ Independent acceptance: tests written from the request alone fail");
  const named = { ...verified, acceptance: { status: "fail" as const, mode: "verdict" as const, unconfirmed: ["\"a\"", "\"b\""] } };
  expect(formatReceipt(named)).toContain("✗ Independent acceptance: tests written from the request alone fail: \"a\"; \"b\"");
});

test("in warn mode a failed acceptance check never downgrades; the receipt names what is unconfirmed", () => {
  const verified: TaskResult = { execution: "completed", changedPaths: ["src/value.js"], verification: { status: "pass", repairAttempts: 0, rounds: [],
    results: [{ name: "test", command: "bun test", cwd: "/", status: "pass", exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 1, freshness: "fresh" }] },
    proof: { status: "proven", check: "test", command: "bun test", testsChanged: true, without: { exitCode: 1, ended: "fail" } } };
  const named = { ...verified, acceptance: { status: "fail" as const, mode: "warn" as const, unconfirmed: ["\"rejects over 5\"", "\"per key\""] } };
  expect(taskOutcome(undefined, named)).toBe("verified");
  expect(formatReceipt(named)).toContain("⚠ Not confirmed by tests written from the request: \"rejects over 5\"; \"per key\"");
  expect(formatTaskResult(named)).toContain("⚠ Not confirmed by tests written from the request: \"rejects over 5\"; \"per key\"");
  const unnamed = { ...verified, acceptance: { status: "fail" as const, mode: "warn" as const } };
  expect(taskOutcome(undefined, unnamed)).toBe("verified");
  expect(formatReceipt(unnamed)).toContain("⚠ Independent acceptance: tests written from the request alone fail");
});

const generatedFailing = "```js\nimport { expect, test } from \"bun:test\";\ntest(\"requested\", () => expect(0).toBe(1));\n```";

test("a test command that chains or redirects is refused, never extended, and passes nothing", async () => {
  const root = await project();
  const bun = `"${process.execPath}"`;
  for (const testCommand of [`${bun} test tests/value.test.js && true`, `${bun} test tests/value.test.js; true`, `${bun} test || true`, `${bun} test | cat`, `${bun} test > out.txt`]) {
    const files = await snapshotTree(root);
    const result = await independentAcceptance({ complete: answer(generatedFailing), request: "Make value FIXED.", root, changes: { added: [], modified: ["src/value.js"], removed: [] }, files, testCommand, timeoutMs: 60_000 });
    expect(result.status).toBe("error");
    expect(result.reason).toContain("cannot be extended safely");
  }
  expect(await readdir(path.join(root, "tests"))).toEqual(["value.test.js"]);
});

test("a test command that filters tests is refused, and one that ignores the added file does not pass", async () => {
  const root = await project();
  const bun = `"${process.execPath}"`;
  const run2 = async (testCommand: string) => independentAcceptance({ complete: answer(generatedFailing), request: "Make value FIXED.", root,
    changes: { added: [], modified: ["src/value.js"], removed: [] }, files: await snapshotTree(root), testCommand, timeoutMs: 60_000 });
  expect((await run2(`${bun} test -t value`)).status).toBe("error");
  expect((await run2(`${bun} test --test-name-pattern value`)).status).toBe("error");
  const ignoring = await run2(`${bun} -e "process.exit(0)"`);
  expect(ignoring.status).toBe("error");
  expect(ignoring.reason).toContain("did not run");
});

test("python module runners and package-manager forms stay extendable; filters are refused even with the value attached", () => {
  for (const command of ["python -m pytest", "python3 -m pytest -q", "python3 -m unittest discover -s tests", "uv run python -m unittest discover", "poetry run python -m pytest",
    "pytest -q", "bun test", "npm test", "pnpm test", "yarn test", "npx vitest run", "npx jest", "go test ./...", "cargo test"]) {
    expect(unextendableReason(command)).toBeUndefined();
  }
  for (const command of ["pytest -m slow", "python -m pytest -m slow", "pytest -mslow", "jest -tfoo", "jest -t'x y'", "pytest -kfoo", "pytest -k foo", "go test -run Foo"]) {
    expect(unextendableReason(command)).toContain("filters");
  }
});
