# Phase 8 — Bounded Subagents

Status: implemented and independently reviewed after resuming the interrupted session and replacing the provisional safety/lifecycle design. **Reported runtime findings resolved; see `docs/PHASE8_REVIEW.md`.** Phase 6/7 reviews are recorded separately; the broader-plan interactive MindMesh gap remains open. Nothing committed or pushed in the Casper repository.

## Contract and scope

`docs/CASPER_COMPLETE_PLAN.md` §25 and Phase 8 call for only `explorer` and `reviewer`, with explorer read-only by default. Both shipped roles are read-only. No writing agent, swarm, recursive delegation, memory, or new worktree orchestration was added.

- **Explorer:** locate relevant files/code relationships and return evidence with file/line references and unknowns.
- **Reviewer:** identify actionable defects in a specified scope or plan, ordered by severity, with evidence and coverage limits. A report is advisory, not test/verification evidence or independent phase sign-off.

## Use

```text
/delegate explorer Find the authentication entry points and their callers
/delegate reviewer Inspect src/sessions/manager.ts for approval-race risks
```

These commands run a child without starting the primary model session. They print the report; failed, cancelled, timed-out, or limit-exhausted commands fail (CLI exit 1). Ordinary parent prompts expose one `delegate` tool:

```json
{
  "role": "explorer",
  "goal": "Find the complete authentication flow; return relevant files and evidence",
  "context": "Focus on browser login, not service-token authentication."
}
```

Only `role`, `goal`, and optional `context` are accepted. No model-supplied setting can grant write access or raise a limit. A child receives a fresh conversation, its exact goal, explicit optional context, and current Casper project/profile rules. It does not inherit the parent transcript or selected skill bodies. Tool-invoked reports return to the parent; a direct command report is displayed locally, not automatically injected into a separate parent conversation.

Children use the active workspace, including a Phase 7 experimental worktree. Read-only children do not create worktrees or require a clean Git tree; they inspect current disk state, including uncommitted work. Workspace-changing commands are refused while child work or late cleanup is active. `workspace.isolateWhen.parallelAgents` is not used to authorize writing: there are no writing children in this phase.

A reviewer has no Git/shell tool. Supply a baseline/diff or concrete review scope in the goal/context when needed; it must not invent one. It cannot execute checks. Concurrent human/parent changes can make evidence stale; this is not an immutable repository snapshot.

## Enforced bounds

| Resource | Limit |
| --- | --- |
| Concurrent children, including pending startup/cleanup | 2 per app manager |
| Delegations from one prepared parent prompt/tool instance | 4 attempts after argument validation |
| Wall-clock deadline, including startup | 180 seconds |
| Model turns | 12 |
| Executed valid tool calls | 48 (excess calls blocked before execution) |
| Goal / optional context | 4 KiB / 8 KiB UTF-8 |
| Project context | 32 KiB UTF-8, fail closed if larger |
| Retained final-response text | 12 KiB, Unicode-safe prefix |
| Aggregate streamed assistant text | 128 KiB, then abort |
| Model-facing result envelope | 16 KiB / 50 items via existing capability bounding |
| Cancellation/shutdown cleanup grace | 1 second |

Limits live in `SUBAGENT_LIMITS`. Embedders/tests can tighten the wall deadline and cleanup grace; project files and model arguments cannot relax them. A new explicit parent prompt (including a verification repair prompt) gets a fresh dispatch budget. Direct user commands each authorize one child. Counts and wall time are bounded, **not a provider-token or dollar spending cap**.

The collector retains only the current/final assistant response, not an unbounded event log or all exploratory narration. Tool names/errors are also bounded. Truncation, model errors, token-length stops, exhausted budgets, empty reports, and cleanup failures are disclosed. `completed` means a report finished, not that its conclusions are correct. Terminal controls/bidirectional controls in direct reports are escaped; display escaping can expand the bounded raw text.

## Implementation

- `src/agents/manager.ts` owns concurrency, task dispatch limits, child ownership, cancellation/deadlines, bounded collection/results, and teardown. One app-owned manager is shared by direct commands and the parent tool.
- `src/runtime/types.ts` has an explicit optional `AgentRuntime.startReadOnly(...)` capability. A runtime without it fails closed; passing a new optional hint to unrestricted `start()` is insufficient. Child factories must return fresh, independently owned instances. Reusing a child instance or the current primary runtime is refused without disposing its owner.
- `src/runtime/pi.ts` implements that capability with the pinned Pi SDK: exact `read`/`grep`/`find`/`ls` tool selection at session construction, in-memory session/settings, and no ambient extensions, packages from settings, skills, templates, themes, context files, or system-prompt files. Only Casper's internal extension factory is loaded. Tool replacement, session forking, and switching are refused for children.
- Pi's tool preflight enforces the call limit; `agent.shouldStopAfterTurn` stops continued tool loops at the turn limit. Auto-retry and compaction are disabled for children. Provider errors and terminal stop reasons cross the runtime seam instead of becoming a false successful/empty report.
- Child model/provider/thinking defaults come from **global Pi settings**, with credentials/custom model definitions supplied by Pi's model runtime. Project Pi model overrides and extension-provided models do not carry into children. No credentials or model preferences were edited during implementation.
- `src/app.ts` aborts the shared child manager during close and refuses workspace switches while it is busy. Primary tool replacement retains the existing fail-closed `setTools` requirement; matching tool names alone are not proof that callbacks, schemas, or permissions are unchanged.

