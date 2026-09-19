# Named Sessions and Worktree Experiments

Casper keeps conversation branching and workspace isolation related but separate:

- **Pi owns conversations.** Casper uses Pi SDK 0.85.1 `SessionManager` and `AgentSessionRuntime` to clone/resume Pi JSONL sessions. Casper does not duplicate the message tree or invent another conversation database.
- **Casper owns names and workspace relations.** A small manifest under `~/.casper/sessions/<project-key>.json` maps a branch name to its Pi session file and, when applicable, a managed Git worktree.
- **Git owns candidate content.** Experimental branches use `casper/<session-name>` in a worktree under `~/.casper/worktrees/<project-key>/`.

## Commands

Interactive commands:

```text
/tree
/branch <name>
/switch <branch>
/switch main apply
/switch main discard
```

`/tree` is local and does not start Pi. Branch names contain 1–64 letters, digits, dots, underscores, or hyphens; `main` is reserved.

`/branch <name>` clones the active Pi conversation, records the current task/project context, and—when policy enables it and the project is Git-backed—creates a clean worktree from the primary workspace's current commit. Creation requires an exact `yes` after Casper shows the session, branch, commit, and path. It fails closed in one-shot mode.

`/switch <branch>` resumes the associated Pi session and changes the runtime cwd. Switching also requires exact interactive approval. Casper revokes old MCP/LSP connections and tools before moving the runtime, rediscovers project context for the target workspace, and requires fresh connection consent. A failed rebind blocks subsequent commands until the destination configuration can be loaded. On restart, saved named-session history is resumed before any outgoing manifest link is updated; shared-workspace startup selects main.

An isolated branch cannot use plain `/switch main`; choose a reviewed outcome:

- `apply`: run configured checks in the candidate, capture the resulting complete diff, show its files/stat/content/SHA-256, require exact approval, apply that exact patch to main **without committing**, and clean up the worktree/branch.
- `discard`: capture and show the complete diff, require exact approval, then remove the worktree/branch without applying it.

If verification fails or is blocked, apply stops before approval. Missing checks remain visibly `incomplete` and require the subsequent explicit apply approval. Changes detected during post-approval revalidation keep the candidate open.

Cleanup now **unregisters** the Git worktree/branch while retaining candidate bytes by atomic rename under `~/.casper/worktrees/recovery/<project-key>/`. The recovery path is printed and recorded in `/tree`. These are ordinary recovery directories, not resumable Git worktrees; their `.git` pointer is no longer usable. This also preserves files written after the final snapshot (including ignored files and writes through already-open handles). No automatic recovery-directory deletion is provided; review and remove them manually when no longer needed. Discard means “do not apply,” not secure erasure.

## Policy

Defaults:

```yaml
workspace:
  isolateWhen:
    parallelAgents: true
    riskyRefactor: true
    experimentalBranch: true
```

The settings use normal safe-default → global → profile → project precedence. Phase 7 consumes `experimentalBranch`; the other two settings establish policy for later bounded-agent/risky-refactor orchestration. Setting `experimentalBranch: false` keeps named Pi branches but shares the main workspace.

Worktrees are not created for ordinary edits. They are created only for an explicitly requested experimental session branch when policy says to isolate it.

## Safety and limits

- Source worktree must be clean at planning **and** creation time; its commit may not change during approval. Same-name creation is serialized; failed contenders cannot remove the winner's worktree.
- Worktree paths and `casper/*` branches must match Casper's managed relation. Repository identity, registration, base commit, main cleanliness, and candidate identity are rechecked before consequential operations.
- Candidate capture includes tracked, deleted, executable-mode, binary, and untracked files through a temporary Git index. The repository index is not modified. Ignored candidate files cannot be represented by the exact patch, so automatic return refuses and preserves the worktree until they are manually preserved or removed. Existing ignored files in main do not invalidate applied-diff comparison and are left untouched.
- Reviewed return patches are limited to 512 KiB and 200 changed files. Larger candidates remain intact for manual review/application. Terminal control/bidirectional characters are escaped in the preview; the displayed SHA-256 identifies the original patch bytes.
- Candidate and applied-main SHA-256 identities must match. Candidate changes during approval prevent removal.
- Apply never commits or pushes. Existing `git.commit`/`git.push` remain `neverUnlessRequested`; `git.confirmDestructive` remains mandatory.
- A dirty/advanced main workspace prevents apply; both workspaces are preserved for manual recovery.
- Branch/switch/worktree consent is process-local. Project files cannot answer approval prompts.
- Pi's native shell/filesystem tools are not sandboxed. Worktrees isolate file state; they are not a security boundary.

State files are mode `0600` and atomically replaced. A malformed manifest fails closed rather than being silently reset.
