# Backburner references: security audits and low-noise output

Research snapshot: 2026-09-19. **Reference ideas, not an implementation decision or authorization.** The current coding-loop fix remains separate.

Primary-source, single-agent inspection of repository documentation and selected source. Nothing installed, activated, or executed from either project; no credentials, live-model calls, evaluation spending or push. This note is included in the separately user-authorized checkpoint commit. Neither project was independently benchmarked or security-audited here.

Pinned sources:

- Cloudflare `security-audit-skill`: [`c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`](https://github.com/cloudflare/security-audit-skill/tree/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8).
- `ayghri/i-have-adhd`: [`839872f9d1cd634fed642b4589ce7226199cc15f`](https://github.com/ayghri/i-have-adhd/tree/839872f9d1cd634fed642b4589ce7226199cc15f).

## Recommendation

**Keep both as references; integrate neither now.** Cloudflare is the stronger reference for review rigor and trust boundaries. `i-have-adhd` offers useful communication ideas that could make Casper easier to supervise. Neither is a reason to replace Pi's direct loop or expand recovery/model controls.

## Cloudflare: borrow the review discipline, not a mandatory audit pipeline

### What the source actually offers

The skill distinguishes focused **guidance mode** from an explicitly requested **full audit**. The latter has six phases, isolated hunters, fresh candidate verifiers, coverage bookkeeping, schema validation and final record verification. It separates `confirmed`, `needs_validation` and `rejected`; a missing best practice is not automatically a vulnerability. Sources: [README](https://github.com/cloudflare/security-audit-skill/blob/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/README.md), [skill](https://github.com/cloudflare/security-audit-skill/blob/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/skills/security-audit/SKILL.md), [validation/reporting](https://github.com/cloudflare/security-audit-skill/blob/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/skills/security-audit/VALIDATION-AND-REPORTING.md).

Its AI/LLM companion specifically examines tool-argument validation, approval/action binding, memory provenance, cross-session leakage, MCP identity and subagent authority. It explicitly distinguishes deterministic controls from guardrail prompts and intentional same-principal authority from a boundary violation. [AI/LLM source](https://github.com/cloudflare/security-audit-skill/blob/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/skills/security-audit/AI-AND-LLM.md).

### Useful for Casper

- Trace lower-trust input → tool dispatch → authority → actual effect when reviewing skills, MCP, memory and delegated tasks.
- Keep hypotheses, reproduced findings and rejected claims distinct. Ask what would disprove a finding, rather than collecting plausible warnings.
- Explicitly disclose reviewed scope and missing evidence. A passing validator establishes structure, not truth; a scoped command pass is not a security certificate.

These are methodological transfers, not a proposal to reuse security verdicts as Casper's command/freshness statuses.

### What not to import now

The full workflow's agent waves, ledgers and mandatory independent passes would be a substantial optional audit feature, not an appropriate default coding loop. Its execution policy also requires an **OS-enforced sandbox**, an allowlisted environment, network restrictions, scratch-only writes and resource limits before running target-controlled code. Missing controls block execution. Casper's current command runner inherits the environment and is not such a sandbox; opt-in consent, a declared input scope and a read-only child tool list are not substitutes. This mismatch alone is not a claim that Casper has an exploitable vulnerability. Sources: [execution policy and budgets](https://github.com/cloudflare/security-audit-skill/blob/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/skills/security-audit/SKILL.md), local `src/verify/command.ts` and README verification limits.

**Revisit when:** scheduling a separately authorized security review of Casper's capability/trust boundaries. Start with focused guidance, not installation of the complete workflow.

## i-have-adhd: borrow accessible presentation, preserve evidence

### What the source actually offers

This is an output-style skill: action-first answers, short numbered steps, visible state/progress, fewer tangents and matter-of-fact errors. It includes task/safety exceptions and explicitly says its list cap must not discard relevant findings or limit analysis. Its Pi extension provides a session toggle, saved state and context synchronization; always-on behavior requires opt-in configuration. Sources: [skill](https://github.com/ayghri/i-have-adhd/blob/839872f9d1cd634fed642b4589ce7226199cc15f/skills/i-have-adhd/SKILL.md), [Pi extension](https://github.com/ayghri/i-have-adhd/blob/839872f9d1cd634fed642b4589ce7226199cc15f/extensions/i-have-adhd.ts).

### Useful for Casper

An optional low-noise presentation could answer: **what changed, what actually ran, what remains uncertain, and whether the user needs to act**. Render that from Casper's existing task/evidence state instead of asking the model to invent progress. Put detail behind a clear expansion or reference, while retaining material failure, cancellation, freshness and coverage qualifications.

Treat these as usability ideas for anyone who wants them—not as an assumption about the user's diagnosis or scientifically established effects of the skill.

### What not to import blindly

- Do not force an action when the user asked for an explanation, or hand agent-owned work back to the user as a “next step.”
- Do not invent precise durations or a definite cause to satisfy a formatting rule. “Cause not established” is a useful result.
- Do not let brevity hide unresolved checks, or turn repeated state summaries into more noise.

There is a concrete caution in the project's **earlier published self-evaluation**: it reports improved actionability/concision but a `partial-success` regression involving an unsupported definitive cause. It also discloses a broken agent-owned-edit case with tools disabled, three trials per case and a same-model-family judge. Those results are neither a Casper benchmark nor proof about the currently inspected version. Sources: [results](https://github.com/ayghri/i-have-adhd/blob/839872f9d1cd634fed642b4589ce7226199cc15f/evals/RESULTS.md), [evaluation method](https://github.com/ayghri/i-have-adhd/blob/839872f9d1cd634fed642b4589ce7226199cc15f/evals/README.md).

**Revisit when:** doing a user-approved CLI/TUI usability pass. First compare a few real Casper receipts side by side, including partial failure and cancellation; that needs no live-model spending or new agent subsystem.

## Parking decision

Retain the references. Borrow **skepticism and explicit trust boundaries** from Cloudflare, and **clear state with low reading overhead** from `i-have-adhd`. Installation, executable extensions, new audit orchestration, persistent style defaults and paid experiments remain unapproved.
