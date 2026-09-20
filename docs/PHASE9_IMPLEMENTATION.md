# Phase 9 — Memory / Reference Learning (started)

**Status: explicit facts/outcomes and local reference search implemented and locally validated; Phase 9 is NOT complete and has not had its independent review.** The initial facts/outcomes slice followed the Phases 6–8 review. The user later approved resuming Phase 9 with read-only local reference search after closing the coding-loop evidence correction. The broader-plan interactive MindMesh gap remains separately disclosed.

## Original scope

`docs/CASPER_COMPLETE_PLAN.md` Phase 9 and §§28–31 call for:

| Item | Current status |
| --- | --- |
| Explicit project facts | Implemented in this slice |
| Task outcomes | Implemented in this slice |
| Reference-project search | Implemented for explicitly configured local paths; remote retrieval unsupported |
| `casper learn <repo>` | Pending — not a command implemented by this slice |
| Human candidate promotion into references/skills | Pending |

No autonomous prompt rewriting, global policy changes, embeddings/database, remote reference fetching, automatic corpus discovery, or implicit skill promotion was added. Reference content is searched only on demand within user-configured local paths.

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

## Local reference search slice

Implemented after correction checkpoint `5d5773f` and checkpointed by user request.
Usage, configuration and precise limits are in [REFERENCES.md](REFERENCES.md).

- `src/references/config.ts` discovers user/profile metadata only. Sources require
  an explicit local root and relative search paths. Project files cannot define
  new external roots; invalid entries are diagnostic and missing repositories
  remain optional. No user sources were installed by this implementation.
- `ReferenceLibrary` is the shared read-only module for `/references`,
  `/references search <id|*> <query>` and the conditional `search_references` tool.
  Search returns matching-line excerpts with config/root/file/line/digest
  provenance, read counts, partial-result qualifications and current-repo authority.
- Source text is read per query, not injected at startup or added to memory/skills.
  No shell, Git, project code, remote fetch, new dependency, index or background
  watcher is involved. Native bash, the Pi adapter and verifier/repair owner are
  unchanged. This adds no model-spending or task-attempt policy.
- Search rejects path/command overrides, skips internal symlinks/special files,
  bounds reads/results, and reports missing/unsupported inputs without inventing
  complete coverage. Shutdown drains searches and workspace rebinding revokes old
  tools. The documented filesystem observations are non-atomic, not sandboxing.

### Search validation

The module tracer initially failed before the module existed. The local-command
tracer then failed because `/references` incorrectly started the runtime; it is
now genuinely local. Further red tests exposed rejected-text byte accounting and
Unicode lowercasing moving excerpt offsets; both were corrected before the gate.

- New suites: **19 tests / 131 assertions**, all passing. They exercise configuration
  precedence/disables, rejected overrides, literal queries, scope/provenance,
  fresh content reads, partial results, Unicode, result/read budgets, FIFO refusal,
  cancellation, shutdown, workspace rebinding, absent sources and unchanged facts/
  outcome semantics.
- Real CLI local search works without model configuration or credentials.
- Pinned Pi 0.85.1 with a **scripted localhost provider** calls the real reference
  tool and receives only the requested excerpt, provenance and authority guidance.
  This is not a live-model usefulness test or independent acceptance.
- `bun run check`: TypeScript clean; **313 tests / 2,010 assertions**, 0 failures,
  89.69 s test-runner time. `git diff --check` passed. Saved local gate log:
  `/tmp/casper-phase9-references-WAc4aT/full-check.log`; permanent tests do not rely
  on it surviving.

The user subsequently requested a checkpoint commit. Its fresh `bun run check`
passed with TypeScript clean and **313 tests / 2,010 assertions**, 0 failures,
90.72 s test-runner time; log: `/tmp/casper-references-checkpoint-ifOLmu/full-check.log`.
`git diff --check` also passed.

These are single-agent implementation/checkpoint validations, not independent
acceptance. No paid model calls, production services, real user reference scans
or push were performed.

## Next Phase 9 work

1. `casper learn <repo>` candidate generation that does not execute project code or activate extracted guidance.
2. Digest-bound human review/promotion (reference only, project/global skill, ignore), never automatic global policy mutation.
3. Phase 9 independent Standards/Spec review after the complete scope is implemented.

Agree each remaining slice before implementing it. Local search is not approval
for learning/promotion, remote retrieval, recovery/model expansion or Phase 10.
