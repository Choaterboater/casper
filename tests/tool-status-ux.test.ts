import { afterEach, expect, test } from "bun:test";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { RuntimeEventView } from "../src/app/events";
import { observationOutput } from "../src/runtime/observation";
import type { RuntimeEvent } from "../src/runtime/types";
import { failureLines, formatToolActivity } from "../src/tui/format";
import { renderEditBox, renderFailureBox } from "../src/tui/step-view";
import type { WorkView } from "../src/tui/surface";
import { renderFold, type FoldView, type InteractiveTerminal } from "../src/tui/terminal";
import { commandCheck, githubLabel, outcomeNote, runningCheck } from "../src/tui/tool-status";
import { activeThemeName, useTheme } from "../src/tui/theme";
import { ansiCells, cellsFor } from "./support/ansi-cells";

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
      ...call("5", "casper_check", { check: "junos" }, JSON.stringify({ status: "skip", reason: "no device" })),
      ...call("6", "grep", { pattern: "foo(" }, "rg: regex parse error:\n    (?:foo()\n    ^\nerror: unclosed group", true), done);
    expect(s.text()).not.toMatch(/✗|— failed/);
    expect(s.text()).toContain("– read · guessed.ts — path not found");
    expect(s.text()).toContain("– grep · absent — nothing found");
    expect(s.text()).toContain("– bash · example — not run · You said no.");
    expect(s.text()).not.toContain("Ask the user");
    expect(s.text()).toContain("– casper_check · junos — skipped");
    expect(s.text()).toContain("– grep · foo( — pattern not valid");
    expect(s.folds.flatMap(fold => fold.failures)).toHaveLength(0);
  });

  test(`a shell exit 1 that answers the question is a grey note, not a failure (${rich ? "rich" : "plain"})`, () => {
    const answers: Array<[string, string, string, string?]> = [
      ["bash", "grep -rn absent src", "nothing found"],
      ["bash", "cd /tmp/project && rg -n absent 2>/dev/null", "nothing found"],
      ["bash", "grep -c absent a.txt", "nothing found", "0"],
      ["bash", "egrep 'a|b' a.txt", "nothing found"],
      ["bash", "fgrep absent a.txt", "nothing found"],
      ["bash", "git --no-pager grep -n absent", "nothing found"],
      ["bash", "ag absent", "nothing found"],
      ["bash", "ack absent", "nothing found"],
      ["bash", "grep -rn absent src | grep -v test", "nothing found"],
      ["powershell", "findstr /s absent *.ts", "nothing found"],
      ["bash", "diff a.txt b.txt", "files differ", "1c1\n< old\n---\n> new"],
      ["bash", "cmp a.bin b.bin", "files differ", "a.bin b.bin differ: char 1, line 1"],
      ["bash", "git diff --quiet", "changes found"],
      ["bash", "git -C app diff --exit-code src", "changes found", "diff --git a/src/x.ts b/src/x.ts\n-old\n+new"],
      ["bash", "test -f .env", "false"],
      ["bash", "[ -d dist ]", "false"],
      ["bash", "[[ -n $CI ]]", "false"],
      ["bash", "which docker", "not installed", "which: no docker in (/usr/bin:/bin)"],
      ["bash", "command -v docker", "not installed"],
      ["bash", "type docker", "not installed", "bash: type: docker: not found"],
      ["bash", "where docker", "not installed", "INFO: Could not find files for the given pattern(s)."],
      ["powershell", "where.exe docker", "not installed", "INFO: Could not find files for the given pattern(s)."],
      ["bash", "pgrep -f vite", "no process found"],
    ];
    for (const [tool, command, note, printed] of answers) {
      const s = screen(rich);
      s.send(...call("1", tool, { command }, `${printed ?? "(no output)"}\n\nCommand exited with code 1`, true), done);
      expect(s.text()).not.toMatch(/✗|— failed/);
      expect(s.text()).toContain(`– ${tool} · `);
      expect(s.text()).toContain(`— ${note}`);
      expect(s.folds.flatMap(fold => fold.failures)).toHaveLength(0);
      // Display only: what the model got, exit code and all, is what Ctrl+T shows.
      expect(s.view.lastStep()?.title).toEndWith(` · ${note}`);
      expect(s.view.lastStep()?.body).toEndWith("Command exited with code 1");
    }
  });

  test(`exit 2 or more, an error message, or a line mixing in other programs stays a failure (${rich ? "rich" : "plain"})`, () => {
    const exit = (code: number, printed = "(no output)") => `${printed}\n\nCommand exited with code ${code}`;
    const failures: Array<[string, string, string]> = [
      ["bash", "grep -rn absent src", exit(2, "grep: src: No such file or directory")],
      ["bash", "grep absent missing.txt", exit(1, "grep: missing.txt: No such file or directory")],
      ["bash", "grep absent secret.txt", exit(1, "grep: secret.txt: Permission denied")],
      ["bash", "grep -k absent a.txt", exit(1, "grep: invalid option -- 'k'")],
      ["bash", "diff a.txt b.txt", exit(2, "diff: b.txt: No such file or directory")],
      ["bash", "test -f .env", exit(2, "bash: test: too many arguments")],
      ["bash", "grep absent a.txt && echo found", exit(1)],
      ["bash", "cat a.txt | grep absent", exit(1)],
      ["bash", "bun test; grep absent a.txt", exit(1)],
      ["bash", "which docker && docker ps", exit(1)],
      ["bash", "grep $(cat pattern.txt) a.txt", exit(1)],
      ["bash", "cd /tmp/project; grep absent a.txt &", exit(1)],
      ["bash", "! grep absent a.txt", exit(1)],
      ["bash", "git diff", exit(1)],
      ["bash", "npm test", exit(1)],
      ["powershell", "type missing.txt", exit(1, "Get-Content: Cannot find path 'missing.txt' because it does not exist.")],
      ["powershell", "where docker", exit(1)],
    ];
    for (const [tool, command, text] of failures) {
      const s = screen(rich);
      s.send(...call("1", tool, { command }, text, true), done);
      expect(s.text()).toContain("✗");
      expect(s.text()).not.toMatch(/— (?:nothing found|files differ|changes found|false|not installed|no process found)/);
    }
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

test("a timeout the next command doesn't retry shows then, not under the answer at the end of the task", () => {
  const s = screen();
  const failures = () => s.folds.flatMap((fold) => fold.failures).map((failure) => failure.title);
  s.send(...call("1", "bash", { command: "ssh nas 'ls -l /config'" }, "Command timed out after 30 seconds", true), words("Trying a narrower listing."));
  // Kept back for the retry the next command may be.
  expect(failures()).toEqual([]);
  s.send(...call("2", "bash", { command: "ssh nas 'ls /config/www'" }, "hero.jpg"), words("Found it."));
  // It was something else: the timeout shows now, while the work goes on (message_end comes once, at the task's end).
  expect(failures()).toEqual([expect.stringContaining("ssh nas")]);
  s.send(...call("3", "read", { path: "a.ts" }, "x"), words("Done."), done);
  expect(failures()).toHaveLength(1);
});

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

test("a timed-out diff retried to the end finishes with its answer, not a failure", () => {
  const s = screen();
  s.send(...call("1", "bash", { command: "diff -r old new" }, "Command timed out after 10 seconds", true), words("Again, with more time."),
    ...call("2", "bash", { command: "diff -r old new" }, "Only in new: a.txt\n\nCommand exited with code 1", true), done);
  expect(s.text()).toContain("timeout · retry finished");
  expect(s.text()).toContain("— files differ");
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

test("Pi's shell still says a non-zero exit as `Command exited with code N`, the words the notes read", async () => {
  const run = async (command: string, code: number, printed = "") => {
    const bash = createBashToolDefinition(process.cwd(), { operations: { exec: async (_command, _cwd, { onData }) => {
      if (printed) onData(Buffer.from(printed));
      return { exitCode: code };
    } } });
    const result = await bash.execute("call", { command }, new AbortController().signal, undefined, undefined as never);
    const event = { type: "tool_end" as const, toolName: "bash", input: { command }, isError: Reflect.get(result, "isError") === true, output: observationOutput(result) };
    return { event, note: outcomeNote(event) };
  };
  const none = await run("grep -rn absent src", 1);
  // Pi marks every non-zero exit an error; the model gets the exit code either way.
  expect(none.event.isError).toBe(true);
  expect(none.event.output.text).toBe("(no output)\n\nCommand exited with code 1");
  expect(none.note).toBe("nothing found");
  expect((await run("diff a.txt b.txt", 1, "1c1\n< old\n---\n> new\n")).note).toBe("files differ");
  const broken = await run("grep -rn absent src", 2, "grep: src: No such file or directory\n");
  expect(broken.event.output.text).toEndWith("Command exited with code 2");
  expect(broken.note).toBeUndefined();
});

test("a shell answer's note is dim in the fold's colour bytes, never red", () => {
  const previous = activeThemeName();
  useTheme("default");
  try {
    const s = screen();
    s.send(...call("1", "bash", { command: "rg -n TODO" }, "(no output)\n\nCommand exited with code 1", true), done);
    const cells = ansiCells(s.folds.flatMap(fold => renderFold(fold, 120, false, true)));
    const note = cellsFor(cells, "– bash · rg TODO — nothing found");
    expect(note.every(cell => cell.dim && cell.foreground === "default")).toBe(true);
  } finally { useTheme(previous); }
});

test("a helper that stopped at its limit with findings is a grey partial note in plain words, never a red failure with JSON", () => {
  // As the delegate tool returns it: the bounded envelope, the helper's result under data.
  const partial = JSON.stringify({ isError: false, summary: "Partial result: stopped at its 12-turn limit; the helper's findings so far are below, not a whole answer.", truncated: false,
    data: { isError: false, partial: true, status: "limited", reason: "partial: stopped at its 12-turn limit", response: "Found 2 issues in auth.ts" } });
  const event: Extract<RuntimeEvent, { type: "tool_end" }> = { type: "tool_end", toolName: "delegate", input: { role: "reviewer", goal: "Review auth" }, isError: false, output: { text: partial, truncated: false } };
  expect(outcomeNote(event)).toBe("partial: stopped at its 12-turn limit");
  const line = Bun.stripANSI(formatToolActivity(event));
  expect(line).toContain("— partial: stopped at its 12-turn limit");
  expect(line).not.toMatch(/✗|failed|\{|isError/);
  // A real failure stays red.
  const failed = { ...event, isError: true, output: { text: JSON.stringify({ isError: true, status: "failed", reason: "the model errored" }), truncated: false } };
  expect(outcomeNote(failed)).toBeUndefined();
  expect(Bun.stripANSI(formatToolActivity(failed))).toContain("✗");
  // A completed helper is an ordinary ✓.
  expect(outcomeNote({ ...event, output: { text: JSON.stringify({ isError: false, status: "completed", response: "ok" }), truncated: false } })).toBeUndefined();
});

test("a network login Casper just added is a grey note, never a red failure; so is no login yet", () => {
  // As call_capability returns it: the broker's envelope, the login line as its summary.
  const result = (summary: string) => JSON.stringify({ isError: true, executed: true, summary, truncated: false, originalBytes: summary.length });
  const ended = (summary: string, toolName = "call_capability"): Extract<RuntimeEvent, { type: "tool_end" }> =>
    ({ type: "tool_end", toolName, input: { operation: "mist.list_sites" }, isError: true, output: { text: result(summary), truncated: false } });
  for (const summary of ["Mist login added (read-only). Call the tool again.", "Central login added (can change the org). Call the tool again.",
    "ClearPass login replaced (read-only). Call the tool again."]) {
    expect(outcomeNote(ended(summary))).toBe("login added · calling it again");
    const line = Bun.stripANSI(formatToolActivity(ended(summary)));
    expect(line).toContain("— login added · calling it again");
    expect(line).not.toMatch(/✗|failed/);
  }
  expect(outcomeNote(ended("Mist has no login yet, and the person didn't add one now. Don't ask them in chat; they can type /mcp login mist."))).toBe("no login yet");
  // A direct tool's plain text too, and a real failure stays red.
  expect(outcomeNote({ ...ended(""), toolName: "mist_list_sites", output: { text: "Mist login added. Call the tool again.", truncated: false } })).toBe("login added · calling it again");
  expect(outcomeNote(ended("HTTP 500 from the Mist API"))).toBeUndefined();
});
