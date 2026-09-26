import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { snapshotTree } from "../src/task/changes";
import { taskOutcome, formatReceipt, type TaskResult } from "../src/task/result";
import { acceptanceTarget, independentAcceptance, type AcceptanceCompletion } from "../src/verify/acceptance";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

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

test("tests written from the request that fail the change make the check fail, and the file is removed", async () => {
  const root = await project();
  const result = await run(root, answer(file("expect(value).toBe(\"OTHER\")")));
  expect(result.status).toBe("fail");
  expect(result.output).toContain("OTHER");
  expect(result.usage).toEqual({ tokens: 42, estimatedCost: 0.001 });
  expect(await readdir(path.join(root, "tests"))).toEqual(["value.test.js"]);
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
    results: [{ name: "test", command: "bun test", cwd: "/", status: "pass", exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 1, freshness: "fresh" }] } };
  expect(taskOutcome(undefined, verified)).toBe("verified");
  expect(taskOutcome(undefined, { ...verified, acceptance: { status: "pass" } })).toBe("verified");
  expect(taskOutcome(undefined, { ...verified, acceptance: { status: "error", reason: "x" } })).toBe("verified");
  const failed = { ...verified, acceptance: { status: "fail" as const } };
  expect(taskOutcome(undefined, failed)).toBe("not_verified");
  expect(formatReceipt(failed)).toContain("✗ Independent acceptance: tests written from the request alone fail");
});
