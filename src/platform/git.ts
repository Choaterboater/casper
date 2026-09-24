import os from "node:os";

/**
 * Arguments for every Casper git invocation. Repository config can name commands
 * that git runs implicitly (core.fsmonitor on status/diff, hooks on checkout and
 * worktree operations); a cloned or shared `.git/config` must not execute through
 * Casper's own read-only queries or workspace plumbing.
 */
export function safeGitArgs(args: string[]): string[] {
  return ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`, ...args];
}
