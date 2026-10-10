import { describe, expect, test } from "bun:test";
import { refusalForScreen } from "../src/app/events";
import {
  extractPlan, formatBuildPrompt, formatPlanBlock, isPlanningCommand, parsePlanLines, planDetailsText, planEditorHeading, planEditorLines,
  planEditRows, planScreenRows, planToolGate, readPlanEdit,
} from "../src/flows/plan";

/** An answer in the shape the plan-first flow asks for now. */
const NEW_ANSWER = [
  "Title: A cleaner, animated Casper header",
  "",
  "What you'll see:",
  "The ghost and the CASPER name in one colour, drawn once, with a short fade-in when Casper starts.",
  "",
  "```",
  "  ▄▄█▄▄   CASPER",
  "  █ █ █   0.2.30 · your coding companion",
  "```",
  "",
  "Steps:",
  "1. Write the tests first, then the change.",
  "2. Draw the header in the theme's accent colour.",
  "3. Fade it in over half a second at start.",
  "",
  "Tests:",
  "- a plain terminal shows the one-line header",
  "- the header is drawn once",
  "",
  "Details:",
  "- src/tui/banner.ts: wordmarkHeader() takes a frame",
  "Files: tests/banner.test.ts asserts \\x1b[1m is gone",
].join("\n");

describe("the plan turn's tool gate", () => {
  test("edits and writes are blocked with the planning message", () => {
    expect(planToolGate("edit", { path: "a.ts" })).toBe("Not run: Planning only: Casper blocks file changes until you choose Build.");
    expect(planToolGate("write", { path: "a.ts" })).toBe("Not run: Planning only: Casper blocks file changes until you choose Build.");
  });

  test("every other state-changing tool is blocked too: MCP tools, services, the browser, delegation", () => {
    for (const tool of ["mcp", "service", "browser", "delegate", "netbox_create_device", "lsp"]) {
      expect(planToolGate(tool, {})).toBe(`Not run: Planning only: Casper blocks file changes until you choose Build. While planning it allows only read, grep, find, ls and web lookups, not ${tool}.`);
    }
  });

  test("the look tools and look commands run; writing shell commands do not", () => {
    for (const tool of ["read", "grep", "find", "ls", "web_search", "web_fetch"]) expect(planToolGate(tool, {})).toBeUndefined();
    expect(planToolGate("bash", { command: "ls" })).toBeUndefined();
    expect(planToolGate("bash", { command: "rm x" })).toContain("While planning it runs only look commands");
    expect(planToolGate("bash", {})).toContain("Planning only");
    expect(planToolGate("powershell", { command: "Get-ChildItem src" })).toBeUndefined();
    expect(planToolGate("powershell", { command: "Remove-Item x" })).toContain("Planning only");
    // The refusal names the first part that is not a look command, and why.
    expect(planToolGate("bash", { command: "ls && npm test" })).toEndWith("While planning it runs only look commands such as ls, cat, grep and git log. npm is not one.");
    expect(planToolGate("bash", { command: "git status && git commit -m x" })).toEndWith(" git commit with these options is not one.");
    expect(planToolGate("bash", { command: "ls\ngit log" })).toEndWith(" It must be one line with no redirects, $, backticks, backslashes or lone &.");
    expect(planToolGate("powershell", { command: "Remove-Item x" })).toEndWith(" Remove-Item is not one.");
    expect(planToolGate("powershell", { command: "Get-ChildItem (Remove-Item x)" })).toEndWith(" Brackets and @ can run commands in PowerShell, so they are refused.");
    expect(planToolGate("bash", { command: "'' x" })).toEndWith("grep and git log.");
    // The screen shows 240 characters of a refusal: the reason is never cut off.
    for (const command of ["ls\ngit log", "git status && git commit -m x"]) expect(refusalForScreen(planToolGate("bash", { command })!)!.length).toBeLessThanOrEqual(240);
  });

  test("look commands and pipelines of them are allowed", () => {
    for (const command of [
      "ls -la src", "cat README.md | head -20", "grep -rn 'def main' src 2>/dev/null", "rg TODO src && git status",
      "git log --oneline -5", "git diff HEAD~1 -- src", "find . -name '*.py' -type f", "sed -n 10,40p src/app.py",
      "wc -l src/*.ts", "git branch -a", "sort names.txt | uniq -c",
      // cd changes no file, and git -C only picks the repository.
      "cd Casper && find site -type f | head -50 && git log --oneline -10 && cat package.json", "git -C Casper log --oneline -5",
    ]) expect({ command, ok: isPlanningCommand(command) }).toEqual({ command, ok: true });
  });

  test("writes, runs, fetches, secrets and tricks are refused", () => {
    for (const command of [
      "rm x", "echo hi > a.txt", "cat a >> b", "tee out.txt", "ls; touch x", "ls && python evil.py", "cat x | sh",
      "find . -delete", "find . -exec rm {} ;", "sed -i s/a/b/ f", "sed -n 1w/tmp/x f", "sort -o out in", "uniq in out",
      "git checkout main", "git commit -m x", "git diff --output=x", "git -c core.pager=sh log", "git config user.name x",
      "echo $API_KEY", "cat `which x`", "ls $(pwd)", "env", "printenv", "curl http://x", "awk '{system(\"id\")}' f",
      "rg --pre ./x foo", "fd -x rm", "sleep 100 &", "ls\nrm x", "cat <<EOF", "npm install", "ls \\; rm x", "",
      "cd x && rm y", "cd -P x && ls", "cd x y && ls", "git -C x -c core.pager=sh log", "git -C x commit -m y", "git -C x",
    ]) expect({ command, ok: isPlanningCommand(command) }).toEqual({ command, ok: false });
  });

  test("look commands with an option that writes or runs something are refused", () => {
    for (const command of [
      "sed -n 1p -i app.py", "sed -n 1p --in-place app.py", "sort -uo out.txt in.txt", "tree -R -H . src", "tree -ao out.txt",
      "fd -Hx rm", "bat --pager='sh -c id' README.md", "rg --hostname-bin=./evil foo", "file -C -m magic", "date -us 2020-01-01",
    ]) expect({ command, ok: isPlanningCommand(command) }).toEqual({ command, ok: false });
    for (const command of ["gci (Remove-Item x)", "Get-Content @args", "gc x -Path {rm y}", "gci [System.IO.File]::Delete('x')"]) {
      expect({ command, ok: isPlanningCommand(command, "powershell") }).toEqual({ command, ok: false });
    }
    // The same commands without those options still run.
    for (const command of ["sed -n 1p app.py", "sort -u in.txt", "tree -a src", "fd -H name", "bat README.md", "file app.py"]) {
      expect({ command, ok: isPlanningCommand(command) }).toEqual({ command, ok: true });
    }
    expect(isPlanningCommand("Get-Content README.md", "powershell")).toBe(true);
  });
});

