# Phase 9 — Memory / Reference Learning (started)

**Status: explicit facts/outcomes, local reference search and learning candidate generation implemented and locally validated; Phase 9 is NOT complete and has not had its independent review.** The initial facts/outcomes slice followed the Phases 6–8 review. The user later approved local reference search, checkpointed at `c8df223`, then approved candidate-only learning. Human promotion remains pending. The broader-plan interactive MindMesh gap remains separately disclosed.

## Original scope

`docs/CASPER_COMPLETE_PLAN.md` Phase 9 and §§28–31 call for:

| Item | Current status |
| --- | --- |
| Explicit project facts | Implemented in this slice |
| Task outcomes | Implemented in this slice |
| Reference-project search | Implemented for explicitly configured local paths; remote retrieval unsupported |
| `casper learn <repo>` | Implemented: local, bounded read-only candidate generation; no promotion |
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

All readable, valid active facts are included as a bounded guidance block in normal parent task prompts. If the facts read or context-budget validation fails, the task warns and proceeds without the entire facts block; there is no partial-fact fallback, stale in-memory reuse, reset or automatic repair. The warning does not echo raw filesystem errors or fact contents. Explicit `/memory` operations retain fail-closed behavior. Facts are reread on each task, so manual repairs take effect on the next prompt. Current repository evidence, current rules, user requests, and safety policy outrank remembered guidance. Facts may become stale; Casper does not claim automatic validation. This does not rewrite the system prompt, project files, global rules, or skills.

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
- Regular files only; final-file symlinks, malformed JSON/schema, invalid UTF-8, duplicate IDs, and oversized state fail closed at the storage boundary rather than resetting state. Normal tasks may continue without facts as described above; explicit memory operations still reject invalid state.
- Read buffers use the observed file size plus one sentinel byte, bounded by 1 MiB + 1. Filling the buffer rejects observed growth rather than parsing a possibly truncated JSONL prefix. Reads remain non-atomic; this is not detection of all concurrent changes.
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

## Learning candidate-generation slice

Implemented after `c8df223` with explicit user approval; currently uncommitted.
The contract and limits are in [LEARNING.md](LEARNING.md).

- `CandidateLibrary` is one module for generation, listing, inspection and close.
  The top-level `casper learn <local-repo>` command invokes one existing bounded
  read-only explorer, never the unrestricted parent app. `learn list` / `learn
  inspect` stay local. No interactive `/learn` or model-facing learning tool was
  added.
- Up to four candidates contain problem/context/pattern, tentative rationale,
  tradeoffs, use/avoid guidance and exact source citations. Casper checks the
  quoted lines after generation and hashes the observed raw bytes; the model
  cannot supply acceptance, promotion, verification or digest fields. Text is
  untrusted even after schema/citation validation.
- Source reads are bounded, non-atomic observations, not a repository snapshot.
  Checked quotes do not establish correct reasoning, a successful outcome, or
  applicability elsewhere. Saved evidence is stricter than the existing native
  read-only tools, which are not a filesystem sandbox or a spending cap.
- Successful nonempty batches persist as owner-only plaintext in the existing
  source-root project-state directory, in `learning-candidates.jsonl`. Atomic
  append-under-lock, schema/digest validation and record/byte caps preserve
  existing drafts. They stay unpromoted, unverified and unaccepted; no active
  facts, outcomes, references, skills or policy are changed. Empty output is not
  proof that the source has no reusable patterns.
- Incomplete/error/truncated output and bad citations reject the entire batch.
  Close/cancellation aborts the child and drains pending host work; the CLI keeps
  its existing shutdown deadline. No new retry/repair loop or model support.
- The initial candidate slice left native bash, the Pi adapter, subagent manager,
  reference search, dependency pins and coding-loop repair owner unchanged. The
  bounded runtime/reference corrections below were subsequently authorized.

### Learning validation

`tests/phase9-learn.test.ts` exercises the public CLI with real files and pinned Pi
0.85.1 against scripted localhost model responses. Before the review corrections
below, it passed **32 tests / 202 assertions**. The initial generation/list/inspect tracer was red before the
implementation; a terminal-control tracer exposed C1 output that was then escaped.

Coverage includes host-computed file/batch digests, source changes, Unicode/CRLF,
local inspection without credentials and after source removal, invalid commands,
malformed/oversized/cut-off responses, forged model statuses/digests, mixed-batch
rejection, traversal/symlink/FIFO/binary/oversized evidence, inert storage, ambient
extension/config isolation, concurrency, corrupt/full stores, denied tools,
existing explorer turn limits, provider failure and CLI cancellation. A test's
initial whole-home write assumption was corrected after observing existing Pi
auth/model bookkeeping and Bun caches. Those fixtures kept Pi state outside the
source: no child transcript, source mutation or active-guidance change was
observed there. The later review reproduced an uncovered source/state overlap,
corrected below. Runtime bookkeeping is not zero filesystem effects.

