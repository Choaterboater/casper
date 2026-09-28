import { expect, test } from "bun:test";
import { blockedGitCommand } from "../src/runtime/git-guard";

test("git commands that set aside or discard uncommitted work are blocked; reading and committing are not", () => {
  for (const command of [
    "git stash", "git stash push -m tmp", "cd x && git stash -u", "git -C /repo reset --hard HEAD", "git checkout -- src/a.py",
    "git checkout .", "git checkout -f main", "git restore src/a.py", "git restore --staged --worktree a", "git switch -f main",
    "git clean -fd", "pytest; git stash pop",
  ]) expect({ command, blocked: Boolean(blockedGitCommand(command)) }).toEqual({ command, blocked: true });
  for (const command of [
    "git status", "git diff", "git log --oneline", "git stash list", "git stash show -p", "git add -A", "git commit -m x",
    "git checkout -b feature", "git restore --staged a.py", "git clean -n", "git reset HEAD a.py", "echo git stash is bad",
    "pytest -q",
  ]) expect({ command, blocked: Boolean(blockedGitCommand(command)) }).toEqual({ command, blocked: false });
  expect(blockedGitCommand("git stash push -m tmp")).toBe("git stash push -m tmp");
});
