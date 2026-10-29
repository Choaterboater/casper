import { expect, test } from "bun:test";
import { homedir } from "node:os";
import type { CasperApp } from "../src/app";
import { writeCheckResult } from "../src/app/verification";
import type { VerificationResult } from "../src/verify/evidence";
import { failureLines, formatToolActivity } from "../src/tui/format";
import { plainSteps } from "../src/app/plain-steps";
import { testFailureSummary } from "../src/tui/tool-status";

const output = "tests/model-servers.test.ts:\n(fail) validates the server address\nerror: Expected: true\nReceived: false\n" +
  Array.from({ length: 129 }, (_, i) => `(pass) unrelated case ${i}`).join("\n") + "\n129 pass\n1 fail\n";
const result: VerificationResult = { name: "test", cwd: "/repo", command: "bun test", status: "fail", stdout: output, stderr: "",
  exitCode: 1, signal: null, truncated: false, durationMs: 1000 };

test("host check boxes show failures, not only a passing tail, and a specific count", () => {
  const lines: string[] = [], panels: Array<{ title: string; body: string; tone: string }> = [];
  let expanded: { title: string; body: string } | undefined;
  const app = { events: { ensureLineBreak() {}, showOnExpand(step: { title: string; body: string }) { expanded = step; } }, verbose: false, modelCheckCalls: 0, interactive: false,
    output: { write(line: string) { lines.push(line); } }, terminal: { writePanel(title: string, body: string, options: { tone: string }) { panels.push({ title, body, tone: options.tone }); } } } as unknown as CasperApp;
  writeCheckResult(app, result);
  expect(lines).toEqual(["✗ 1 of 130 tests failed\n"]);
  expect(panels).toHaveLength(1);
  expect(panels[0]!.tone).toBe("warning");
  expect(panels[0]!.body).toContain("(fail) validates the server address");
  expect(panels[0]!.body).toContain("error: Expected: true");
  expect(panels[0]!.body).toContain("129 pass\n1 fail");
  expect(panels[0]!.body).not.toContain("(pass) unrelated case");
  // Ctrl+T shows the whole log the box was cut from.
  expect(expanded?.title).toBe("test · exit 1 · 1s");
  expect(expanded?.body).toContain("(pass) unrelated case 128");
  expect(expanded?.body).toContain("(fail) validates the server address");
  expect(result.status).toBe("fail"); // Presentation never rewrites evidence.
});

test("Ctrl+T's log of a failed check hides secrets and shows home as ~, as its box does", () => {
  let expanded: { body: string } | undefined;
  const app = { events: { ensureLineBreak() {}, showOnExpand(step: { body: string }) { expanded = step; } }, verbose: false, modelCheckCalls: 0, interactive: false,
    output: { write() {} }, terminal: { writePanel() {} } } as unknown as CasperApp;
  writeCheckResult(app, { ...result, stdout: "", stderr: `curl -H "Authorization: Bearer sk-abcdefabcdefabcdef12345678" failed\n${homedir()}/project/a.ts:1 error` });
  expect(expanded?.body).not.toContain("sk-abcdefabcdefabcdef12345678");
  expect(expanded?.body).toContain("~/project/a.ts:1 error");
  expanded = undefined;
  writeCheckResult(app, { ...result, stdout: "", stderr: "", status: "pass", exitCode: 0 });
  expect(expanded).toBeUndefined();
});

test("raw and plain tool rows use the same explicit test failure count", () => {
  const input = { command: "bun test" };
  expect(formatToolActivity({ type: "tool_end", toolName: "bash", input, isError: true, output: { text: output, truncated: false } })).toBe("✗ 1 of 130 tests failed");
  expect(plainSteps([{ toolName: "bash", kind: "command", input, startedAt: 0, endedAt: 1000, failed: true, output, line: "raw" }], 1000)).toEqual(["✗ 1 of 130 tests failed"]);
  expect(formatToolActivity({ type: "tool_end", toolName: "casper_check", input: { check: "test" }, isError: true, output: { text: JSON.stringify(result), truncated: false } })).toBe("✗ 1 of 130 tests failed");
  const other = plainSteps([{ toolName: "bash", kind: "command", input: { command: "custom-tool" }, startedAt: 0, endedAt: 1000, failed: true, output, line: "raw" }], 1000);
  expect(other.join("\n")).not.toContain("tests failed");
});

test("a host check keeps every diagnostic when it fits and fills a larger failure budget", () => {
  const short = ["error: check failed", ...Array.from({ length: 10 }, (_, i) => `diagnostic ${i}`)];
  expect(failureLines(short.join("\n"), { max: 40 }).lines).toEqual(short);
  const long = [...short, ...Array.from({ length: 50 }, (_, i) => `diagnostic continuation ${i}`)];
  const focused = failureLines(long.join("\n"), { max: 40 });
  expect(focused.lines).toHaveLength(40);
  expect(focused.lines[0]).toBe("error: check failed");
  expect(focused.lines).toContain("diagnostic continuation 28");
});

test("only complete runner summaries produce failure denominators", () => {
  expect(testFailureSummary("(pass) case 1\n1 fail")).toBeUndefined();
  expect(testFailureSummary("Tests: 2 failed, 161 passed, 163 total")).toBe("2 of 163 tests failed");
  expect(testFailureSummary("=== 2 failed, 161 passed in 2s ===")).toBe("2 of 163 tests failed");
  // node --test: the word, then the number ("ℹ fail 2"; "# fail 2" in TAP).
  expect(testFailureSummary("ℹ tests 1735\nℹ suites 0\nℹ pass 1733\nℹ fail 2\nℹ cancelled 0\nℹ skipped 0\nℹ todo 14")).toBe("2 of 1735 tests failed");
  expect(testFailureSummary("# tests 3\n# pass 1\n# fail 2")).toBe("2 of 3 tests failed");
  expect(testFailureSummary("ℹ tests 3\nℹ pass 3\nℹ fail 0")).toBeUndefined();
  expect(testFailureSummary("2 failed, 161 passed in 2s")).toBe("2 of 163 tests failed");
  expect(testFailureSummary("129 pass\n1 skip\n1 fail")).toBe("1 of 131 tests failed");
  expect(testFailureSummary("130 pass\n0 fail")).toBeUndefined();
});
