# Learning candidates and human promotion

`casper learn` proposes reusable patterns from an explicitly supplied local
repository. Generation produces **unpromoted drafts**, never active guidance.
A separate local command lets a human bind one exact draft candidate to an
explicit reference, project-skill, global-skill, or ignore decision. The model
cannot choose a disposition or invoke promotion.

## Commands and consent

```sh
casper learn ~/Projects/example
casper learn list ~/Projects/example
casper learn inspect ~/Projects/example <draft-id>
casper learn promote ~/Projects/example <draft-id> <draft-sha256> <candidate-number> reference
casper learn promote ~/Projects/example <draft-id> <draft-sha256> <candidate-number> project-skill <skill-name>
casper learn promote ~/Projects/example <draft-id> <draft-sha256> <candidate-number> global-skill <skill-name>
casper learn promote ~/Projects/example <draft-id> <draft-sha256> <candidate-number> ignore
```

Generation uses **one bounded read-only explorer** with Casper's `fast` model
role when configured, otherwise its saved startup model; credentials remain Pi-owned.
Running it authorizes that model run and any configured automatic-effort classifier:
source text read by the explorer can reach the configured provider. Casper does
not detect secrets or establish a spending cap. Use only sources appropriate for
that provider. No live-model usefulness or billing trial has been performed for
this slice.

The source must be an explicit local directory; relative paths resolve from the
caller's cwd, `~/` uses the user's home, and the supplied root is canonicalized.
It need not be a Git checkout. URLs and cloning are unsupported. Paths with spaces
must be shell-quoted. To name repositories literally called `list`, `inspect`, or `promote`, use a
path such as `./list`.

`list`, `inspect`, and `promote` are local: no credentials, provider call, model
startup, source scan, or normal-task outcome recording. `promote` requires the
exact ID and SHA-256 shown by inspection plus a one-based candidate number and
explicit disposition. Skill names are lowercase alphanumeric words separated by
single hyphens, up to 64 characters. Extra or missing arguments fail locally.

A candidate can receive only one immutable decision. Repeating the exact command
is idempotent and returns the same decision; trying to change its disposition or
skill name fails. `ignore` records review without creating active content. A
reference is published under the reserved `casper-promoted` reference source. A
project skill is project-scoped but stored in Casper's owner state, not in the
source checkout. A global skill is available from owner state to all projects.
Reference and skill artifacts carry an explicit caveat that promotion is not
verification and does not override current evidence or rules.

All three local operations also work after the source is removed if you supply
the saved draft's **canonical `sourceRoot`**. Inspection shows historical
observations, not refreshed source evidence. Records are keyed by source root,
not the caller's workspace. Moving a source does not migrate its drafts.

These are top-level CLI commands, not an interactive `/learn` command or a
model-facing learning or promotion tool. `learn` cannot be combined with `--verify`, `--mcp`
or `--lsp`; invalid learning syntax fails locally rather than becoming an
unrestricted parent prompt.

## Candidate contents and evidence meaning

Each candidate contains:

- name, problem, context, and proposed pattern;
- `whyItMightHelp` — an explanation/hypothesis, not a proven successful outcome;
- tradeoffs, use-when and avoid-when guidance;
- evidence: relative file, inclusive one-based line range, exact quoted lines,
  and a **host-computed SHA-256 of the observed file bytes**.

Casper accepts only the bounded candidate schema. The model cannot set digests,
IDs, verification, acceptance or promotion fields. After generation, Casper reads
the cited regular UTF-8 files, checks each quote against the named lines, and
computes digests. CRLF is normalized to LF in quotes; a UTF-8 BOM is omitted from
text. Digests always cover the original bytes, including BOM/newline encoding.
Each cited file is read once per validation batch.

Host citation checks reject absolute/traversing paths, hidden entries,
`node_modules`, `vendor`, `dist`, `build`, `coverage`, `target`, `__pycache__`,
symlinked entries/parents, special files, oversized files, invalid UTF-8/NUL text,
and mismatched quotes. An explicitly supplied root alias is resolved, not treated
as an in-repository symlink. There is no extension whitelist for otherwise valid
text evidence.

These checks establish only that quotes matched an observed source. They do not
prove the explorer visited that exact version, that the prose accurately explains
it, that a pattern worked, or that it suits another project. No tests are run.
Every draft has `status: unpromoted`, `verification: not-run`, `accepted: null`, and
`coverage: not-certified`. Current repository evidence, rules and user requests
remain authoritative. Even a structurally valid proposal can contain mistaken or
hostile guidance: nothing consumes these drafts automatically.

The reads are bounded, non-atomic observations, not a repository snapshot or a
freshness guarantee. Concurrent external edits can make evidence stale immediately.
A saved digest identifies bytes, not a commit, trust grant or correctness proof.

## Runtime and resource limits

Generation reuses the existing explorer and Pi adapter without changing their
authority: only `read`, `grep`, `find`, `ls`; no shell, edit/write, MCP/LSP,
recursive delegation, ambient executable extensions, project model overrides,
automatic skills/context files, or persistent child conversation. Casper does not
execute project code or load its scripts/configuration during learning. Existing
Pi auth/model bookkeeping and runtime caches still involve disk I/O;
disabling child conversation persistence is not zero disk I/O.

