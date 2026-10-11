import { expect, test } from "bun:test";
import { blockedGitCommand } from "../src/runtime/git-guard";

test("git commands that discard uncommitted work are blocked; reading, committing and stashing are not", () => {
  for (const command of [
    "git stash drop", "git stash clear", "cd x && git stash drop stash@{1}", "git -C /repo reset --hard HEAD", "git checkout -- src/a.py",
    "git checkout .", "git checkout -f main", "git restore src/a.py", "git restore --staged --worktree a", "git switch -f main",
    "git switch --discard-changes main", "git clean -fd", "pytest; git stash clear",
  ]) expect({ command, blocked: Boolean(blockedGitCommand(command)) }).toEqual({ command, blocked: true });
  for (const command of [
    "git status", "git diff", "git log --oneline", "git stash list", "git stash show -p", "git add -A", "git commit -m x",
    "git checkout -b feature", "git restore --staged a.py", "git clean -n", "git clean --dry-run", "git reset HEAD a.py",
    "git reset --soft HEAD~1", "git reset --keep HEAD~1", "git reset --merge", "git stash", "git stash push -m tmp", "git stash -u",
    "git stash save wip", "git stash pop", "git stash apply", "echo git stash drop is bad", "pytest -q",
  ]) expect({ command, blocked: Boolean(blockedGitCommand(command)) }).toEqual({ command, blocked: false });
  expect(blockedGitCommand("git stash drop stash@{0}")).toBe("git stash drop stash@{0}");
});

test("another spelling of git or a global option before the subcommand doesn't get past the guard", () => {
  for (const command of ["git -P clean -fdx", "git -p reset --hard", "git -P stash drop", "git --no-pager stash clear", "/usr/bin/git clean -fdx",
    "\\git clean -fdx", "'git' clean -fdx", "\"git\" reset --hard", "git --git-dir .git --work-tree . clean -fd", "nice git clean -fdx",
    "nohup git stash drop", "echo hi & git clean -fdx", "git.exe clean -fd", "C:/Program\\ Files/Git/bin/git.exe stash clear"]) {
    expect({ command, blocked: Boolean(blockedGitCommand(command)) }).toEqual({ command, blocked: true });
  }
  for (const command of ["git -P status", "git -p log", "/usr/bin/git status", "git --no-pager diff", "echo git -P clean", "digit clean"]) {
    expect({ command, blocked: Boolean(blockedGitCommand(command)) }).toEqual({ command, blocked: false });
  }
});
