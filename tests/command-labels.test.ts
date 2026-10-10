import { expect, test } from "bun:test";
import { commandLabel } from "../src/tui/format";

test("a script names the programs that do the work, not its echo headings, cd or comments", () => {
  expect(commandLabel("echo === HEAD ===\ngit rev-parse HEAD\necho === origin ===\ngit log --oneline -3 origin/main\ngit diff --stat"))
    .toBe("git rev-parse, git log, git diff");
  expect(commandLabel("cd /work/app && git status && git log --oneline -5")).toBe("git status, git log");
  expect(commandLabel("# list the tests\nls tests; bun test tests/a.test.ts")).toBe("ls tests, bun test");
  // The same program twice is named once.
  expect(commandLabel("git rev-parse HEAD; git rev-parse origin/main")).toBe("git rev-parse");
});

test("a heredoc script says its program and how many lines it holds; cat into a file says the file", () => {
  expect(commandLabel("python3 <<'EOF'\nimport json\nprint(1)\nEOF")).toBe("python3 script (2 lines)");
  expect(commandLabel("cat > /tmp/pr.md <<'EOF'\n# Title\nbody\nEOF\ngh pr create --body-file /tmp/pr.md")).toBe("write /tmp/pr.md (2 lines), gh pr");
  expect(commandLabel("node <<-EOF\n\tconsole.log(1)\n\tEOF")).toBe("node script (1 line)");
});

test("quotes, $(…), pipes, loops and subshells are read as the shell reads them", () => {
  // A semicolon inside quotes is not a new command; inline code is no target.
  expect(commandLabel("python -c \"import x; print(1)\" && ls -la")).toBe("python -c, ls");
  // A pipe keeps its first program; $(…) stays inside its command.
  expect(commandLabel("grep -rn TODO src | head -20 && echo \"$(date; whoami)\" && wc -l a.ts")).toBe("grep TODO, wc a.ts");
  expect(commandLabel("for k in a b; do\n  grep -rn \"$k\" docs | head -3\ndone")).toBe("grep $k …");
  expect(commandLabel("(which bun && bun --version) 2>&1")).toBe("which bun, bun");
  expect(commandLabel("export X=1 \\\n  && bun test tests/a.test.ts")).toBe("bun test …");
});

test("one command keeps the short label it always had", () => {
  expect(commandLabel("git status")).toBe("git status");
  expect(commandLabel("cd sample-tools && python3 -m pytest -q tests/test_x.py")).toBe("python3 -m pytest …");
  expect(commandLabel("npm test && echo done")).toBe("npm test");
  expect(commandLabel("echo hi; echo bye")).toBe("echo hi …");
});

test("a hidden secret inside a script is never taken for a program, and a long list says how many more", () => {
  expect(commandLabel("sshpass -p <secret hidden> ssh root@lab 'uptime' && sshpass -p <secret hidden> scp a root@lab:/tmp")).toBe("ssh root@lab, scp a");
  expect(commandLabel("mysql -p <secret hidden> -h db; psql -W <secret hidden> app")).not.toContain("hidden>");
  const many = commandLabel(Array.from({ length: 12 }, (_, index) => `tool${index} run`).join("\n"), 40);
  expect([...many].length).toBeLessThanOrEqual(40);
  expect(many).toMatch(/^tool0 run, tool1 run.* \+\d+ more$/);
});
