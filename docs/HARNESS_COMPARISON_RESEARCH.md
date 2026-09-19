# Harness and product comparison for Casper

Research snapshot: 2026-09-19. Design input, not an implementation decision.

## Scope and confidence

Primary-source inspection of Pi, OMP, DeepSeek Harness, Hermes, TypeSafe's Jev, and Omarchy. No installations, credential access, paid inference, or comparative task benchmarks. Single-agent research, not independent review. Findings describe the inspected mechanisms, not proof that any product completes real tasks better. Absence from this inspection is not proof a feature is absent everywhere in a project.

Pinned sources:

- Pi: installed `@earendil-works/pi-agent-core` and coding-agent **0.85.1**; local distributed source and SDK documentation.
- OMP: installed binary **18.2.6**, source tag `v18.2.6`; main snapshot `71c5eec978b0e7ce9ff057eb4e311f67f4f03eb9`. Todo tracker and auto-thinking classifier compared byte-identical between fetched tag and main snapshots.
- DeepSeek Harness: `ddefc45fbc7f8e46dd73185e68295696d1297887`.
- Hermes: `f0d8efe4e7d3b72cefe630fe8359e24d1e3bd972`.
- Omarchy: default branch `quattro`, commit `60663faf8764253646f1d6166e864b608d4a0fa1`.
- Jev: live official TypeSafe documentation; limitations page specifically concerns `jev-1.13`. Not commit-pinned.

## Executive finding

**Ending a model turn, completing a checklist, passing a command, and satisfying the user's request are different events.** The inspected systems offer useful mechanisms, but none of those mechanisms alone establishes the last condition.

Casper's potential distinction is not another agent loop or more features. It is a coherent coding application that makes progress autonomously, checks relevant behavior, changes strategy when stuck, and reports completion truthfully—with less user supervision. This remains a hypothesis requiring matched real-task trials.

## 1. Pi: extensible execution, not a correctness certificate

The inspected loop executes tools, consumes steering and follow-up messages, and ends when no further work is scheduled (or a stopping condition applies). Its `agent_end` event describes execution lifecycle, not whether requested behavior works. `prepareNextTurn` and stopping hooks offer seams for higher-level policies; the SDK exposes model/thinking control.

