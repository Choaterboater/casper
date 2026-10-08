import { describe, expect, test } from "bun:test";
import {
  extractPlan, formatBuildPrompt, isPlanningCommand, parsePlanLines, planEditorHeading, planEditorLines, planToolGate,
} from "../src/flows/plan";

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
  });

  test("look commands and pipelines of them are allowed", () => {
    for (const command of [
      "ls -la src", "cat README.md | head -20", "grep -rn 'def main' src 2>/dev/null", "rg TODO src && git status",
      "git log --oneline -5", "git diff HEAD~1 -- src", "find . -name '*.py' -type f", "sed -n 10,40p src/app.py",
      "wc -l src/*.ts", "git branch -a", "sort names.txt | uniq -c",
    ]) expect({ command, ok: isPlanningCommand(command) }).toEqual({ command, ok: true });
  });

  test("writes, runs, fetches, secrets and tricks are refused", () => {
    for (const command of [
      "rm x", "echo hi > a.txt", "cat a >> b", "tee out.txt", "ls; touch x", "ls && python evil.py", "cat x | sh",
      "find . -delete", "find . -exec rm {} ;", "sed -i s/a/b/ f", "sed -n 1w/tmp/x f", "sort -o out in", "uniq in out",
      "git checkout main", "git commit -m x", "git diff --output=x", "git -c core.pager=sh log", "git config user.name x",
      "echo $API_KEY", "cat `which x`", "ls $(pwd)", "env", "printenv", "curl http://x", "awk '{system(\"id\")}' f",
      "rg --pre ./x foo", "fd -x rm", "sleep 100 &", "ls\nrm x", "cat <<EOF", "npm install", "ls \\; rm x", "",
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

  test("steps and tests come from the Plan: and Tests: sections", () => {
    expect(extractPlan(answer)).toEqual({
      steps: ["Read src/inventory.py and its tests", "Add a failing test for an empty hostname", "Make parse_host raise ValueError for an empty name"],
      tests: ["empty hostname raises ValueError(\"hostname is empty\")", "\"r1 \" is trimmed to \"r1\""],
    });
    expect(extractPlan("I would just do it.")).toEqual({ steps: [], tests: [] });
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
