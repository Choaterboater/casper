# Casper Handoff — Phase 3 Complete

Repository: `/Users/stephenchoate/Documents/Casper`

## Read first

- `docs/CASPER_COMPLETE_PLAN.md`
- `docs/IMPLEMENTATION_PLAN.md`
- `docs/PHASE3_REVIEW.md`
- `docs/PHASE3_VERIFICATION.md`
- `README.md`

## Completed checkpoints

- Phase 0: `1dcfb26` — runtime shell.
- Phase 1: `e9f1f87` — project/profile context.
- Phase 2: `c8603ce` — skill discovery, selection, and trust.
- Phase 3: **`9bad614866353c7bd83339e9aea14f66582b9dcd`** — verification and bounded repair.

This handoff is a documentation-only follow-up to the Phase 3 code commit. No push was performed. Begin by checking `git status --short` and running `bun run check`; do not assume the working tree has remained unchanged since handoff.

## Phase 3 behavior

- `src/verify/` owns the verifier registry, project-native typecheck/lint/test/build adapters, bounded evidence, and repair loop.
- Project `verify:` commands override model/detected commands. Missing checks are skips, never passes; configured commands that cannot execute fail visibly.
- `/verify [checks ...]` runs locally without starting Pi.
- `/verify repair [checks ...]` starts Pi only on failure and permits bounded model-assisted edits.
- Leading CLI `--verify` opts a task/session into post-task verification and repair. Ordinary prompts do not automatically invoke Casper's verifier without this opt-in; Pi retains its normal tools.
- `repair.maxAttempts` defaults to 3, range 0–10. `verification.timeoutMs` defaults to 120000 per command, maximum 3600000.
- Failed checks rerun first; after they pass, the full selected suite runs again.
- `CasperApp.runOnce()` returns a structured verification report for verification runs. One-shot exits: 0 pass, 1 fail/blocked, 2 incomplete/skips.
- Evidence captures command/cwd, stdout/stderr, exit code/signal, reason, duration, and truncation; each stream retains 8 KiB of original bytes plus a truncation marker.
- SDK knowledge remains isolated to the existing runtime adapter. Runtime interfaces, adapter files, and dependency pins were unchanged in Phase 3.

## Review/debug/verification evidence

- Independent standards/spec reviews ran in parallel, including all originally untracked Phase 3 files.
- Both independent follow-up reviews: **no blocking findings**.
- Review fixes: explicit repair no longer inherits unrelated earlier requests; CLI termination has a one-second cleanup deadline even when runtime startup stalls; config validation shares canonical check names.
- Targeted debugging also fixed post-shutdown verifier launches, disposal being skipped on abort rejection, and intact UTF-8 corruption at the output-capture boundary. Each defect was reproduced with a failing regression before its fix.
- Final `bun run check`: **41 tests / 225 assertions**, no failures; TypeScript passed.
- Three repeated Phase 3 suite runs: **22 tests / 109 assertions** each, all passed.
- `git diff --cached --check`: passed before commit.
- Live post-review CLI/Pi smoke: actual Bun test failure (`Expected: 5`, `Received: -1`) → exact evidence sent to Pi → only `sum.ts` changed from subtraction to addition → Casper's targeted/full selected-suite reruns passed → CLI exit 0. Tests/config/rules unchanged. Independent final `bun test`: 1 test / 2 assertions passed. Temporary auth copy removed.
- Startup comparison: median `/project` 379 ms at Phase 2 vs. 376 ms at Phase 3; no clear regression, not a claimed speedup.
- Output stress: 256 MiB emitted, 8,218 characters retained, 46 MiB verifier peak RSS in the measured run. No speculative performance refactoring was applied.

## Known limitations

- Skill/task ranking is lexical. Skill frontmatter and command/config detection require restart to refresh.
- Blocking a skill stops future injection, not its existing conversation history. Trust covers `SKILL.md`, not referenced assets.
- Verifier execution consent is not sandboxing or persisted repository trust. Runtime tools remain unsandboxed; policy and repair constraints are prompt guidance.
- Selected command strings are frozen during repair, but the model can still modify the scripts/tests they invoke. Casper does not enforce test immutability.
- Missing selected checks make a report incomplete. Passing selected checks does not prove unselected checks passed.
- Output is bounded; discarded middle sections are not persisted in a raw-log artifact. Failure evidence can contain secrets and may persist in the runtime conversation.
- Git changed-file context is best-effort and may include pre-existing user changes.
- POSIX process-group cleanup is tested. Windows direct-process fallback is not validated; escaped/daemonized processes are outside the cleanup guarantee.
- CLI SIGINT/SIGTERM has a forced-exit deadline. Programmatic `app.close()` and model startup/work have no separate runtime deadline.

## Next: Phase 4 — MCP capability broker

**Phase 4 is not started.** First verify repository status and run `bun run check`, then update the implementation plan before writing code.

Use the Phase 4 scope in the complete plan: MCP connection/config support, normalized tool metadata, capability registry/search, selective exposure and discovery fallback, bounded results, safety classification, and `/mcp` status. Study the referenced OMP/GreenCLI lifecycle and HPE routing patterns as available, without making their repositories required dependencies. Plan concrete fixture/live acceptance coverage before implementing.

Keep Pi behind the runtime boundary. No Pika, OMP runtime dependency, LSP, visualization, sessions/worktrees, subagents, memory, or other later-phase features. Do not assume this handoff authorizes external network/device writes or access to production MCP servers.
