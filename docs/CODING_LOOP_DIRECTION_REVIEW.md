# Coding-loop direction review — after 7ce29ad

## Verdict

**Keep the direct-Pi direction, but do not treat the evidence integration as ready for recovery/model escalation.** The checkpoint improves honesty and removes concrete false-success defects. It has not yet delivered the main user benefit: verification driven by actual work, with useful reuse of checks the coding session already ran.

The largest concern is not a factory pipeline appearing in the code—it has not. It is spending increasing effort on conservative bookkeeping that does not yet make everyday coding easier. The whole-workspace fingerprint is a defensible experimental fallback, but current evidence does not justify treating it as the long-term foundation.

This assessment supersedes any implication that the prior correctness review established product readiness. It does not invalidate that review's reproduced fixes or passing tests.

## Scope and independence

- Reviewed checkpoint: `7ce29ad`; comparison: `git diff db139f7...7ce29ad` (one commit).
- Spec: the user's edit/check/freshness/reuse/repair request and `CODING_LOOP_AUDIT.md` agreed direction. Standards/design sources: that audit and `CASPER_COMPLETE_PLAN.md`'s thin-adapter/direct-loop constraints. No separate coding-standard or issue-tracker file was found; optional issue-review setup remains `/setup-matt-pocock-skills`.
- This is **single-agent self-review**, including direct source inspection and new local probes. It is not independent review or a guarantee of neutrality. No parallel reviewer capability was used.
- No source or test changes, live inference, credentials, external service access, new dependencies, commit, or push. Temporary probe directories were removed. Only this review and the new handoff were written.

## What is genuinely better

1. **Execution and verification are separated.** CLI/task receipts no longer turn terminal provider errors into successful tasks; Pi-recovered errors are handled separately.
2. **False evidence was removed.** Raw Pi tool success is no longer promoted to an invented exit code. The unsafe event-only cache was replaced rather than defended.
3. **Some duplicate work is removed.** Single-check repair no longer does fail → pass → pass. Multi-check selections can reuse a targeted pass in a small, supported, unchanged workspace.
4. **The default working loop remains direct.** Pi still chooses reads, edits and shell calls. Automatic verification is opt-in. No score, mandatory council, factory, new permission ceremony, or model-switch policy was added.
5. **Regression coverage is substantive.** Tests include actual command execution, cancellation, stale files, partial writes, and a pinned-Pi/local-provider fixture—not just mocked happy paths.

These are useful checkpoint gains. They do not establish faster task completion, lower cost, fewer interventions, or superiority to another harness.

## Standards

**No new hard documented-standard breach identified in this pass.** Runtime-specific normalization is localized; observations are bounded; no dependency/fork/pipeline expansion was found.

**One advisory design finding — fragmented evidence semantics.** `verify/evidence.ts`, `verify/repair-loop.ts`, `task/result.ts`, and the unchanged `memory/store.ts` must agree on what `pass` means when freshness is unknown. Currently they do not preserve the same qualifications. This is a possible Shotgun Surgery smell, not an argument to build a generalized evidence framework. A small shared outcome projection/contract would be preferable to more independently assembled status strings. The concrete behavioral consequence is Spec finding 4.

## Spec

### 1. The requested work-driven loop remains partial

The request was to connect verification to what actually happened, not request keywords. `src/app.ts:403–407` still requires the original classification to be modification-shaped with a nonempty check selection. `observedEdits`, `possibleMutations`, and `observedChecks` primarily populate receipts; they do not drive that decision.

Fresh classification probes still give:

| Request | Mode | Selected checks |
|---|---|---|
| Continue | read | none |
| Make the login button work | read | none |
| Fix the typo in README | modify | typecheck, lint, test, build |

Raw model-run checks are intentionally not reusable. That narrowing was correct given the untrustworthy execution metadata, but it leaves a core requirement undone. Managed-verifier failures feed repair; arbitrary failures encountered in the direct loop have not gained a new reliable recovery connection.