`bun run check` passed twice: TypeScript clean; **345 tests / 2,212 assertions**,
0 failures. Final test-runner time: 112.95 s (earlier 114.26 s).
`git diff --check` passed. Final gate log:
`/tmp/casper-phase9-learn-bb4QFa/final-check.log`; the earlier gate is
`full-check.log` in the same directory.

This is single-agent implementation validation/self-review, not independent
acceptance or a live-model usefulness trial. No paid model calls, production
services, real user source scans, commits or push were performed for this slice.
Windows remains unvalidated.

## Review corrections

A subsequent **same-agent, not independent** Standards/Spec and product-readiness
review covered `5d5773f` through the working tree. It found no hard coding-standard
violations, one advisory about duplicated terminal serialization, and three
reproducible spec defects. Each defect reproduced twice with passing controls.
The user authorized these bounded corrections, not promotion or new features:

1. **P2 — Pi state could mutate the learning source.** With `PI_CODING_AGENT_DIR`
   inside that source, even an empty candidate response created `auth.json` and
   `models-store.json`. `PiRuntime.startReadOnly` now checks its active state
   directory and those file destinations before `ModelRuntime.create`. Canonical
   aliases and missing ordinary suffixes are resolved without creating them;
   overlap/unresolvable state fails closed. Learning surfaces the exact safe
   overlap diagnostic without forwarding arbitrary provider errors. No credential
   relocation, model-default change or restriction on ordinary parent sessions.
2. **P2 — reference search could falsely report complete/no matches.** An excluded
   `a.data` hardlinked to `b.md` consumed their shared inode before eligibility
   filtering. File eligibility now precedes identity deduplication; directory
   cycle protection and eligible-file deduplication remain intact. Regressions
   include lockfiles and overlapping named/recursive paths.
3. **P3 — reference output retained raw C1 terminal controls.** Reference and
   learning output now share `src/tui/json.ts`, preserving parsed values while
   escaping C0, DEL/C1 and bidi controls. Reference byte budgets use that exact
   encoding. CLI/model-output and expanded-byte-budget regressions pass; no shell
   execution claim is implied by the original terminal-control defect.

The runtime check is bounded (4 KiB paths, at most 128 ancestor probes per known
state destination), cooperative and non-atomic. It is not a filesystem sandbox,
whole-filesystem hardlink audit or protection against concurrent alias replacement
or every possible cache location. Existing source/evidence limitations remain.

### Correction validation

- Public-interface regressions failed before each correction: missing eligible
  hardlinks, actual raw C1 CLI output, and new auth/model files in the source.
- Focused reference/learning suites: **62 tests / 390 assertions**, passing.
  The learning suite now contains **39 tests / 236 assertions**. Two additional
  pinned-Pi controls prove read-only startup refusal and unchanged ordinary-parent
  startup with overlapping state. Four original reference-review probes pass
  unchanged; the learning overlap now correctly refuses rather than completing.
- `bun run check` passed twice: TypeScript clean, **358 tests / 2,277 assertions**,
  0 failures, 120.81 s and 119.77 s. `git diff --check` passed.
- Evidence: `/tmp/casper-phase9-fixes-7vYGb7/` contains `hardlink-red.log`,
  `terminal-red.log`, `overlap-red.log`, focused/control runs, `full-check.log`
  and `final-check.log`. Original review:
  `/tmp/casper-phase9-review-GkUdkF/REVIEW.md`. Permanent tests do not depend on
  these temporary paths surviving.
- An earlier review gate had one existing auth-preflight cancellation timeout.
  Its cause remains unresolved, despite five isolated review passes and a passing
  review repeat gate. An isolated correction run and both correction gates also
  pass that test. No timeout, cancellation budget or assertion was weakened.

No live/paid model calls, promotion, commits or push. This closes the three
reproduced defects within the stated limits; it is **not independent Phase 9
acceptance or evidence of representative usefulness**.

## Next decision — features paused

Keep the foundation. Agree a representative real-project task, baseline and
acceptance criteria, plus separate authorization for any live-model budget.
Independent Standards/Spec review is still required and cannot be replaced by
this same-agent review. Keep promotion and Phase 10 paused until the next scope
is agreed; the toy coding demo and backburner research remain parked.

Digest-bound human promotion (reference only, project/global skill, ignore)
remains unimplemented, never automatic global policy mutation. Candidate
corrections are not approval for promotion, remote retrieval, recovery/model
expansion, new integrations, further commits or push.
