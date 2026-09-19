# Phase 4 — Independent Standards / Spec Review

## Scope and method

Baseline: `f8bb28eaf0b79d3279587f5960657d1023e7555b`. All Phase 4 implementation remains uncommitted. Two separate read-only Codex reviewer processes ran in parallel with isolated contexts (model `gpt-6-astra`, medium reasoning). They reviewed `git diff f8bb28e --` **and full contents of all nine original untracked files**; neither used the other review. An initial attempt with `gpt-5.4` was rejected as unsupported before review; only the successful runs count.

Tracked coverage: `README.md`, `bun.lock`, `package.json`, `docs/HANDOFF.md`, `docs/IMPLEMENTATION_PLAN.md`, `src/app.ts`, `src/cli.ts`, `src/index.ts`, `src/runtime/pi.ts`, `src/runtime/types.ts`.

Original untracked coverage: `docs/MCP.md`, `docs/PHASE4_VERIFICATION.md`, `src/capabilities/broker.ts`, `src/capabilities/result.ts`, `src/mcp/config.ts`, `src/mcp/manager.ts`, `tests/fixtures/mcp-server.ts`, `tests/phase4-mcp.test.ts`, `tests/phase4-app.integration.test.ts`.

Standards sources: complete-plan design rules/runtime seam/generic core/security/performance, implementation plan, README, and adjacent code; no dedicated repository standards file. Fowler smell heuristics were explicitly judgment calls, subordinate to repository requirements. No issue-tracker document exists; the supplied Phase 4 implementation plan and MCP contract were the Spec authority. Later phases and separately authorized optional HPE acceptance were excluded.

## Standards

- **P2 documented-contract breach:** recursive result normalization confused application records with MCP content blocks, deleting sibling fields such as `id`, `status`, and `next_cursor`, while claiming complete output. Violates the requirement to disclose truncation and retain continuation data when possible.
- **P3 judgment call — possible Duplicated Code:** three independent literals enforced the per-schema budget in inspection, invocation, and selection. A policy change could make those paths disagree.

Initial total: **2 findings**, worst P2.

## Spec

- **P2:** schema inspection passed schema arrays through the data-item limiter. A small enum consumed the budget and turned `required: ["site"]` into `required: []`, violating recoverable schema discovery while invocation enforced the original schema.
- **P2:** catalog-refresh failure removed tools but did not release the connection. An unanswered HTTP `tools/list` POST remained open after timeout, violating the request cleanup contract.
- **P2:** recursive result normalization silently deleted ordinary application fields/cursors (also independently identified by Standards).

Initial total: **3 findings**, worst P2. No Phase 5 scope creep found. The axes are reported separately; their shared result-normalization finding is one defect, not two.

## Reproduction and fixes

Each concrete defect first failed an automated regression in `tests/phase4-mcp.test.ts`:

| Regression command (`bun test tests/phase4-mcp.test.ts -t …`) | Red evidence | Fix |
| --- | --- | --- |
| `result normalization preserves` | Application image-like data was omitted; text-like records/metadata lost | Normalize only root MCP content blocks; preserve block metadata and do not reinterpret decoded application records |
| `schema inspection preserves` | Expected `required: ["site"]`, received `[]` | Exact-ID discovery returns lossless `inputSchemaJson`; schema arrays are not data arrays to truncate |
| `HTTP catalog-refresh timeout` | Server observed its unanswered POST still open after failed status | Refresh failure joins connection release, aborting pending I/O without replay |

Schema budgets now use shared constants and a common rejecting guard. A fourth regression checks inspection, direct selection, and fallback at **12,000 / 12,001 escaped JSON-string bytes**, including quote-heavy input. The escaped-size budget conservatively bounds both representations and avoids trading item truncation for byte truncation. This is a stricter supported-schema limit than measuring unescaped JSON; `docs/MCP.md` documents it.

No new dependencies, real HPE connections, credential changes, production writes, commits, or pushes. The existing Pi adapter was not changed by these fixes.

## Validation

- Baseline rerun: TypeScript passed; **66 tests / 363 assertions**.
- After initial fixes: `bun run check` passed; **70 tests / 384 assertions**; three Phase 4 repeats passed at **29 tests / 159 assertions each**.
- Final validation including the follow-up metadata fix: `bun run check` passed; **71 tests / 389 assertions**, TypeScript passed. Three Phase 4 repeats passed at **30 tests / 164 assertions each**.
- Real Pi/local provider-payload fixture passed in the full and repeated suites.
- `git diff --check` passed.

## Independent follow-up verdicts

The first follow-up attempts stopped at a provider usage limit without producing verdicts; these were not counted as completed reviews. Retried focused reviews completed independently, covering the fixes, regressions, fixture changes, and revised contract.

### Standards

**No blocking findings.** The reviewer confirmed application-data preservation, shared schema-budget policy, refresh cleanup, and regression coverage. No introduced correctness issues identified in the targeted scope.

### Spec

The reviewer confirmed all three original P2 defects resolved and found **no blocking findings**, but identified one additional **P3**: binary-content omission also discarded annotations, `_meta`, and embedded resource URI metadata, contrary to the updated retention contract.

This was reproduced by `bun test tests/phase4-mcp.test.ts -t 'binary content omits'`: expected metadata was absent for image, audio, and embedded blob content. The fix omits only the binary `data`/`blob` payload fields; retained metadata still passes through normal result budgets. The regression passed after the fix. A further independent targeted Spec review confirmed **P3 resolved; no new actionable issue**.

All initial findings and the follow-up P3 are resolved. Reviewers performed static/read-only reviews and did not run the file-writing fixture suites; the coordinating agent ran the validation above. These verdicts are scoped review evidence, not proof that no other defects exist.

## Remaining gates

Actual HPE deployment acceptance remains pending explicit endpoint/credential/read-only authorization for that optional personal integration. No fresh external live-model smoke was performed; prior live evidence remains in `PHASE4_VERIFICATION.md`. Phase 5/LSP is not started. Commit/push only on request.