describe("the plan", () => {
  const answer = [
    "The request is clear.",
    "",
    "**Plan:**",
    "1. Read `src/inventory.py` and its tests",
    "2. **Add** a failing test for an empty hostname",
    "3. Make `parse_host` raise ValueError for an empty name",
    "",
    "Tests:",
    "- empty hostname raises ValueError(\"hostname is empty\")",
    "- \"r1 \" is trimmed to \"r1\"",
  ].join("\n");

  test("steps and tests come from the Plan: and Tests: sections (the older answer, read as before)", () => {
    expect(extractPlan(answer)).toStrictEqual({
      steps: ["Read src/inventory.py and its tests", "Add a failing test for an empty hostname", "Make parse_host raise ValueError for an empty name"],
      tests: ["empty hostname raises ValueError(\"hostname is empty\")", "\"r1 \" is trimmed to \"r1\""],
      // The one line before the plan is the model's note, shown above the steps.
      note: ["The request is clear."],
    });
    expect(extractPlan("I would just do it.")).toStrictEqual({ steps: [], tests: [] });
    // A long step stays whole: nothing is cut with "...".
    const long = `Change the header so ${"the ghost and the wordmark ".repeat(15)}draw once`;
    expect(extractPlan(`Plan:\n1. ${long}\n`).steps).toEqual([long]);
  });

  test("the newer answer: title, what you'll see with its mock-up, steps, tests once, and details", () => {
    const plan = extractPlan(NEW_ANSWER);
    expect(plan.title).toBe("A cleaner, animated Casper header");
    expect(plan.see).toEqual([
      "The ghost and the CASPER name in one colour, drawn once, with a short fade-in when Casper starts.",
      "",
      "  ▄▄█▄▄   CASPER",
      "  █ █ █   0.2.30 · your coding companion",
    ]);
    expect(plan.steps).toEqual(["Write the tests first, then the change.", "Draw the header in the theme's accent colour.", "Fade it in over half a second at start."]);
    expect(plan.tests).toEqual(["a plain terminal shows the one-line header", "the header is drawn once"]);
    expect(plan.details).toEqual(["- src/tui/banner.ts: wordmarkHeader() takes a frame", "Files: tests/banner.test.ts asserts \\x1b[1m is gone"]);
    expect(plan.note).toBeUndefined();
  });

  test("the plan screen: what you'll see and the steps, the tests as one line, details hidden, long lines wrapped", () => {
    const plan = extractPlan(NEW_ANSWER);
    const rows = planScreenRows(plan, 60, { more: "Ctrl+T shows {what}" });
    expect(rows[0]).toBe("Casper plan · A cleaner, animated Casper header");
    expect(rows).toContain("What you'll see");
    expect(rows).toContain("    ▄▄█▄▄   CASPER");
    expect(rows).toContain("  1. Write the tests first, then the change.");
    expect(rows.at(-1)).toBe("Tests: 2 cases · Ctrl+T shows them and the details");
    // The cases are not repeated and the details stay hidden.
    expect(rows.join("\n")).not.toContain("the header is drawn once");
    expect(rows.join("\n")).not.toContain("wordmarkHeader");
    // Wrapped, never cut: every word of the long line is there, and no row is wider than the screen.
    const long = { steps: [`Fade ${"the header in slowly ".repeat(8)}at start`], tests: [] };
    const wrapped = planScreenRows(long, 40);
    expect(wrapped.every((row) => row.length <= 40)).toBe(true);
    expect(wrapped.join(" ").replace(/\s+/g, " ")).toContain(long.steps[0]!);
    expect(wrapped.join("\n")).not.toContain("...");
    expect(wrapped.at(-1)).toBe("Tests: none listed");
    // A run that cannot ask lists everything.
    const full = planScreenRows(plan, 80, { full: true }).join("\n");
    expect(full).toContain("  - the header is drawn once");
    expect(full).toContain("wordmarkHeader() takes a frame");
    expect(planDetailsText(plan)).toBe("Tests:\n- a plain terminal shows the one-line header\n- the header is drawn once\n\n"
      + "Details:\n- src/tui/banner.ts: wordmarkHeader() takes a frame\nFiles: tests/banner.test.ts asserts \\x1b[1m is gone");
  });

  test("an edit shows only what changed: words typed after a line are your note, not part of the step", () => {
    const plan = extractPlan(NEW_ANSWER);
    const lines = planEditorLines(plan);
    // The owner's real edit: a remark typed at the end of the last test line.
    const edited = [...lines.slice(0, -1), `${lines.at(-1)} - this looks confusing to me`];
    const { plan: after, edit } = readPlanEdit(plan, edited);
    expect(after.tests).toEqual(plan.tests);
    expect(after.steps).toEqual(plan.steps);
    expect(after.notes).toEqual(["this looks confusing to me"]);
    expect(after.details).toEqual(plan.details);
    expect(planEditRows(edit, 80)).toEqual(["Your note: this looks confusing to me"]);
    // A removed step, a new one, and a Note: line.
    const changed = readPlanEdit(plan, [lines[0]!, "Keep the old header for TERM=dumb", lines[2]!, "Note: smaller ghost please", ...lines.slice(3)]);
    expect(changed.plan.steps).toEqual(["Write the tests first, then the change.", "Keep the old header for TERM=dumb", "Fade it in over half a second at start."]);
    expect(planEditRows(changed.edit, 80)).toEqual(["Your changes:", "  - Draw the header in the theme's accent colour.",
      "  + Keep the old header for TERM=dumb", "Your note: smaller ghost please"]);
    expect(planEditRows(readPlanEdit(plan, lines).edit, 80)).toBeUndefined();
  });

  test("what you'll see written on its header line stays on the screen, with the mock-up under it", () => {
    const plan = extractPlan(["Title: Header", "", "What you'll see: one small line with the ghost, and the name fades in.", "```",
      "  ▄▀▀▄  Casper 0.2.30", "```", "", "Steps:", "1. Replace the block letters with one line", "", "Tests:", "- one line is drawn"].join("\n"));
    expect(plan.see).toEqual(["one small line with the ghost, and the name fades in.", "  ▄▀▀▄  Casper 0.2.30"]);
    expect(plan.details).toBeUndefined();
    expect(plan.note).toBeUndefined();
    expect(plan.steps).toEqual(["Replace the block letters with one line"]);
    const bug = extractPlan("**What you'll see:** an empty hostname now gives a clear error.\n\nSteps:\n1. Check the name first\n");
    expect(bug.see).toEqual(["an empty hostname now gives a clear error."]);
    expect(bug.note).toBeUndefined();
  });

  test("nothing the model wrote is lost: a section the plan does not know goes with the details", () => {
    const plan = extractPlan("Plan:\n1. a step here\n\nTests:\n- a case here\n\nRisks:\nThis may break the CLI.\n");
    expect(plan.steps).toEqual(["a step here"]);
    expect(plan.tests).toEqual(["a case here"]);
    expect(plan.details).toEqual(["Risks:", "This may break the CLI."]);
    expect(planDetailsText(plan)).toContain("This may break the CLI.");
  });

  test("steps only moved in the editor are a change: the screen shows their new order", () => {
    const plan = { steps: ["first step", "second step"], tests: [] };
    const { plan: after, edit } = readPlanEdit(plan, ["second step", "first step"]);
    expect(after.steps).toEqual(["second step", "first step"]);
    expect(planEditRows(edit, 80)).toEqual(["Your changes:", "  The steps in their new order:", "    1. second step", "    2. first step"]);
  });

  test("words added to a line without a separator change the line; after - or ( they are a note", () => {
    const plan = { steps: ["Add a check before connecting."], tests: [] };
    const grown = readPlanEdit(plan, ["Add a check before connecting. and before saving"]);
    expect(grown.plan.steps).toEqual(["Add a check before connecting. and before saving"]);
    expect(planEditRows(grown.edit, 80)).toEqual(["Your changes:", "  - Add a check before connecting.", "  + Add a check before connecting. and before saving"]);
    expect(readPlanEdit(plan, ["Add a check before connecting. (why here?)"]).edit.notes).toEqual(["why here?"]);
    expect(readPlanEdit(plan, ["Add a check before connecting. // keep it short"]).edit.notes).toEqual(["keep it short"]);
    expect(readPlanEdit(plan, ["Add a check before connecting. note: ask me first"]).edit.notes).toEqual(["ask me first"]);
  });

  test("Build gets the whole plan: the steps, what you'll see, your notes and the details", () => {
    const plan = { ...extractPlan(NEW_ANSWER), notes: ["this looks confusing to me"] };
    const block = formatPlanBlock(plan);
    expect(block).toStartWith("Casper plan (the user read and accepted it). Follow these steps in order:\n1. Write the tests first, then the change.");
    expect(block).toContain("  ▄▄█▄▄   CASPER");
    expect(block).toContain("- this looks confusing to me");
    expect(block).toContain("wordmarkHeader() takes a frame");
    expect(formatBuildPrompt("r", plan)).toContain(block);
  });

  test("the editor shows steps then Test: lines, and edited lines read back", () => {
    const plan = extractPlan(answer);
    const lines = planEditorLines(plan);
    expect(lines.at(-1)).toBe("Test: \"r1 \" is trimmed to \"r1\"");
    expect(planEditorHeading(plan)).toEqual({ heading: "Casper plan: 3 steps, 2 cases to test.", hint: "Enter goes on to 1 Stop · 2 Build · edit lines · Esc stops without building" });
    const edited = parsePlanLines(["1. Read the parser", "", "Test: empty host is an error", "Keep the old flag", "tests: port defaults to 22"]);
    expect(edited).toEqual({ steps: ["Read the parser", "Keep the old flag"], tests: ["empty host is an error", "port defaults to 22"] });
  });

  test("the build prompt carries the request, the numbered steps and one test per case", () => {
    const prompt = formatBuildPrompt("Reject empty hostnames", { steps: ["Add the test", "Change the parser"], tests: ["empty host is an error"] });
    expect(prompt).toContain("Reject empty hostnames");
    expect(prompt).toContain("1. Add the test\n2. Change the parser");
    expect(prompt).toContain("write one test per case");
    expect(prompt).toContain("- empty host is an error");
    expect(formatBuildPrompt("r", { steps: ["s1"], tests: [] })).not.toContain("Casper's checklist");
  });
});
