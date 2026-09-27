# Mutation check, replayed, 2026-09-27

**Result: the rule is not met, and mutation score does not separate wrong runs from right ones.** The check
makes up to 40 small bugs in the change's own JavaScript/TypeScript code (swapped comparisons, signs and
logic operators, `Math.floor` ↔ `Math.ceil`, flipped booleans and 0/1 literals, dropped `throw`s). Each bug must
make some test fail, and the check fails when more than 20% survive. It caught 1 of 6 wrong GLM runs (17%, Wilson 95%
3-56%) and flagged 9 of 27 right ones (33%); on DeepSeek's runs it flagged 9 of 48 right ones (19%). No model
call is involved: the verdict is Casper's own test runs.

Decision source: ADR 0001, the next candidate after requirement tracing
(docs/evals/2026-09-27-requirement-tracing.md). The check is `src/verify/mutation.ts`; replay with
`--check mutation`. Workspaces are the ones from docs/evals/2026-09-27-acceptance-replay.md; raw data is in
`.scratch/replay/mutation/`. The GLM replay stopped early once decided; the DeepSeek replay ran all 48
(it has no wrong runs, so only flagged could decide it).

| Work by | Replayed | Caught | Flagged | Check s (median) | Est. wall × Pi |
|---|---:|---:|---:|---:|---:|
| GLM | 33 | 1/6 (3-56%) | 9/27 (33%) | 40 | 2.55 |
| DeepSeek | 48 | no wrong runs | 9/48 (19%) | 42 | 1.26 |

## Why it misses

The wrong runs' tests were not weaker than the right runs'. On GLM's runs, the share of surviving mutants was
7-17% on the wrong runs and a median of 17.5% on the right ones. The survivors on right runs were mostly
equivalent mutants (`0 → 1` in an index start, `<` ↔ `<=` on a boundary no input reaches) or code no
requirement governs. The wrong runs' bug was a missing case, not a mutable line: an unhandled input form, a
float drift that no operator swap reproduces. A mutation of code the change wrote cannot show code it did
not write.

## What this means

This is the fifth check to fail the rule on the same misses: commands and proof; same-model acceptance tests;
cross-model acceptance tests; requirement tracing; and mutation. The misses are omissions: a stated
case that neither the code nor its tests handle. Every check that starts from the change (its tests, its
code, its mutants) inherits the omission. Only checks that start from the request (the acceptance tests)
caught any, and those depend on the test-writing model: noisy writers catch more and flag more.

Decisions for the owner:
- **Stop searching for a verdict check on this pack.** Keep `verified` as ADR 0001 defines it (checks
  passed, change proven), and ship the request-side checks only as opt-in warning lines.
- **Or change the input:** the omissions come from long prompts with many stated cases. A structured
  request (listed cases, as the hard pack's hidden tests are) would give a check something to trace
  against, but it changes the product: users would have to write requirements that way.
