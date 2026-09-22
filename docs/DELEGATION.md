# Read-only explorer and reviewer agents

```text
/delegate explorer Find the authentication entry points and their callers
/delegate reviewer Inspect src/sessions/manager.ts for approval-race risks
```

The primary model can also call `delegate` with a self-contained `role`, `goal`, and optional `context`. Both roles use fresh, read-only Pi sessions with only `read`, `grep`, `find`, and `ls`; no shell, writes, external capabilities, ambient extensions, or recursion. Children inspect the active workspace (including uncommitted work) without creating worktrees. Workspace switches wait for child work to finish.

Limits: 2 concurrent children, 4 delegations per prepared parent prompt, 180 seconds / 12 model turns / 48 tool calls per child. Results are bounded and explicitly report failures, limits, and truncation. Explorers use Casper's optional `fast` model role; reviewers use `review`. Unset roles use the saved Casper startup default, not the parent's temporary model or shared/project Pi defaults. A configured but invalid/unavailable role fails rather than silently selecting another provider. Role effort suffixes and per-model automatic effort apply without changing global preferences or persisting a child transcript. Read-only tool authority is **not an OS sandbox or spending cap**; reports are not verification evidence.
