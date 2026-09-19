# Phase 9 — Memory / Reference Learning (started)

**Status: first slice implemented and locally validated; Phase 9 is NOT complete and has not had its independent review.** The user authorized moving to the next phase after reviewing Phases 6–8. Their runtime review findings were resolved before this slice; the broader-plan interactive MindMesh gap remains separately disclosed.

## Original scope

`docs/CASPER_COMPLETE_PLAN.md` Phase 9 and §§28–31 call for:

| Item | Current status |
| --- | --- |
| Explicit project facts | Implemented in this slice |
| Task outcomes | Implemented in this slice |
| Reference-project search | Pending |
| `casper learn <repo>` | Pending — not a command implemented by this slice |
| Human candidate promotion into references/skills | Pending |

No autonomous prompt rewriting, global policy changes, embeddings/database, external reference fetching, repository corpus scanning, or implicit skill promotion was added.

## Commands

```text
/memory
/memory remember API calls belong in services/
/memory forget <fact-id>
/memory outcomes
/memory accept <outcome-id> yes
/memory accept <outcome-id> no
```

These are explicit local user commands, not model-facing tools. They work without starting Pi. `remember` records exactly the entered fact; duplicate normalized text is idempotent. `forget` removes it. `accept` records human acceptance only, **not** a verification pass or permission change. Acceptance starts as `null` and is never inferred from model completion or passing tests.

The last 20 outcomes are shown, newest first, with task previews. The full bounded records remain inspectable on disk. Fact changes take effect on the next normal parent prompt. Child delegation does not automatically inherit these new facts in this first slice; supply relevant context explicitly.

## Storage and context

Files use the existing workspace-specific project cache identity:

```text
~/.casper/projects/<project-name>-<root-hash>/
  project.json        # existing deterministic project model
  memory.jsonl        # active, human-entered facts
  outcomes.jsonl      # task summaries and evidence statuses
```

`ProjectMemory` is the new module; `projectStateDirectory` centralizes the existing cache path instead of introducing a second identity scheme. State is keyed by the inspected workspace root. Experimental worktrees have separate state; facts are not silently merged/promoted when a worktree is applied or discarded.

All active facts are included as a bounded guidance block in normal parent task prompts. Current repository evidence, current rules, user requests, and safety policy outrank remembered guidance. Facts may become stale; Casper does not claim automatic validation. This does not rewrite the system prompt, project files, global rules, or skills.

## Honest outcomes

After a normal model task settles, Casper records:

- original task text (up to 4 KiB; oversized tasks are not silently truncated into misleading records);
- selected skill IDs;
- model status (`completed`, `failed`, or `cancelled`);
- verification status (`pass`, `fail`, `incomplete`, `blocked`, or **`not-run`**);
- selected check names and `pass`/`fail`/`skip` statuses;
- repair-attempt count;
- human acceptance, initially **`null`**.

Model completion is not verification. Missing/skipped checks stay missing/skipped. Raw model answers, tool outputs, command stdout/stderr, and credentials are not copied into outcomes. Task text and explicit facts can themselves contain sensitive data: storage is owner-only plaintext, not encrypted. Startup discloses local task-summary recording.

Local administrative commands and direct `/delegate` are not normal parent tasks and do not create automatic outcomes in this slice. Shutdown does not start a late persistence operation; a task interrupted by shutdown may have no outcome. Failure to record an outcome emits a warning without relabeling the task successful or verified.

## Bounds and persistence

- Each fact: 1 KiB UTF-8; at most 64 facts and 8 KiB for their serialized prompt values. All admitted facts fit; none are silently dropped to fit a prompt.
- Each JSONL file: at most 1 MiB / 1000 records. Full stores refuse new records; no automatic pruning/retention policy was invented.
- Regular files only; final-file symlinks, malformed JSON/schema, invalid UTF-8, duplicate IDs, and oversized state fail closed rather than resetting state.
- Changes use a bounded per-file directory lock, reload-under-lock, exclusive temporary files, and atomic rename. Files are mode `0600`. Interrupted locks are not silently stolen; preserve/inspect state before manual repair.
- Directory locations are Casper's user-owned project state, not model- or project-config-controlled arguments. Like existing Pi/Casper state, this is not protection against another process with the same user's filesystem privileges.

## Validation

`tests/phase9-memory.test.ts` covers persistence, permissions, idempotence, workspace isolation, concurrent writers, fact budgets, malformed/duplicate/oversized/symlink refusal, unverified/skip evidence, explicit human acceptance, lazy local commands, prompt injection/removal of facts, and truthful model-failure outcomes.

`bun run check`: **199 tests / 1157 assertions**, TypeScript passed. Three additional Phase 9 runs each passed **5 tests / 34 assertions**; `git diff --check` passed. No commits or pushes. No external references, production services, or live-model feature tests were used for this slice.

## Additional pre-next-phase review

The user requested another debug/review pass and a checkpoint commit. `docs/REVIEW_CHECKPOINT.md` records this **single-agent** review (not the still-pending independent full Phase 9 gate). Reproduced and fixed memory FIFO hangs and schema coercion/unknown nested evidence acceptance; rejected state stays untouched. The Phase 9 suite now passes **7 tests / 49 assertions**. Final full checks passed three times: **204 tests / 1,186 assertions**, TypeScript passed. No Phase 9 scope expansion or push.

## Next Phase 9 work

1. Explicitly configured/local reference sources and bounded search, with source provenance and current-repo authority.
2. `casper learn <repo>` candidate generation that does not execute project code or activate extracted guidance.
3. Digest-bound human review/promotion (reference only, project/global skill, ignore), never automatic global policy mutation.
4. Phase 9 independent Standards/Spec review after the complete scope is implemented.
