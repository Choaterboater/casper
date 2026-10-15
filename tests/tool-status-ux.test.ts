import { afterEach, expect, test } from "bun:test";
import { RuntimeEventView } from "../src/app/events";
import type { RuntimeEvent } from "../src/runtime/types";
import { failureLines, formatToolActivity } from "../src/tui/format";
import { renderEditBox, renderFailureBox } from "../src/tui/step-view";
import type { WorkView } from "../src/tui/surface";
import { renderFold, type FoldView, type InteractiveTerminal } from "../src/tui/terminal";
import { commandCheck, githubLabel, runningCheck } from "../src/tui/tool-status";

const open: RuntimeEventView[] = [];
afterEach(() => { for (const view of open.splice(0)) view.reset(); });
function screen(rich = true, goals: string[] = []) {
  let work: WorkView | undefined;
  const folds: FoldView[] = [];
  const output: string[] = [];
  const terminal = { rich, columns: 120, questionsShown: 0, questionOpen: false, endAssistant() {}, assistant() {},
    setWork(next?: WorkView) { work = next; }, writeFold(fold: FoldView) { folds.push(fold); } };
  const view = new RuntimeEventView(terminal as unknown as InteractiveTerminal, { write(text) { output.push(text); } }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
    builderGoals: () => goals,
  });
  open.push(view);
  return { view, folds, get work() { return work; },
    text: () => [...output, ...folds.flatMap(fold => renderFold(fold, 120, false, false))].join("\n"),
    send: (...events: RuntimeEvent[]) => { for (const event of events) view.handle(event); } };
}
const call = (id: string, toolName: string, input: Record<string, string>, text: string, isError = false): RuntimeEvent[] => [
  { type: "tool_start", toolName, input, toolCallId: id },
  { type: "tool_end", toolName, input, toolCallId: id, isError, output: { text, truncated: false } },
];
const words = (delta: string): RuntimeEvent => ({ type: "assistant_text_delta", delta });
const done: RuntimeEvent = { type: "message_end" };

for (const rich of [true, false]) {
  test(`expected lookup misses and designed refusals stay neutral (${rich ? "rich" : "plain"})`, () => {
    const s = screen(rich);
    s.send(...call("1", "read", { path: "guessed.ts" }, "ENOENT: no such file or directory", true),
      ...call("2", "grep", { pattern: "absent" }, "No matches found", true),
      ...call("3", "read", { path: "a.ts" }, "Skipped as a repeat; earlier result follows"),
      ...call("4", "bash", { command: "example" }, "Not run: the user said no. Ask the user instead.", true),
      ...call("5", "casper_check", { check: "junos" }, JSON.stringify({ status: "skip", reason: "no device" })), done);
    expect(s.text()).not.toMatch(/✗|— failed/);
    expect(s.text()).toContain("– read · guessed.ts — path not found");
    expect(s.text()).toContain("– grep · absent — nothing found");
    expect(s.text()).toContain("– bash · example — not run · You said no.");
    expect(s.text()).not.toContain("Ask the user");
    expect(s.text()).toContain("– casper_check · junos — skipped");
    expect(s.folds.flatMap(fold => fold.failures)).toHaveLength(0);
  });

  test(`a retried timeout or service hiccup gets one note; an unresolved one stays failed (${rich})`, () => {
    for (const error of ["Command timed out after 10 seconds", "ECONNRESET: service unavailable"]) {
      const s = screen(rich);
      s.send(...call("1", "bash", { command: "gh pr view 327" }, error, true), words("Retrying with more time."));
      expect(s.text()).not.toContain("✗");
      s.send(...call("2", "bash", { command: "gh pr view 327" }, "PR details"), done);
      expect(s.text()).toContain("retry finished");
      expect(s.text()).not.toContain("✗");
      const failed = screen(rich);
      failed.send(...call("1", "bash", { command: "gh pr view 327" }, error, true), done);
      expect(failed.text()).toContain("✗");
    }
  });

  test(`only explicit test-first failures with a passing identical rerun are neutral (${rich})`, () => {
    const s = screen(rich);
    s.send(words("Test-first: I expect this test to fail in the red phase."),
      ...call("1", "bash", { command: "bun test tests/new.test.ts" }, "(fail) new behavior\n1 fail", true), words("Implementing it."),
      ...call("2", "edit", { path: "src/new.ts" }, "edited"),
      ...call("3", "bash", { command: "bun test tests/new.test.ts" }, "1 pass\n0 fail"), done);
    expect(s.text()).toContain("expected test-first failure · rerun passed");
    expect(s.text()).not.toContain("✗");
    const genuine = screen(rich);
    genuine.send(...call("1", "bash", { command: "bun test" }, "(fail) regression\n1 fail", true),
      ...call("2", "bash", { command: "bun test" }, "1 pass"), done);
    expect(genuine.text()).toContain("✗");
    const unfinished = screen(rich);
    unfinished.send(words("Test-first: I expect the test to fail."), ...call("1", "bash", { command: "bun test" }, "1 fail", true), done);
    expect(unfinished.text()).toContain("✗");
  });

  test(`git conflicts become neutral only after a successful continue (${rich})`, () => {
    for (const operation of ["merge", "cherry-pick"]) {
      const s = screen(rich);
      s.send(...call("1", "bash", { command: `git ${operation} topic` }, "CONFLICT (content): Merge conflict in a.ts", true), words("Resolving the conflict."),
        ...call("2", "edit", { path: "a.ts" }, "edited"), ...call("3", "bash", { command: `git ${operation} --continue` }, "finished"), done);
      expect(s.text()).toContain("conflicts resolved");
      expect(s.text()).not.toContain("✗");
      const unresolved = screen(rich);
      unresolved.send(...call("1", "bash", { command: `git ${operation} topic` }, "CONFLICT in a.ts", true),
        ...call("2", "bash", { command: "git status" }, "unmerged paths"), done);
      expect(unresolved.text()).toContain("✗");
    }
  });
}

