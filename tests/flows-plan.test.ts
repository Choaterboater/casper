import { describe, expect, test } from "bun:test";
import { refusalForScreen } from "../src/app/events";
import {
  extractPlan, formatBuildPrompt, formatPlanBlock, formatPlanChangePrompt, isPlanningCommand, isSpecPlan, planDetailsText,
  planMarkdown, planScreenRows, planToolGate, type ParsedPlan,
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

  test("every other state-changing tool is blocked too: MCP tools, services, the browser, builders", () => {
    for (const tool of ["mcp", "service", "browser", "delegate", "github", "netbox_create_device", "lsp", "plan_step"]) {
      expect(planToolGate(tool, {})).toBe(`Not run: Planning only: Casper blocks file changes until you choose Build. While planning it allows only read, grep, find, ls, web and GitHub lookups and read-only helpers, not ${tool}.`);
    }
    expect(planToolGate("delegate", { role: "builder", goal: "build it" })).toContain("Planning only");
    expect(planToolGate("github", { verb: "rerun", number: 1 })).toContain("Planning only");
  });

  test("GitHub lookups and read-only helpers can research for the plan", () => {
    for (const verb of ["prs", "pr", "ci"]) expect(planToolGate("github", { verb, number: 12 })).toBeUndefined();
    for (const role of ["explorer", "reviewer"]) expect(planToolGate("delegate", { role, goal: "find the router" })).toBeUndefined();
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
    ]);
    expect(plan.mockup).toEqual([
      "  ▄▄█▄▄   CASPER",
      "  █ █ █   0.2.30 · your coding companion",
    ]);
    expect(plan.steps).toEqual(["Write the tests first, then the change.", "Draw the header in the theme's accent colour.", "Fade it in over half a second at start."]);
    expect(plan.tests).toEqual(["a plain terminal shows the one-line header", "the header is drawn once"]);
    expect(plan.details).toEqual(["- src/tui/banner.ts: wordmarkHeader() takes a frame", "Files: tests/banner.test.ts asserts \\x1b[1m is gone"]);
    expect(plan.note).toBeUndefined();
  });

  test("the plan screen: what you'll see and cases, details hidden, long lines wrapped", () => {
    const plan = extractPlan(NEW_ANSWER);
    const rows = planScreenRows(plan, 60, { more: "Ctrl+T shows the details" });
    expect(rows[0]).toBe("Casper plan · A cleaner, animated Casper header");
    expect(rows).toContain("What you'll see");
    expect(rows.some(row => /^  │   ▄▄█▄▄   CASPER +│$/.test(row))).toBe(true);
    expect(rows).toContain("  1. Write the tests first, then the change.");
    expect(rows.at(-1)).toBe("Ctrl+T shows the details");
    // Cases appear once; only the build details stay hidden.
    expect(rows.filter((row) => row.includes("the header is drawn once"))).toHaveLength(1);
    expect(rows.join("\n")).not.toContain("wordmarkHeader");
    // Wrapped, never cut: every word of the long line is there, and no row is wider than the screen.
    const long = { steps: [`Fade ${"the header in slowly ".repeat(8)}at start`], tests: [] };
    const wrapped = planScreenRows(long, 40);
    expect(wrapped.every((row) => row.length <= 40)).toBe(true);
    expect(wrapped.join(" ").replace(/\s+/g, " ")).toContain(long.steps[0]!);
    expect(wrapped.join("\n")).not.toContain("...");
    expect(wrapped.join("\n")).not.toContain("Tests");
    // A run that cannot ask lists everything.
    const full = planScreenRows(plan, 80, { full: true }).join("\n");
    expect(full).toContain("  2. the header is drawn once");
    expect(full).toContain("wordmarkHeader() takes a frame");
    expect(planDetailsText(plan)).toBe("Details:\n- src/tui/banner.ts: wordmarkHeader() takes a frame\nFiles: tests/banner.test.ts asserts \\x1b[1m is gone");
    expect(planDetailsText({ steps: ["a step"], tests: ["a case"] })).toBeUndefined();
  });

  test("the plan screen numbers the steps", () => {
    const rows = planScreenRows({ steps: ["First action", "Second action"], tests: [] }, 60);
    expect(rows.filter((row) => /^  \d+\./.test(row))).toEqual(["  1. First action", "  2. Second action"]);
  });

  test("the plan screen numbers the test cases", () => {
    const rows = planScreenRows({ steps: [], tests: ["First case", "Second case"] }, 60);
    expect(rows.filter((row) => /^  \d+\./.test(row))).toEqual(["  1. First case", "  2. Second case"]);
  });

  test("what you'll see written on its header line stays on the screen, with the mock-up under it", () => {
    const plan = extractPlan(["Title: Header", "", "What you'll see: one small line with the ghost, and the name fades in.", "```",
      "  ▄▀▀▄  Casper 0.2.30", "```", "", "Steps:", "1. Replace the block letters with one line", "", "Tests:", "- one line is drawn"].join("\n"));
    expect(plan.see).toEqual(["one small line with the ghost, and the name fades in."]);
    expect(plan.mockup).toEqual(["  ▄▀▀▄  Casper 0.2.30"]);
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

  test("a change prompt carries the whole current plan with the screen's numbering", () => {
    const prompt = formatPlanChangePrompt(extractPlan(NEW_ANSWER), "drop step 3 and also test X");
    expect(prompt).toContain("User's change: drop step 3 and also test X");
    expect(prompt).toContain("Title: A cleaner, animated Casper header");
    expect(prompt).toContain("What you'll see:\nThe ghost and the CASPER name");
    expect(prompt).toContain("3. Fade it in over half a second at start.");
    expect(prompt).toContain("Done means:\n1. a plain terminal shows the one-line header\n2. the header is drawn once");
    expect(prompt).toContain("wordmarkHeader() takes a frame");
    expect(prompt).toContain("Return the whole revised plan in the same shape");
    expect(prompt).toContain("Do not build.");
  });

  test("Build gets the whole plan: the steps, what you'll see and the details", () => {
    const plan = extractPlan(NEW_ANSWER);
    const block = formatPlanBlock(plan);
    expect(block).toStartWith("Casper plan (the user read and accepted it). Follow these steps in order:\n1. Write the tests first, then the change.");
    expect(block).toContain("  ▄▄█▄▄   CASPER");
    expect(block).toContain("wordmarkHeader() takes a frame");
    expect(formatBuildPrompt("r", plan)).toContain(block);
  });

  test("plan mode omits steps that only re-confirm known facts or an established cause", async () => {
    const { bundledFlows, findFlow } = await import("../src/flows/catalog");
    const body = findFlow(bundledFlows(), "plan-first")!.body;
    expect(body).toContain("Do not add steps just to re-confirm known facts or an established cause");
    expect(body).toContain("reviewer agents\n  re-checking it");
    expect(body).toContain("investigate only a specific unresolved question");
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

const SPEC: ParsedPlan = {
  title: "A useful project board",
  goal: ["Make the next task easy to find."],
  found: ["- src/pages/board.ts already lists tasks."],
  openQuestions: ["- Should archived tasks be searchable?"],
  screens: ["- Board: grouped cards and an add-task form."],
  data: ["- Task: title, status and due date."],
  look: ["- Reuse the existing spacing and colours."],
  firstVersion: ["- Create, edit and move a task."],
  later: ["- Shared boards."],
  steps: [],
  tests: ["a new task appears in the selected group", "an empty title shows a validation error"],
  details: ["- Keep the board route in src/pages/board.ts."],
};

const SPEC_ANSWER = [
  "# Title: A useful project board", "", "## Goal: Make the next task easy to find.",
  "", "### Found", "- src/pages/board.ts already lists tasks.",
  "", "**Open questions:** - Should archived tasks be searchable?",
  "", "## Screens", "- Board: grouped cards and an add-task form.",
  "", "Data: - Task: title, status and due date.",
  "", "**Look**: - Reuse the existing spacing and colours.",
  "", "## First version: - Create, edit and move a task.",
  "", "Later:", "- Shared boards.",
  "", "## Done means", "1. a new task appears in the selected group",
  "2. an empty title shows a validation error", "", "Details:", "- Keep the board route in src/pages/board.ts.",
].join("\n");

describe("designed plan model", () => {
  test("reads a complete spec, including inline Markdown headers, without implementation steps", () => {
    const plan = extractPlan(SPEC_ANSWER);
    expect(plan).toEqual(SPEC);
    expect(isSpecPlan(plan)).toBe(true);
    expect(plan.steps).toEqual([]);
    expect(plan.note).toBeUndefined();
  });

  test.each(["Goal: value", "# Goal: value", "### Goal: value ###", "**Goal:** value", "**Goal**: value", "__Goal__: value", "## gOaL\nvalue"])("reads %s", (text) => {
    expect(extractPlan(text).goal).toEqual(["value"]);
  });

  test("whole-answer Markdown fences and the older colon-free Title still parse", () => {
    expect(extractPlan(`\`\`\`markdown\n${SPEC_ANSWER}\n\`\`\``)).toEqual(SPEC);
    expect(extractPlan(`~~~md\n${SPEC_ANSWER}\n~~~`)).toEqual(SPEC);
    expect(extractPlan("Title A smaller header\nPlan:\n1. Draw the header\nTests:\n- it is drawn once")).toEqual({
      title: "A smaller header", steps: ["Draw the header"], tests: ["it is drawn once"],
    });
  });

  test("Tests is an alias for Done means; both sections are kept if supplied", () => {
    const plan = extractPlan("Screens: a board\nDone means: the task is visible\nTests:\n- the empty title is rejected");
    expect(plan.tests).toEqual(["the task is visible", "the empty title is rejected"]);
    expect(plan.screens).toEqual(["a board"]);
    expect(extractPlan("Steps: 1. Read the parser\nTests: - an empty input fails")).toEqual({
      steps: ["Read the parser"], tests: ["an empty input fails"],
    });
  });

  test("full Done means criteria survive parsing, saving, revising and building beyond checklist limits", () => {
    const long = `The form must ${"retain the supplied task title and selected group; ".repeat(8)}never submit an empty title.`;
    const tests = [long, ...Array.from({ length: 84 }, (_, index) => `Requirement ${index + 2} remains in scope.`)];
    const plan = extractPlan(`Screens: a board\nDone means:\n${tests.map((item) => `- ${item}`).join("\n")}`);
    expect(plan.tests).toEqual(tests);
    expect(extractPlan(planMarkdown(plan))).toEqual(plan);
    for (const text of [planMarkdown(plan), formatPlanChangePrompt(plan, "Keep every requirement"), formatPlanBlock(plan), formatBuildPrompt("Build the board", plan)]) {
      for (const item of tests) expect(text).toContain(item);
    }
  });

  test("numbered and bulleted list continuations stay with their item", () => {
    const plan = extractPlan([
      "Steps:", "1. Add a form with", "   required title validation", "2) Save the task", "   in the selected group.",
      "Done means:", "- An empty title", "  shows a validation error.", "* A valid title", "  creates one task.",
      "+ The selected group", "  is retained.", "• A wrapped criterion", "continues without indentation.",
      "", "  An indented paragraph still qualifies that criterion.", "1. The task remains visible", "   after a reload.",
    ].join("\n"));
    expect(plan.steps).toEqual(["Add a form with required title validation", "Save the task in the selected group."]);
    expect(plan.tests).toEqual([
      "An empty title shows a validation error.", "A valid title creates one task.", "The selected group is retained.",
      "A wrapped criterion continues without indentation. An indented paragraph still qualifies that criterion.",
      "The task remains visible after a reload.",
    ]);
    expect(extractPlan(planMarkdown(plan))).toEqual(plan);
  });

  test("inline and standalone prose remain separate criteria, including across section aliases", () => {
    const plan = extractPlan([
      "Steps: Add the form.", "Save the task.", "Done means: The form is visible.", "The title is required.",
      "", "- A valid title creates a task", "  in the selected group.", "", "The form then clears.",
      "Tests: - The task survives a reload.", "Done means: The group remains selected.",
    ].join("\n"));
    expect(plan.steps).toEqual(["Add the form.", "Save the task."]);
    expect(plan.tests).toEqual([
      "The form is visible.", "The title is required.", "A valid title creates a task in the selected group.",
      "The form then clears.", "The task survives a reload.", "The group remains selected.",
    ]);
  });

  test("only populated design sections identify a spec, not an empty answer or context alone", () => {
    expect(isSpecPlan({ steps: [], tests: [] })).toBe(false);
    expect(isSpecPlan({ steps: ["Build it"], tests: [], goal: ["A goal"], found: ["A fact"] })).toBe(false);
    expect(isSpecPlan({ steps: [], tests: [], screens: ["", "  "], look: [] })).toBe(false);
    for (const key of ["screens", "data", "look", "firstVersion", "later"] as const) {
      expect(isSpecPlan({ steps: [], tests: [], [key]: ["a design decision"] })).toBe(true);
    }
  });

  test("save/edit text round-trips every section, including optional legacy fields", () => {
    const plan: ParsedPlan = { ...SPEC, note: ["One unresolved choice remains."],
      see: ["A compact board.", "", "  [To do]  [Done]"], steps: ["Add a failing test", "Implement the accepted first version"] };
    const saved = planMarkdown(plan);
    expect(saved).toContain("Done means:\n1. a new task appears");
    expect(extractPlan(saved)).toEqual(plan);
    const legacy = extractPlan(NEW_ANSWER);
    expect(extractPlan(planMarkdown(legacy))).toEqual(legacy);
    expect(planMarkdown({ steps: [], tests: [], screens: [], goal: [" "] })).toBe("");
  });

  test("fenced diagrams cannot become sections, including after a save/edit round trip", () => {
    const plan = extractPlan("Screens:\n```text\n  [Board]\nGoal:\n  literal label\n```\nData: task titles\nDetails:\nFiles: src/pages/board.ts");
    expect(plan.screens).toEqual(["  [Board]", "Goal:", "  literal label"]);
    expect(plan.goal).toBeUndefined();
    expect(plan.data).toEqual(["task titles"]);
    expect(extractPlan(planMarkdown(plan))).toEqual(plan);
  });

  test("revisions and builds retain every spec section, scope, facts and checklist guidance", () => {
    const change = formatPlanChangePrompt(SPEC, "Keep task titles shorter");
    const block = formatPlanBlock(SPEC);
    for (const text of [change, block, formatBuildPrompt("Build a board", SPEC)]) {
      for (const lines of [SPEC.goal, SPEC.found, SPEC.openQuestions, SPEC.screens, SPEC.data, SPEC.look, SPEC.firstVersion, SPEC.later, SPEC.tests, SPEC.details]) {
        for (const line of lines!) expect(text).toContain(line);
      }
      expect(text).toContain("write one test per case");
    }
    expect(change).toContain("Do not build.");
    expect(block).toStartWith("Casper plan (the user read and accepted it).");
    expect(block).not.toContain("Follow these steps in order:");
    expect(block).toContain("Later is not part of this build");
    expect(block).toContain("Open questions as unresolved");
    expect(formatBuildPrompt("Build a board", SPEC)).toContain("Casper's checklist");
  });
});
