# Phase 2 Review and Verification

## Scope

Reviewed the complete Phase 2 working tree, including new files, against Phase 1 checkpoint `e9f1f8741c7397f02dd0b86e01a0dfd0027ad55e`. Two independent read-only Pi subprocesses reviewed standards and spec compliance in parallel, followed by independent follow-up reviews after fixes.

Spec sources: `docs/CASPER_COMPLETE_PLAN.md` sections 14, 16, and Phase 2; `docs/IMPLEMENTATION_PLAN.md`; the skill contract in `README.md`. Standards sources: the documented small-module/runtime-isolation constraints, plus the code-review skill's heuristic smell baseline. No dedicated coding standards or issue-tracker configuration was found. Local specs were sufficient for this review; for future issue-linked reviews, `/setup-matt-pocock-skills` can configure the missing tracker workflow.

## Standards

Initial actionable findings:

1. **Local skill commands depended on runtime startup.** `CasperApp.start()` created a Pi session before dispatching `/skills`, contrary to the documented local inspection/review workflow. Missing credentials or runtime startup failure could block those commands.
2. **Project discovery could escape the canonical project root.** Skill scanning followed symlinked directories/files outside the project, contrary to the documented discovery boundary.

Both are fixed. Startup now prepares local project/skill context only; `ensureRuntime()` runs on the first non-local prompt. Discovery rejects project-scoped roots, directories, and files whose canonical paths escape the project. In-project links remain supported.

One initial, non-blocking **possible Divergent Change** suggestion concerned keeping discovery/trust/activation in the registry. The cohesive registry interface was retained rather than introducing more abstractions at this phase.

Independent follow-up verdict: **No blocking findings.** The reviewer confirmed both fixes, their regression coverage, continued Pi isolation, and no later-phase scope expansion.

## Spec

The independent spec review identified the same two functional mismatches:

- “No model call for these commands” / local review commands must not require model runtime startup.
- Project-root-bounded discovery must reject symlinks escaping that root.

No other clear Phase 2 requirement gaps were identified. The follow-up reviewer verified the fixes against the current code, docs, and regression tests.

Independent follow-up verdict: **No blocking findings.** No regression was found in lazy startup, local review, or containment across native and compatible project skill roots.

## Regression Evidence

Before the fixes:

```text
bun test --test-name-pattern 'without starting|outside the project'
0 pass, 2 fail
```

The first failure was `Runtime unavailable` during `/skills`; the second incorrectly indexed `outside-mcp` through a project symlink.

After the fixes, the same command passed both tests. The complete checks passed:

```text
bun run check
Typecheck passed
19 pass, 0 fail, 116 assertions

git diff --check
Passed
```

Fresh isolated real-CLI smoke checks also passed:

- One-shot `/skills` with empty Pi configuration, without creating a model session.
- Rejection of a project skill directory symlink escaping the project.
- Interactive listing, inspection, exact-digest approval, then lazy Pi startup.
- Live model received the native TypeScript MCP and reviewed project skill bodies, but not unrelated/unreviewed/external-escape bodies.
- Blocking, updated trust listing, and clean `/exit`.

Temporary home/project/trust directories isolated the smoke fixtures. Real user skill approvals were not changed.

## Remaining Intentional Limits

- Ranking is deterministic lexical matching, not semantic search.
- Frontmatter changes require restart/re-indexing.
- Blocking stops new injection, not text already in conversation history.
- Review hashes cover `SKILL.md`, not referenced scripts/assets.
- Skill trust gates injection; general runtime tools are not sandboxed.
- Passing review/tests/smoke checks is evidence of readiness, not a guarantee of zero bugs.

**Summary:** Standards: 2 actionable findings resolved, 1 non-blocking design suggestion considered. Spec: 2 actionable findings resolved. No outstanding blocking findings on either axis. Phase 3 remains unstarted.