**Assessment:** disclosed scope gap, not hidden completion. Do not advance to effort/model heuristics as if evidence integration were complete.

### 2. Freshness currently penalizes normal outputs and produces inconsistent aggregate status

`workspaceState()` fingerprints the whole bounded cwd, including ignored files and Git metadata. `repair-loop.ts` calls any difference during a check stale. It does not distinguish changed verification inputs from intended build outputs, coverage files, caches or logs.

A new real-command probe built the same tiny project twice in separate directories. Both had unchanged `source.ts`, `.gitignore` excluding `dist/`, and a build that only created `dist/output.js`:

| Fixture | Command exit | Freshness | Report | CLI mapping |
|---|---:|---|---|---:|
| Ordinary directory | 0 | stale | incomplete | 2 |
| Same fixture + unrelated symlink | 0 | unavailable | pass | 0 |

The symlink disables fingerprinting; `verificationStatus()` treats known-stale evidence as incomplete but unavailable freshness as pass. The warnings disclose this, but the aggregate result becomes *more favorable when observation gets weaker*. The first case also labels an ordinary successful artifact-producing build incomplete without evidence that its inputs changed.

Sources: `src/verify/workspace-state.ts`, `src/verify/repair-loop.ts`, `src/verify/evidence.ts:32–35`, `src/task/result.ts:23–28`.

**Assessment:** actionable result-semantics problem. Keep command execution, freshness and coverage distinguishable. Do not fix it by treating known-stale input evidence as a current pass, or by making every unknown state a new mandatory failure gate.

### 3. The reuse mechanism cannot establish a fingerprint on this checkout

Five sequential calls to `workspaceState(process.cwd())` on Casper's checkout at review entry returned unavailable **5/5**. Durations were **52.08, 22.83, 27.00, 27.15, 23.92 ms**. These are diagnostic samples, not a matched benchmark or a claim about overall task performance.

Therefore filesystem-matched reuse is unavailable on this particular repository state. The implementation collapses all unsupported-file/size/work/deadline/error causes to `undefined`; these probes do not identify which limit or entry caused it. The bounds intentionally fail closed for reuse, but whole-tree requirements are a poor fit for many dependency-heavy repositories. Native shell checks remain outside reuse regardless.

**Assessment:** important applicability limitation, now measured rather than merely documented as hypothetical. Do not solve it by blindly increasing budgets or silently ignoring directories and claiming complete coverage. First define a useful, explicit input scope and test it on realistic repositories.

### 4. Durable outcomes discard the freshness qualification

`ProjectMemory.recordOutcome()` stores the aggregate verification status plus check name/status, but not freshness, reason or scope (`src/memory/store.ts:87–95`). A report whose commands passed with unavailable freshness is persisted as verification `pass`, without the qualifier that the terminal showed. `/memory outcomes` exposes that reduced summary.

Human acceptance correctly remains `null`; this is **not** fabricated human acceptance. Also, `ProjectMemory.context()` currently injects explicit facts, not outcome history, so this review does not claim the summary is already steering subsequent models. Nevertheless, the new evidence distinction is lost at handoff/history time.

**Assessment:** integration gap. Preserve a compact qualification when the outcome contract is revised; avoid a full transcript/evidence database or an unrelated memory expansion.

## Direction and next increment

### Keep

Pi's direct loop; actual command failures as repair feedback; bounded observations; separate execution/acceptance; retained edits; optional verification; the useful first-slice reporting fixes.

### Reconsider before extending

Whole-tree freshness as an aggregate success policy; the assumption that more snapshot machinery necessarily reduces supervision; any claim that narrow reuse tests establish daily-driver benefit. The prior tests correctly exercise the implemented semantics, but some explicitly assert those very stale/unavailable rules—their passing does not validate the product decision.

### Recommended sequence (proposal, not new implementation authorization)