Before Pi model/auth initialization, read-only startup checks its active agent
state directory (`PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`) plus `auth.json`
and `models-store.json` against the canonical source. Overlap is refused before
provider requests or Pi state creation: choose another source or move that state
outside it yourself. Existing directory/file aliases and missing ordinary path
suffixes are checked; unresolved paths fail closed. The bounded preflight permits
sibling state directories and does not relocate credentials, alter model defaults,
or restrict ordinary parent sessions. Local `list` / `inspect` do not start Pi.

This checks known Pi state destinations, not every possible cache or hardlink
alias. It is non-atomic and cannot prevent concurrent path replacement. Keep
other runtime/cache destinations outside sources too.

**Read-only is not a filesystem sandbox.** Staying in the source and avoiding
sensitive/generated files is an explorer instruction, not native read confinement.
The stricter path and byte checks above govern **saved evidence**, not every
native read the model could attempt. Source content is untrusted data, never
permission to alter the task. No guarantee is made against a hostile process with
the same user's filesystem privileges. Windows remains unvalidated.

Per invocation:

- One explorer dispatch; existing limits of 180 seconds, 12 model turns and 48 tool
  calls. No automatic generation retry, repair loop, or new spending policy.
- Final model response: at most 12 KiB; existing cumulative streamed-text limit
  128 KiB. Cut-off/truncated reports, tool errors, failed/limited/timed-out runs or
  pending cleanup cannot publish drafts.
- At most four candidates, four citations each, 128 KiB per cited file: at most
  16 distinct files / 2 MiB read during host validation. Each citation has at most
  40 lines and 2 KiB of quote text; relative paths admit 256 UTF-8 bytes.
- Names admit 120 bytes; problem/context/why-it-might-help 1 KiB each; pattern
  2 KiB; tradeoffs/use-when/avoid-when each admit one to four 512-byte strings.
  The overall response limit still applies.
- Cancellation aborts the explorer and is checked between host operations and
  before publication. Filesystem operations are cooperative, not hard-preempted.
  CLI shutdown retains its existing one-second deadline. Cancellation before
  publication saves nothing; once atomic publication begins, a complete draft
  may remain even if the process is interrupted before printing its result.

Malformed output or any bad citation rejects the **whole batch** without altering
previous drafts. A valid empty candidate array reports `no-candidates` and writes
no record. This is not proof that the repository contains no reusable patterns.

## Storage and local inspection

```text
~/.casper/projects/<source-name>-<canonical-root-hash>/
  learning-candidates.jsonl
  learning-promotions.jsonl
  skills/<skill-name>/SKILL.md                 # project-skill
~/.casper/promoted-references/<draft-id>-<n>/REFERENCE.md
~/.casper/skills/<skill-name>/SKILL.md         # global-skill
```

The existing project-state identity is reused. This file is separate from facts
and outcomes and outside skill/reference discovery. Casper refuses redirected
state-directory symlinks and state locations inside the source repository.

Each successful nonempty invocation appends one immutable batch with a generated
ID, timestamp, canonical source root, candidates and a batch `sha256`. The batch
digest covers `JSON.stringify` of the record without its `sha256` property, using
the stored property order. It detects altered records, not authenticity: someone with write access can
change a record and recompute its digest.

Storage is owner-only **plaintext**, not encrypted. Saved prose and exact quotes
can contain sensitive source text. No raw model transcript, tool output, command
output, or whole repository is copied into the draft store.

Persistence uses a per-source directory lock (up to 100 attempts / approximately
two seconds of waiting), reload-under-lock, exclusive `0600` temporary files and
atomic rename. New directories use `0700`. Publication is atomic visibility, not
a crash-durability/fsync guarantee. Concurrent processes preserve each other's
records. Interrupted locks are not stolen; preserve/inspect state before manual
recovery. No automatic deletion, pruning or reset is performed.

Promotion decisions are separate append-only-by-policy records. Each binds the
source root, draft ID/digest, candidate number/digest, disposition, optional skill
name, artifact path/digest, timestamp and decision digest. The ledger admits at
most **400 decisions / 1 MiB**. A user-wide lock serializes artifact publication
across projects. Artifacts are staged with exclusive files, the decision ledger
is atomically replaced, and the staged directory is then renamed into its
create-only destination. Existing destinations are never replaced. If the
ledger commit succeeds but activation is interrupted, repeating the exact
command can finish only the recorded, digest-matching staged artifact. Missing,
changed, redirected or inconsistent state fails closed for manual inspection.

Drafts and decisions remain owner-only plaintext. Promotion copies candidate
prose and historical evidence into the selected Markdown artifact; this can
include sensitive source text. The generated artifact is ordinary owner-managed
content after activation: later manual edits are not a new promotion decision.
No automatic revocation, migration, pruning, rollback or remote publication is
performed.

The draft store admits at most **100 batches / 1 MiB**. Existing malformed, duplicated,
wrong-source, digest-mismatched, invalid UTF-8, oversized, symlinked or special-file
state fails closed before generation. The write reloads and revalidates under the
lock and refuses a full store. Inspect/archive it manually before continuing.

`list` returns IDs, timestamps, digests, candidate counts and decision counts.
`inspect` returns the exact saved batch and its separate decisions without
refreshing source evidence. CLI output is JSON with
terminal controls escaped. Exit 0 means a local command completed (`saved`,
`no-candidates`, `listed`, `inspected`, `promoted`, `ignored`,
`already-decided`), not pattern correctness, repository-wide
coverage, verification or human acceptance. Failures exit 1 and publish no partial
batch; prior drafts are preserved.