test("real read errors and failed checks mentioning timeout remain failures", () => {
  const s = screen();
  s.send(...call("1", "read", { path: "a.ts" }, "EACCES: permission denied", true),
    ...call("2", "bash", { command: "bun test" }, "(fail) timeout regression\n1 fail", true),
    ...call("3", "casper_check", { check: "test" }, JSON.stringify({ status: "fail", stdout: "(fail) broken\n1 fail" }), true), done);
  expect(s.folds.flatMap(fold => fold.failures)).toHaveLength(3);
  expect(s.text()).toContain("(fail) broken");
  expect(s.text()).not.toContain('"stdout"');
});

test("a timed-out search retried at a narrower scope can finish with no matches", () => {
  const s = screen();
  s.send(...call("1", "grep", { pattern: "needle", path: "." }, "Command timed out", true), words("Narrowing the search."),
    ...call("2", "grep", { pattern: "needle", path: "src" }, "No matches found"), done);
  expect(s.text()).toContain("timeout · retry finished");
  expect(s.text()).not.toContain("✗");
});

test("a failed retry, a different target and an unrecovered test-first verifier failure remain failures", () => {
  const s = screen();
  s.send(...call("1", "web_fetch", { url: "https://example.com/first" }, "503 service unavailable", true),
    ...call("2", "web_fetch", { url: "https://example.com/first" }, "503 service unavailable", true),
    ...call("3", "web_fetch", { url: "https://example.com/other" }, "ok"),
    words("Test-first: I expect this test to fail."),
    ...call("4", "casper_check", { check: "test" }, JSON.stringify({ status: "fail", stdout: "1 fail" }), true), done);
  expect(s.folds.flatMap(fold => fold.failures)).toHaveLength(3);
});

for (const intent of ["This is not test-first; I expect no tests to fail.", "Test-first, but I expect this not to fail.", "TDD: I do not expect this test to fail.", "Test-first: this should not fail.", "Without a red phase, I expect this to fail."]) {
  test(`negated test-first intent cannot neutralize a real failure: ${intent}`, () => {
    const s = screen();
    s.send(words(intent), ...call("1", "bash", { command: "bun test" }, "(fail) regression\n1 fail", true),
      ...call("2", "bash", { command: "bun test" }, "1 pass\n0 fail"), done);
    expect(s.folds.flatMap(fold => fold.failures)).toHaveLength(1);
    expect(s.text()).not.toContain("expected test-first failure");
  });
}

test("an explicit test-first check failure becomes a note only after the same check passes", () => {
  const s = screen();
  const failed = JSON.stringify({ status: "fail", stdout: "0 pass\n1 fail" });
  s.send(words("Test-first: I expect this test to fail."), ...call("1", "casper_check", { check: "test" }, failed, true),
    words("Implementing it."), ...call("2", "casper_check", { check: "test" }, JSON.stringify({ status: "pass", stdout: "1 pass\n0 fail" })), done);
  expect(s.text()).toContain("expected test-first failure · rerun passed");
  expect(s.text()).not.toContain("✗");
  expect(JSON.parse(failed).status).toBe("fail");
});