1. **Settle the small evidence contract.** Command exit, input freshness, check scope, and behavioral coverage are separate facts. Define how receipts, CLI, repair and durable summaries convey them consistently. No score or new mandatory completion subsystem.
2. **Prove one direct-loop path.** A vague request causes a real edit; the session selects a relevant check; actual execution evidence is captured; a valid passing check is not duplicated; a later input edit invalidates it; a failure reaches the existing repair owner.
3. **Choose an honest execution seam.** Inspect what the pinned public Pi SDK can expose at actual command execution, including cwd/exit/cancellation and concurrent edits. If it cannot supply trustworthy native-shell evidence, consider a small Casper check tool using the existing command runner, available inside Pi's ordinary loop. That would be a deliberate subset, not transparent native-shell reuse. Do not infer exit status from display text or `isError`.
4. **Exercise realistic cases before expanding policy.** Source edits, docs-only work, successful builds writing artifacts, checks generating coverage, input edits after checks, external/partial edits, and a dependency-heavy checkout. Missing scope must stay explicit. Measure actual commands executed, duplicate work, elapsed time and user interventions.
5. **Then add progress recovery**, followed by justified effort changes and approved model switching. One recovery owner, no nested retry loops. Keep task stop/steer visible in the near-term backlog.

Prefer replacing or narrowing the provisional snapshot policy over layering a second policy around it. No recommendation to undo unrelated Phases 4–9, remove cancellation safeguards, or restart the architecture.

## Reproduction and validation

Current focused test run:

```sh
bun test tests/coding-loop-evidence.test.ts tests/phase3-app.integration.test.ts tests/phase3-verification.test.ts
```

**40 passed / 214 assertions**, 10.13 s. Last full checkpoint validation remains **223 passed / 1,298 assertions**, TypeScript passed (recorded in `CODING_LOOP_REVIEW.md`); the full suite was not rerun for this documentation-only review.

Run this from the repository root to reproduce the artifact/symlink comparison without changing repository files:

```sh
bun --eval '
import {mkdtemp,mkdir,writeFile,symlink,rm} from "node:fs/promises";
import os from "node:os"; import path from "node:path";
import {VerifierRegistry} from "./src/verify/registry.ts";
import {runCommandCheck} from "./src/verify/command.ts";
import {verifyAndRepair} from "./src/verify/repair-loop.ts";
import {taskExitCode} from "./src/task/result.ts";
const parent=await mkdtemp(path.join(os.tmpdir(),"casper-direction-"));
try {
 for (const linked of [false,true]) {
  const root=path.join(parent,linked?"with-link":"plain"); await mkdir(root);
  await writeFile(path.join(root,"source.ts"),"export const value=1;\n");
  await writeFile(path.join(root,".gitignore"),"dist/\n");
  if(linked) await symlink("/dev/null",path.join(root,"unrelated-link"));
  const registry=new VerifierRegistry();
  registry.register({name:"build",run:()=>runCommandCheck({name:"build",
   command:"mkdir -p dist; printf built > dist/output.js",cwd:root,timeoutMs:1000})});
  const report=await verifyAndRepair({registry,checks:["build"],cwd:root,request:"Build"});
  console.log({linked,status:report.status,cliCode:taskExitCode(report),
   commandExit:report.results[0]?.exitCode,freshness:report.results[0]?.freshness});
 }
} finally {await rm(parent,{recursive:true,force:true});}
'
```

Checkout fingerprint probe:

```sh
bun --eval 'import {workspaceState} from "./src/verify/workspace-state.ts";
for(let i=0;i<5;i++){const start=performance.now(); const state=await workspaceState(process.cwd());
console.log({available:state!==undefined,ms:performance.now()-start});}'
```

**Axis summary:** Standards: **0 new hard violations, 1 advisory semantic-locality concern**. Spec: **4 findings**; the most immediate is successful-build/freshness aggregate-status behavior. None of these new findings was fixed in this documentation-only session.
