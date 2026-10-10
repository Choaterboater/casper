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
  // break and continue leave a loop: they are not programs.
  expect(commandLabel("for i in 1 2; do\n  sleep 15\n  if echo \"$s\" | grep -q done; then break; fi\ndone\ngh run list -L1")).toBe("sleep 15, gh run");
  expect(commandLabel("for f in a b; do\n  wc -l $f || continue\ndone")).not.toContain("continue");
  // A quoted or backslash-escaped space stays inside its word, and a target with a space is shown quoted.
  expect(commandLabel("ls \"/Applications/Google Chrome.app\"")).toBe("ls \"/Applications/Google Chrome.app\"");
  expect(commandLabel("ls /Applications/Google\\ Chrome.app")).toBe("ls \"/Applications/Google Chrome.app\"");
  expect(commandLabel("grep -n \"── Approval\" site/index.html")).toBe("grep \"── Approval\" …");
  expect(commandLabel("grep -E '\"(main|module)\"' package.json")).toBe("grep \"(main|module)\" …");
  expect(commandLabel("osascript -e 'tell application \"Safari\" to activate'")).toBe("osascript 'tell application \"Safari\" to activate'");
  expect(commandLabel("\"C:\\Program Files\\Git\\bin\\git.exe\" status")).toBe("\"C:\\Program Files\\Git\\bin\\git.exe\" status");
  // A backslash before anything but a space or a quote is a PowerShell path separator, kept as typed.
  expect(commandLabel("Get-Content src\\app.ts")).toBe("Get-Content src\\app.ts");
  expect(commandLabel(".\\node_modules\\.bin\\tsc --noEmit")).toBe(".\\node_modules\\.bin\\tsc");
  expect(commandLabel("Get-Content \\\\server\\share\\a.txt")).toBe("Get-Content \\\\server\\share\\a.txt");
});

test("one command keeps the short label it always had", () => {
  expect(commandLabel("git status")).toBe("git status");
  expect(commandLabel("cd sample-tools && python3 -m pytest -q tests/test_x.py")).toBe("python3 -m pytest …");
  expect(commandLabel("npm test && echo done")).toBe("npm test");
  expect(commandLabel("echo hi; echo bye")).toBe("echo hi …");
  // A wrapper's own options and their values are not the program.
  expect(commandLabel("env -i HOME=/tmp/h PATH=/usr/bin casper new python-cli ping-tool")).toBe("casper new …");
  expect(commandLabel("sudo -u root apt update")).toBe("apt update");
  expect(commandLabel("nice -n 10 make")).toBe("make");
  expect(commandLabel("time -p bun test")).toBe("bun test");
  expect(commandLabel("mkdir -p $W/home\ncd $W && env -i HOME=$W/home casper new python-cli x")).toBe("mkdir $W/home, casper new");
  // Only a wrapper's options, with no program after them: the label is the wrapper, never an option's value.
  for (const [command, label] of [["sudo -u root", "sudo"], ["env -u HOME", "env"], ["nice -n 5", "nice"], ["sudo -E", "sudo"],
    ["sshpass -p <secret hidden>", "sshpass"]]) expect({ command, label: commandLabel(command!) }).toEqual({ command, label });
});

test("a hidden secret inside a script is never taken for a program, and a long list says how many more", () => {
  expect(commandLabel("sshpass -p <secret hidden> ssh root@lab 'uptime' && sshpass -p <secret hidden> scp a root@lab:/tmp")).toBe("ssh root@lab, scp a");
  expect(commandLabel("mysql -p <secret hidden> -h db; psql -W <secret hidden> app")).not.toContain("hidden>");
  const many = commandLabel(Array.from({ length: 12 }, (_, index) => `tool${index} run`).join("\n"), 40);
  expect([...many].length).toBeLessThanOrEqual(40);
  expect(many).toMatch(/^tool0 run, tool1 run.* \+\d+ more$/);
});