test("failed test previews select failing lines and counts, not the later passing tail", () => {
  const output = ["(fail) tests/new.test.ts > handles empty input", "AssertionError: wrong result", "Expected: 2", "Received: 1",
    ...Array.from({ length: 30 }, (_, index) => `(pass) other case ${index}`), "30 pass", "1 fail", "Ran 31 tests across 11 files"].join("\n");
  const lines = failureLines(output).lines.join("\n");
  expect(lines).toContain("(fail) tests/new.test.ts");
  expect(lines).toContain("Expected: 2");
  expect(lines).toContain("1 fail");
  expect(lines).not.toContain("(pass) other case");
  const box = renderFailureBox({ title: "Tests failed", output }, 80, false).join("\n");
  expect(box).toContain("handles empty input");
  expect(box).toContain("30 pass");
  expect(box).toContain("1 fail");
});

test("test counts and check names are human and consistent; GitHub labels name the PR action", () => {
  const command = `bun test --parallel ${Array.from({ length: 11 }, (_, i) => `tests/check-${i}.test.ts`).join(" ")}`;
  expect(runningCheck({ command })).toBe("Running tests (11 files)");
  expect(runningCheck({ command: "bun test tests" })).toBe("Running tests");
  expect(runningCheck({ check: "typecheck" })).toBe("Running typecheck");
  expect(commandCheck("bun .casper/quick-test.ts", { test: "bun .casper/quick-test.ts" })).toBe("test");
  expect(githubLabel({ command: "gh pr edit 327 --body-file body.md" })).toBe("Updated PR #327");
  const github = screen();
  github.send(...call("1", "bash", { command: "gh pr edit 327 --body-file body.md" }, "updated"));
  expect(github.work?.plain).toContain("✓ Updated PR #327");
  expect(githubLabel({ command: "gh pr edit 327; bun test" })).toBeUndefined();
  expect(githubLabel({ command: "gh pr create --title Update" }, "https://github.com/example/project/pull/327")).toBe("Created PR #327");
  const s = screen(true, ["Fix the parser"]);
  s.send({ type: "tool_start", toolName: "delegate", toolCallId: "1" });
  expect(s.work?.status).toStartWith("Delegating · Builder 1 working");
  const tests = screen();
  tests.send({ type: "tool_start", toolName: "bash", toolCallId: "1", input: { command } });
  expect(tests.work?.status).toStartWith("Running tests (11 files)");
});

for (const command of ["gh pr create --dry-run", "gh pr merge --help", "gh pr merge -h", "gh pr create --dry-run=true"]) {
  test(`GitHub help and dry-run commands never claim an action: ${command}`, () => {
    expect(githubLabel({ command })).toBeUndefined();
    expect(githubLabel({ command }, "", true)).toBeUndefined();
    for (const rich of [true, false]) {
      const s = screen(rich);
      s.send(...call("1", "bash", { command }, "Usage or preview only"));
      expect(s.work?.plain?.join("\n") ?? s.text()).not.toMatch(/Creat(?:ing|ed) PR|Merg(?:ing|ed) PR/);
      s.send(done);
      expect(s.text()).toContain(rich ? "ran gh pr" : "✓ bash · gh pr");
      expect(s.text()).not.toMatch(/created PR|merged PR|Created PR|Merged PR/);
    }
  });
}

test("each edited file gets at most twelve diff lines and Ctrl+T retains the full diff", () => {
  const patch = "@@ -1,10 +1,10 @@\n" + Array.from({ length: 10 }, (_, i) => `-old ${i}\n+new ${i}`).join("\n");
  const box = renderEditBox([{ path: "a.ts", diff: patch }, { path: "b.ts", diff: patch }], 80, { color: false, maxLines: 10 }).join("\n");
  expect(box.match(/old 0/g)).toHaveLength(2);
  expect(box.match(/new 5/g)).toHaveLength(2);
  expect(box).not.toContain("old 6");
  expect(box).toContain("… 16 more lines · Ctrl+T");
  const s = screen();
  s.send({ type: "tool_end", toolName: "edit", input: { path: "a.ts" }, isError: false, diff: patch }, done);
  expect(s.view.lastStep()?.body).toBe(patch);
  expect(renderEditBox([{ path: "a.ts", diff: patch }], 80, { color: false, maxLines: Infinity }).join("\n")).toContain("new 9");
});

test("standalone tool formatting does not turn missing paths or skips red", () => {
  expect(formatToolActivity({ type: "tool_end", toolName: "read", input: { path: "guess.ts" }, isError: true,
    output: { text: "ENOENT: no such file or directory", truncated: false } })).toBe("– read · guess.ts — path not found");
});