Design references: the installed OMP binary exposes concurrency and per-subagent wall-clock settings; Pi's SDK documentation and subagent example demonstrate isolated contexts, bounded fan-out, abort propagation, and explicit model-error handling. Casper uses those narrow ideas, not OMP code/dependencies, custom agent-definition discovery, chains, or worker roles. All Pi imports remain inside the runtime adapter.

## Read-only is not a sandbox

The child model has no shell, write/edit, MCP, LSP, visualization, or delegate tool, and ambient executable extensions cannot override its readers. This restricts **model tool authority**, not operating-system permissions. Native readers may access paths outside the workspace, host read-tool executables and global provider/auth configuration remain trusted, and authentication may perform provider-owned I/O. Do not use this as a hostile-code or secret-isolation sandbox.

Cancellation is abort-aware, not process killing. An uncooperative injected runtime or stalled filesystem/SDK operation can outlive the caller deadline. Casper reports pending cleanup, stops waiting after the grace period, retains that capacity slot until actual disposal drains, and prevents late startup from launching a prompt. The app's existing CLI shutdown deadline remains the final process-exit safeguard. No claim of a hard OS resource/token sandbox is made.

## Resume/hardening findings

The provisional slice's three fake-runtime tests passed but did not establish its safety claims. The resumed pass:

1. Reproduced pre-aborted calls still creating a runtime and ignored `readOnly: false`/unknown tool arguments as failing regressions, then fixed both.
2. Replaced active-tool-only narrowing with explicit enforced read-only startup; disabled ambient executable resources and child persistence.
3. Added run/concurrency/dispatch limits, app shutdown ownership, late-start prevention, and shared close behavior.
4. Replaced unbounded event accumulation with incremental Unicode-safe final-response capture; preserved surrogate-split deltas and honest prefix truncation.
5. Stopped treating provider errors, empty output, cut-off replies, or runtime cleanup errors as successful reports.
6. Removed the provisional same-tool-name compatibility shortcut; primary test adapters now implement the actual dynamic-tool contract.
7. Added real Pi/local-model-protocol acceptance, rather than relying only on options captured by a fake.

## Validation

`tests/phase8-subagents.test.ts` covers arguments and fail-closed capability checks, local commands, parent tool exposure, per-task/concurrency budgets, cancellation before/during startup, active timeout/shutdown, no late output, workspace-switch refusal, duplicate runtime ownership, Unicode/terminal safety, output bounds, and error/empty/cleanup status.

`tests/phase8-pi.integration.test.ts` and `tests/fixtures/pi-readonly.ts` exercise the actual pinned Pi adapter in isolated subprocesses against a **local deterministic model-protocol fixture**:

- read real file evidence; attempted `write`, `bash`, and recursive `delegate` calls fail;
- ambient global/project extensions, reader override, prompt files, and project model overrides do not take effect;
- primary Pi delegates a reviewer and receives the report without sharing its private transcript;
- exact tool surfaces, turn/call budgets, and streaming cancellation;
- provider failure produces CLI exit 1, not a successful report;
- reviewed branch creation → delegate in the real Git worktree → reviewed discard → delegate in main, with fresh project context and no leftover worktree;
- unchanged workspace bytes and no child JSONL sessions.

Full validation: **`bun run check`: 172 tests / 1020 assertions, TypeScript passed.** Three additional complete Phase 8 runs each passed **24 tests / 155 assertions**. `git diff --check` passed. No external live-model request or personal/production service was used. Temporary Git fixture commits are only test setup; Casper's own work remains uncommitted and unpushed.

## Remaining gates

1. Independent Phase 8 review completed with runtime findings resolved; Phase 9 needs its own review.
2. Phase 6/7 review reports are separate; interactive MindMesh remains an outstanding broader-plan gap.
3. Optional live-model usability smoke, if requested; deterministic provider fixtures are not live-model quality evidence.
4. Commit only if requested. Phase 9's explicit facts/outcomes slice has started.