Sources: installed `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`; installed coding-agent `docs/sdk.md`; [upstream repository](https://github.com/earendil-works/pi).

**Transfer:** keep the execution substrate reusable while Casper owns acceptance, recovery, and user-facing task state. These are not reasons to rebuild Pi.

## 2. OMP: useful continuation and effort selection

- `TodoTracker.checkCompletion()` can schedule continuation when pending/in-progress todos remain. It is configuration-dependent and bounded; it skips several situations including waiting for the user and pending async wakeups. Marking todos complete is not independent behavioral verification. [Source](https://github.com/can1357/oh-my-pi/blob/v18.2.6/packages/coding-agent/src/session/todo-tracker.ts)
- Automatic thinking classifies prompt difficulty and selects supported effort. This is a concrete automatic effort mechanism, but prompt difficulty selection is not the same as detecting failed repair attempts and escalating based on their evidence. [Source](https://github.com/can1357/oh-my-pi/blob/v18.2.6/packages/coding-agent/src/auto-thinking/classifier.ts)
- The system prompt gives verification instructions; instructions are not a runtime acceptance gate. [Source](https://github.com/can1357/oh-my-pi/blob/v18.2.6/packages/coding-agent/src/prompts/system/system-prompt.md)
- Non-compaction retries address provider/network failures, credential rotation, and fallback routes—not whether a successful inference produced correct code. [Policy](https://github.com/can1357/oh-my-pi/blob/v18.2.6/docs/non-compaction-retry-policy.md)

**Transfer:** supported effort selection, visible task continuity, bounded reminders. Do not relabel transport retry or checklist completion as coding recovery or acceptance.

## 3. DeepSeek Harness: explicit, composable policies

The project describes itself as an everything-is-a-plugin developer preview. [README](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/README.md)

- Its goal service persists an objective, phase, revision, and admitted-round count. Phases are active, paused, blocked, and complete. Compare-and-set mutations reject stale state. Persistence and scheduling are separate; continuation authority is process-local and disarmed on session start. The caller marking completion is authoritative; an independent evaluator is explicitly deferred. [Goal contract](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/goal/goal/README.md)
- Ralph runs fresh child agents against one immutable objective, passing only bounded structured reports plus the shared workspace across rounds. Report schemas are validated, but completion remains worker self-report. It explicitly defers independent evaluation and within-round provider switching; ordinary child failure is terminal. Guidance reserves this tool for explicit human requests, rather than making it the ordinary work loop. [Ralph contract](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/workflow/tool-ralph/README.md), [implementation](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/workflow/tool-ralph/src/index.ts)
- Provider-request retries are recorded durably before waiting; cancellation participates in their lifecycle. Normal retries are bounded; optional always mode is unbounded. Neither means correctness recovery. [Retry contract](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/llm/llm-retry/README.md)

**Transfer:** stable objectives, explicit task states, compact recovery handoffs, and traceable retry events. Do not copy its large plugin architecture or arbitrary round cap merely because it exists. Casper may deliberately choose a different resume policy.

## 4. Hermes: the closest inspected verification mechanism

The architectural documentation describes a tool loop returning text when the model stops, but actual source adds important stop gates. Relying on the high-level documentation alone would understate its behavior. [Loop documentation](https://github.com/NousResearch/hermes-agent/blob/f0d8efe4e7d3b72cefe630fe8359e24d1e3bd972/website/docs/developer-guide/agent-loop.md), [final-response path](https://github.com/NousResearch/hermes-agent/blob/f0d8efe4e7d3b72cefe630fe8359e24d1e3bd972/agent/turn_final_response.py)

- A verification ledger records recognized commands, exit status, output summary, scope, and session/workspace association. Recorded edits invalidate prior evidence by timestamp. Targeted and full evidence are distinguished in the record. This is observed edit tracking, not proof of complete filesystem-change detection. [Ledger](https://github.com/NousResearch/hermes-agent/blob/f0d8efe4e7d3b72cefe630fe8359e24d1e3bd972/agent/verification_evidence.py)
- `verify_on_stop` is **off by default** in the inspected source. When enabled, it can require another turn after recorded code edits without fresh passing evidence. The default maximum is two nudges; it does not itself run checks. Documentation-only edits and unrecognized workspaces can bypass it. A fresh `passed` record satisfies this guard; it does not independently require all acceptance criteria or a full-suite scope. [Guard implementation](https://github.com/NousResearch/hermes-agent/blob/f0d8efe4e7d3b72cefe630fe8359e24d1e3bd972/agent/verification_stop.py)
- A separate `pre_verify` plugin hook can request bounded continuation after edits. [Stop gates](https://github.com/NousResearch/hermes-agent/blob/f0d8efe4e7d3b72cefe630fe8359e24d1e3bd972/agent/turn_stop_gates.py)
- Runtime heuristics catch some replies that announce another action but stop without tools, and some fragmentary final answers; these use bounded continuation. This directly addresses a common supervision burden, though it remains heuristic. [Final-response implementation](https://github.com/NousResearch/hermes-agent/blob/f0d8efe4e7d3b72cefe630fe8359e24d1e3bd972/agent/turn_final_response.py)
- Configured fallback chains handle provider failures; documentation also describes a specific reasoning-only Codex stall fallback. This is more than network retry in that narrow case, but not a general failed-code strategy selector. [Fallbacks](https://github.com/NousResearch/hermes-agent/blob/f0d8efe4e7d3b72cefe630fe8359e24d1e3bd972/website/docs/user-guide/features/fallback-providers.md), [loop documentation](https://github.com/NousResearch/hermes-agent/blob/f0d8efe4e7d3b72cefe630fe8359e24d1e3bd972/website/docs/developer-guide/agent-loop.md)

**Transfer:** fresh verification evidence, invalidation after edits, and detecting premature stopping. Casper should go beyond “some recognized command passed” without pretending any finite test suite proves all correctness.

## 5. Jev: a decision component, not a coding harness

Assumption: “Jev” refers to TypeSafe's model. Its API accepts state plus typed Choice, Score, or Noul questions, rather than being a generative coding loop. [Introduction](https://docs.typesafe.ai/introduction.md)

Choice/Score confidence is derived from the returned probability distribution. It is not an independent probability that a patch is correct. The vendor recommends tuning thresholds on one's own domain. The limitations page documents literal interpretation, numeric weaknesses, irrelevant-context sensitivity, adversarial influence, and nonguaranteed consistency across differently phrased questions. [Confidence](https://docs.typesafe.ai/confidence.md), [limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)

Especially relevant to Casper's later MCP/skill work: TypeSafe's skill-suggestion cookbook ranks a large roster, inspects the top three in more detail, and permits rejecting all candidates. It reports fewer incorrect skill loads in its own 488-request experiment; this was not independently reproduced here and is not an MCP or Casper benchmark. [Cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion.md)

**Transfer:** code owns policy; narrow model judgments supply suggestions. Candidate applications include recovery classification and capability selection. Keep an explicit “none/insufficient evidence” route. Do not add a required vendor dependency or let classifier confidence certify completion. Low confidence should often trigger more inspection, not another user interruption.

## 6. Omarchy: product cohesion without rebuilding components

Omarchy is an operating-system distribution, not an equivalent harness competitor. Its relevance is product design:

- One discoverable menu plus direct hotkeys for frequent operations. The manual acknowledges the learning curve: opinionation can also create friction. [Navigation](https://github.com/omacom/omarchy/blob/60663faf8764253646f1d6166e864b608d4a0fa1/manual/04-navigation.md)
- The CLI exposes the same underlying tooling, grouped commands, per-command help, and a machine-readable command listing. [CLI](https://github.com/omacom/omarchy/blob/60663faf8764253646f1d6166e864b608d4a0fa1/manual/14-omarchy-cli.md)
- Shipped defaults and user-owned overrides are separate, with hooks and menu extension points. Reset/refresh is a supported workflow, not “reinstall and start over.” [Dotfiles](https://github.com/omacom/omarchy/blob/60663faf8764253646f1d6166e864b608d4a0fa1/manual/31-dotfiles.md)
- Config refresh backs up changed user files and shows a diff. Update execution has logging, locking, snapshot attempts, ordered package/migration steps, and an explicit unattended mode. Snapshot failure is warned about, not silently represented as protection. These mechanisms are not a blanket transaction/rollback guarantee. [Refresh](https://github.com/omacom/omarchy/blob/60663faf8764253646f1d6166e864b608d4a0fa1/bin/omarchy-refresh-config), [update](https://github.com/omacom/omarchy/blob/60663faf8764253646f1d6166e864b608d4a0fa1/bin/omarchy-update)
- Theme switching coordinates many underlying applications. The transferable idea is consistent cross-component state, not merely colors. [Theme application](https://github.com/omacom/omarchy/blob/60663faf8764253646f1d6166e864b608d4a0fa1/bin/omarchy-theme-set)

**Transfer:** Casper can legitimately be a distinct application on Pi if the integrated workflow is materially better. Provide a coherent command surface, useful defaults, clear overrides, visible running/paused/blocked states, and understandable recovery. Do not imitate an entire desktop, its breadth, or keyboard-only assumptions.

## Proposed Casper direction — not yet agreed or implemented

1. Treat final model prose as a proposed finish. Report acceptance separately from execution termination.
2. Establish lightweight acceptance criteria from the request/repo; ask only for consequential ambiguity. Distinguish regression checks from evidence of the requested behavior.
3. Tie evidence to the checked workspace state and preserve command, scope, output, and failures. Subsequent edits invalidate relevant evidence. Changes weakening checks must be visible rather than silently legitimizing success.
4. Keep working within repository approval: inspect, edit, execute, install dependencies, and repair without repeated permission prompts. Retain questions for scope changes and consequential external actions; commit/push remain separately authorized.
5. Separate provider failure, environment failure, incorrect implementation, and lack of progress. Choose recovery accordingly rather than retrying the same operation until a cap.
6. Change hypothesis, gather new evidence, or refresh context when stuck. Raise supported reasoning effort when justified; do not assume more thinking always helps. Ask before a model switch unless the user has explicitly configured that authority. Remain provider-neutral.
7. Exhausted effort or missing verification yields an honest blocked/partial/unverified outcome, not a success label. A review model can contribute evidence but is not an infallible certifier.
8. Use focused real tasks to compare Casper against OMP with comparable models and track accepted results, user interventions, elapsed time, and cost. This is a consolidation phase, not abandonment of the roadmap.

## Follow-up: the user's existing design corpus

The initial external comparison was incomplete: it read Casper's summaries but did not revisit the projects behind them. The build plan already explicitly names these projects as a design corpus (§30 and the final comparison). The following local inspection corrects the attribution and changes the recommendation from “borrow these new ideas” to “carry forward and simplify existing lessons.”

### Inspection provenance

Inspected local source and documentation, not new runtime trials. No other repository was modified, no credentials were read, and no provider calls were made. SkyN3t and GreenCLI have uncommitted changes: their HEADs identify the base, **not an immutable snapshot of all inspected content**. Historical test/benchmark numbers below are reported by their documents, not independently rerun here. HPE checkouts are local snapshots, not asserted to be latest upstream.

| Local checkout | HEAD at inspection |
|---|---|
| `../skyn3t 2.0` | `4826a9c7967074b863d75e2b237e1a14c802f32e` |
| `../GreenCli` | `4e1a54d3d7757f41d9802d7e64ddc57755913caf` |
| `../mindmesh` | `81cc26738528b480baabe6c68e58cde3fffd7376` |
| `../CasperCloud` | `af450df19ae093780b494242070c4039f9c6c4d5` |
| `/Users/stephenchoate/Projects/credfree-setup-verification-48552/secure-ssid-hpe-networking-mcp` | `86b25e86a42783121e8740ff27e2b44309841437` |
| `/Users/stephenchoate/Projects/credfree-setup-verification-48552/nowireless4u-hpe-networking-mcp` | `c0279b5c88fd2b3c87601108654ef1b0fbe3f200` |

Paths in the following subsections are relative to those checkouts.

### SkyN3t: the strongest direct predecessor

**Already present, not new external discoveries:**

- Progress-triggered model fallback retains conversation and existing writes. `skyn3t/adapters/llm.py:4106–4150` implements configured fallback selection, excludes session-exhausted models, honors fallback disablement, and emits the switch reason. `tests/test_openrouter_progress_failover.py` covers read-only stalls, repeated reads/identical writes, preserving edits, and disabled fallback. This is more directly relevant to coding nonprogress than transport-only retry.
- Candidate retention is separate from successful delivery. `skyn3t/persistence/candidate_archive.py` labels retained fragments `unverified`, `delivered: false`, `proof_passed: false`, and `complete_backup: false`, with a base-source digest and bounded contents. `tests/test_improve_candidate_retention.py` includes provider failure, worktree cleanup, proof rejection, and unsafe-file cases. It is not a complete resumable filesystem transaction.
- Required browser outcomes derive from the saved product contract, not the generated implementation plan. `skyn3t/studio/web_interact_check.py:70–126` tracks primary/persistence/invalid-input obligations and invalidates evidence using source identity. Derivation is partly lexical and browser-flow coverage is bounded; this is not universal semantic verification. Its helper distinguishes `not_checked` from `failed` and marks reliable failures as delivery-blocking; do not infer that this helper alone blocks every missing check.
- `docs/research/2026-09-16-autonomous-coding-reliability.md` already researched OpenHands, SWE-agent, Aider, LangGraph, and Anthropic. It specifically documents real diagnostic feedback, candidate salvage, shared budgets, duplicate outer-session retries, and the distinction between mechanisms and proven outcomes. Those sources were not re-audited in this follow-up.
- `docs/EVIDENCE_LEARNING.md` separates evidence collection, candidate evaluation, and activation. It treats guidance as advisory and distinguishes provenance/admission from measured effectiveness. This is a stronger starting point than merely adding persistent memory.

**A measured lesson worth retaining:** `docs/research/2026-09-17-closeout-benchmark.md` reports five matched council trials per policy: the 15-second bounded arm produced usable advice in 0/5, versus 4/5 with the 30-second full arm. This does not establish end-to-end performance, but directly refutes “shorter deadline = better product” for that setup. The same document reports a Docker-blocked control honestly rather than calling it verified delivery.

**What to improve, not copy:** file writes are only a proxy for progress. Legitimate diagnosis can require reading, while churn can produce many writes without fixing anything. Casper should combine task stage, diagnostic change, evidence acquisition, and meaningful diff changes—not blindly transplant no-write thresholds. Keep the compact recovery mechanisms; do not inherit the entire factory/council architecture or every free-provider-specific policy.

### HPE MCP: large-catalog handling is already part of the lineage

- Secure-SSID's `src/hpe_networking_mcp/mcp_servers/tool_router.py` exposes the minimal find/read-invoke/write-invoke surface, bounds returned items/bytes, and provides integrity-protected read continuation bound to tool and arguments. Writes do not get continuation replay. These are existing low-context mechanisms, not ideas first discovered through Jev.
- Nowireless4u's `README.md` describes code-mode discovery and dynamic exposure. `src/hpe_networking_mcp/skills/_engine.py` separates metadata browsing from body loading; its guidance specifically warns against improvising procedures from metadata alone. `src/hpe_networking_mcp/middleware/retry.py` distinguishes read/write retries and does not automatically replay 5xx writes.

**Transfer:** discovery → inspect schema/instructions → execute → bounded result → deliberate continuation. Keep external-action semantics distinct from approved local repository work. Do not import network-device confirmation defaults into every local edit. Nor should Casper generalize a provider-specific retry assumption into a universal guarantee about duplicate external effects.

### GreenCLI: integration lifecycle is daily-driver functionality

`src-tauri/src/mcp/client.rs` implements stdio request correlation and Streamable HTTP handling, tolerates the optional notification stream being unavailable, responds to tool-list changes, tracks dead connections, cleans up pending requests on timeout, and distinguishes connection identity across reconnects (`same_connection`). Config persistence uses temporary-file replacement.

The practical lesson is not “supports MCP.” It is that tool visibility and UI connection state must follow the actual transport lifecycle. Automatic recovery should not leave stale routes or advertise a dead server. This directly informs Casper's reconnection friction and uncertain in-flight action handling.

### CasperCloud: reliable interruption and partial availability

`docs/DECISIONS.md` explicitly records failed approaches: one UI task per token starved layout; one-shot failure latches left long-running state stale; backend replacement must close owned resources; truncated streams must not look successful.

`Sources/CasperKit/CasperChat.swift:208–282` increments a generation before cancellation, rejects late deltas, and resets the old backend before installing a replacement. `MCPToolHub.swift` loads inventories concurrently with per-server diagnostics and timeouts, retaining responding servers rather than letting one bad integration erase all capability.

**Transfer:** trustworthy cancellation and degraded operation are part of autonomy, not optional safety friction. Casper must clearly distinguish paused, cancelled, blocked, and still running—and not accept late writes/results from superseded work.

### MindMesh: coherent state, not just diagram export

`docs/adr/0001-canonical-document-model.md` specifies one canonical map, derived views, typed commands, and inverses; `packages/map-model/src/commands.ts` supplies the command vocabulary. `CONTEXT.md` explicitly distinguishes a verification matrix from a verification audit and a durable handoff from transient session context.

`docs/adr/0007-ai-proposes-never-applies.md` makes AI proposals use the ordinary mutation path, preserving authorization, attribution, undo, and stale-state checks. It sends branch context rather than an entire map.

**Transfer:** Casper's task view, evidence, handoff, and eventual visualization should project the same underlying state. Reuse ordinary mutation paths and bounded context. **Do not copy mandatory manual acceptance for every coding edit**: that ADR addresses a collaborative map product, whereas Casper's approved repository work should remain autonomous.

### Revised synthesis

The user's history already contains most of the substantive direction: observable outcomes, progress-aware recovery, retention of unfinished work, progressive capability loading, lifecycle correctness, and evidence-backed learning. The external research adds comparisons and refinements—not ownership of those ideas.

- SkyN3t supplies the closest recovery/verification lineage; Hermes is a useful independent comparison, not the sole starting point.
- OMP supplies an effort-selection comparison; SkyN3t already provides the more directly relevant local progress-fallback example.
- Jev offers a candidate semantic routing component; the HPE projects already establish why staged capability discovery matters.
- Omarchy reinforces cohesive packaging; GreenCLI, CasperCloud, and MindMesh already supply concrete lessons about making an integrated application usable and coherent.

**Recommendation:** a smaller, more usable continuation of this accumulated work—not a new factory and not a feature grab-bag from other harnesses. The unresolved issue is the exact default acceptance/recovery behavior and whether it reduces interventions in real coding work. Reading this corpus does not establish Casper already outperforms OMP.

## Decision frontier

The next product decision is whether Casper should, by default, continue after the model says it is done when relevant evidence is missing—and expose a visibly different unverified/blocked outcome if it cannot obtain that evidence. The recommendation is yes, with lightweight acceptance planning and without repeated approvals for ordinary repository work.

That would be stronger than a prompt, checklist, or optional bounded verification nudge. It is not yet a demonstrated advantage; the daily-driver trials must establish whether it saves more supervision than it adds.
