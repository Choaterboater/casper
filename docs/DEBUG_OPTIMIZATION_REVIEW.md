# Casper — debugging & optimization review (whole-project pass)

**Date:** 2025-09-20 · **Tree reviewed:** `c8df223` + uncommitted Phase 9 learning slice (16 modified files, 4 untracked)
**Reviewer:** single-agent read of all `src/`, `tests/`, `docs/`, plus local reproduction probes. Not independent acceptance.

This document is written for the coding agents that will act on it. Every finding has: location, reproduction, proposed fix, and the regression test to add. Findings are ordered by severity within each section. Respect the project's standing constraints (see §0) when fixing.

---

## 0. Constraints to preserve (from HANDOFF.md / README)

Do **not** change these while acting on this document unless the user separately approves:

- Native `bash` tool behaviour, the command runner (`src/verify/command.ts`), and dependency pins (`pi-coding-agent 0.85.1`, `@modelcontextprotocol/sdk 1.30.0`).
- The **single repair owner** (`verifyAndRepair` after the primary prompt settles). No nested repair prompts.
- Opt-in semantics: managed checks only with `--verify`; MCP/LSP connections only with explicit consent.
- No commit, no push. The uncommitted learning slice must be preserved.
- No live-model spending. All validation uses scripted localhost providers and real local commands.

---

## 1. Baseline measured in this pass

| Check | Result |
|---|---|
| `bun run typecheck` | clean, 3.4 s |
| `bun test` (serial, default) | **358 pass / 0 fail / 2,277 assertions — 117.3 s** |
| `ls tests/*.test.ts \| xargs -P 4 -n 1 bun test` | **358 pass / 0 fail — 44.5 s** (2.6× faster, no flakes observed) |
| `git diff --check` | clean |
| `/project` one-shot CLI, warm | ~280–310 ms wall |
| `--help` | ~90 ms |

Startup breakdown for a local command (`/project`), measured in-process:

| Stage | ms | Notes |
|---|---:|---|
| `import ./src/app` | 87 | ~60 ms is `@modelcontextprotocol/sdk` client + ~24 ms ajv provider, imported statically |
| `inspectProject` | 64 | two sequential `git` spawns |
| `loadProjectContext` | 2 | cached model |
| `SkillRegistry.discover` (44 skills on this machine) | 132 | sequential `realpath`+`stat`+`readSkillHeader` per file across 10 roots |
| MCP / LSP / references config | <2 | fine |

Slowest test files (sum of per-test durations): `phase9-learn` 26.8 s, `phase8-pi.integration` 26.1 s, `phase7-sessions` 19.5 s, `phase5-lsp-real` 8.7 s, `work-driven-checks` 8.2 s.

---

## 2. Correctness / safety findings

### F1 — `profile:` from project-local YAML is not validated in `config/load.ts` (path traversal into arbitrary `config.yaml` / `rules.md`) — **P2**

**Where:** `src/config/load.ts:304-311, 345`.

**Problem:** Three other consumers validate the profile name before using it as a path component (`references/config.ts:46`, `lsp/config.ts:20`, `mcp/config.ts:57`), each with a *different* regex. `loadConfiguration` — the one that reads `config.yaml` and `rules.md` and defines `context.profileName` — validates nothing. A repository's `.casper/project.yaml` can therefore set `profile: ../../anything` and have Casper read `<home>/anything/config.yaml` and inject `<home>/anything/rules.md` as "Profile rules".

**Reproduced:**

```sh
mkdir -p /tmp/p/home/evil /tmp/p/repo/.casper
printf 'profile: ../../evil\n' > /tmp/p/repo/.casper/project.yaml
printf 'INJECTED\n' > /tmp/p/home/evil/rules.md
bun -e 'const {loadConfiguration}=await import("./src/config/load"); console.log(await loadConfiguration({projectRoot:"/tmp/p/repo",homeDir:"/tmp/p/home"}))'
# → profileName: "../../evil", profileRules: "INJECTED"
```

**Impact:** Limited escalation (a repo can already inject project rules and set the same numeric settings), but it reads files outside `~/.casper/profiles/`, the banner shows a traversal path as the profile, and the inconsistency means `references`/`mcp`/`lsp` silently fall back to *no profile file* while `config.yaml` uses the traversal path — three sources of truth about "which profile is active".

**Fix:**
1. Add one exported `isValidProfileName(name)` (e.g. in `src/config/load.ts`): `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/` and `name !== "." && name !== ".."`.
2. In `loadConfiguration`, validate each candidate (`options.profileName`, `CASPER_PROFILE`, `projectDocument.profile`, `globalDocument.profile`) and **throw** on an invalid explicit selection (invalid config is already fail-closed elsewhere: `skills.maxActive`, `verify.*`).
3. Replace the three ad-hoc regexes in `references/config.ts`, `lsp/config.ts`, `mcp/config.ts` with the shared function so all four agree.
4. Decide explicitly whether project-local `profile:` should be allowed to select a *user* profile at all (it can pull a user's personal `mcp.json`/`references.yaml` into scope). If kept, document it as an accepted trust decision in `README.md` Configuration.

**Tests:** in `tests/review-config.test.ts` (or `phase1-project-context`): `profile: ../../x` in project.yaml → throws; `profile: "work"` → OK; the same name is used by all four discoverers.

---

### F2 — Unknown slash commands fall through to the model — **P2 (UX + cost)**

**Where:** `src/app.ts:302-360` (`handlePromptCommand`) and `src/app.ts:239` (`/quit`, `/exit` handled only in `runInteractive`).

**Problem:** Any `/`-prefixed input not matched by the explicit regex chain is classified as a task and sent to the model. Reproduced with a fake runtime: `/help`, `/exit`, `/quit`, `/verfy typecheck` all resulted in a model prompt. In one-shot mode (`casper "/exit"`) this starts Pi, costs a model turn, records a task outcome in `outcomes.jsonl`, and injects skills/memory — for a typo.

**Fix:** At the top of `handlePromptCommand`, after the known-command chain, add:

```ts
if (prompt.startsWith("/")) throw new Error(`Unknown command ${JSON.stringify(prompt.split(/\s+/)[0])}. Type /help for local commands.`);
```

Add a local `/help` that prints the same text as `printHelp()` (move the help text into a shared module so CLI and app don't drift). Handle `/quit`/`/exit` in one-shot mode as a no-op with exit 0.

**Tests:** `tests/casper-app.integration.test.ts`: with a runtime factory that records prompts, `/help`, `/nope`, `/verfy` → no runtime prompt, error/usage written, `getLastTaskResult()` undefined, no outcome recorded.

---

### F3 — A corrupt `memory.jsonl` blocks *every* model prompt — **P2 (robustness)**

**Where:** `src/app.ts:420` (`await new ProjectMemory(...).context()`), `src/memory/store.ts:120-148`.

**Reproduced:** writing `{not json\n` to `<state>/memory.jsonl` makes `runOnce("Summarize this repository")` throw `Cannot read valid memory state: memory.jsonl; preserve the file and repair it manually` before any model call. Facts are *guidance*; they should never be a hard dependency for running a task. Same class of issue: a permanently stale `memory.jsonl.lock` directory (crash mid-update) → every `/memory remember` fails after the 2 s retry window; no stale-lock reclamation exists (`store.ts:156-163`, duplicated in `learn/candidates.ts:260-267`).

**Fix:**
- In `handlePromptCommand`, wrap the `context()` call: on failure write `[memory] Facts unavailable (<reason>); continuing without them.` and proceed with `memoryContext = ""`. Keep `/memory` commands fail-closed (they *are* about the file).
- Lock: record the lock's `mtime`; if older than e.g. 30 s and no writer PID exists, remove and retry once; surface a clear message including the lock path.
- Consider extracting the mkdir-lock + tmp-write + rename pattern (duplicated in `memory/store.ts`, `learn/candidates.ts`, `skills/registry.ts:saveDecision`, `project/model.ts:writeCache`, `sessions/store.ts`) into `src/state/atomic.ts`. Five copies of a subtle pattern is where the next lock bug will come from.

**Tests:** `phase9-memory.test.ts`: corrupt facts file → task still reaches the runtime, warning printed; stale lock (>30 s) is reclaimed; fresh lock is respected.

---

### F4 — `outcomes.jsonl` has no rotation: after ~1 MiB / 1,000 records every task prints a recording failure forever — **P3**

**Where:** `src/memory/store.ts:7-9, 100-113, 165-170`; `app.ts:recordTaskOutcome`.

**Problem:** `MAX_RECORDS = 1000`, `MAX_FILE_BYTES = 1 MiB`, task text up to 4 KiB/record. Once full, `recordOutcome` throws → `[memory] Task outcome was not recorded (...)` on every task. `/memory outcomes` only shows the latest 20 anyway.

**Fix:** In `recordOutcome`, when appending would exceed either bound, drop the oldest *accepted-or-null* entries down to e.g. 800 (or rotate to `outcomes.<date>.jsonl`). Document the retention. Keep the 1 MiB read guard.

**Test:** seed 1,000 records, record one more → succeeds, oldest evicted, newest present.

---

### F5 — Every prompt zero-allocates 2 MiB for memory reads — **P3 (perf, trivial)**

**Where:** `src/memory/store.ts:133` `Buffer.alloc(MAX_FILE_BYTES + 1)` on each `read()`; called by `context()` and again by `recordOutcome → update → read` per task.

**Fix:** allocate `Math.min(info.size + 1, MAX_FILE_BYTES + 1)` (the file was already `fstat`-ed; the `+1` sentinel still detects growth), exactly as Phase 5 already did for LSP snapshots (`PHASE5_PERFORMANCE.md` §2).

---

### F6 — `ProjectModel.commands` accepts arbitrary keys from `project.yaml` `commands:` — **P3 (type/contract drift)**

**Where:** `src/config/load.ts:262-266` (`projectOverrides.commands` is `Record<string,string>`), merged at `src/project/model.ts:314` into a field typed `Partial<Record<ProjectCommand, string>>`.

**Problem:** `commands: { deploy: "rm -rf /" }` in project.yaml ends up in `model.commands`, is printed by `formatProjectContext` ("commands: ... deploy=rm -rf /") into the system prompt, and is stored in the cache. It is never executed by Casper (only `CHECK_NAMES` are), but the type lies and unknown commands reach the model as if Casper vetted them.

**Fix:** filter `commands` to `CHECK_NAMES` in `projectOverrides` (mirror `verificationCommands`), or add a diagnostic for unknown keys. Type `ProjectModelOverrides.commands` as `Partial<Record<ProjectCommand,string>>`.

---

### F7 — SIGINT exits the whole process instead of cancelling the current turn — **P3 (UX)**

**Where:** `src/cli.ts:66-88`.

**Problem:** In interactive mode Ctrl+C is exit-130. Every comparable coding CLI (including Pi itself) treats the first Ctrl+C as "abort the current model turn / check", second as exit. Given how much of Casper's value is the verification loop, users will want to abort a runaway repair without losing the session.

**Fix:** In `runInteractive`, install a per-prompt SIGINT handler: first press → `session.abort()` + `verificationAbort?.abort()` + `checkTask?.abort()`; second press within ~2 s or while idle → existing shutdown. Keep one-shot behaviour unchanged (tests depend on exit 130).

---

### F8 — CLI flag parsing only accepts leading flags; trailing/unknown flags become the prompt — **P3 (UX)**

**Where:** `src/cli.ts:100-108`.

`casper "fix it" --verify` sends `fix it --verify` to the model with no managed checks. `casper --verbose` sends `--verbose` as a prompt. Reject unknown `--flags` anywhere in argv; allow flags in any position or document "flags must come first" in `--help`.

---

### F9 — Runtime C compilation via `bun:ffi cc()` for writing visualization files — **P3 (complexity/portability)**

**Where:** `src/visualize/artifacts.ts:12-20`, `src/visualize/artifacts.c`.

**Problem:** To defend against a symlink swap of `~/.casper/visualizations/<project>/` (a TOCTOU inside the user's own home), Casper compiles C at runtime with TinyCC and uses raw `openat/mkdirat/unlinkat`. Costs: Windows is excluded (`throw` on other platforms), a compiler runs on first `/visualize repo`, `.c` files live in `src/`, and reviewers must audit FFI. The threat model is weak relative to the rest of Casper (native bash and Pi tools are unsandboxed anyway, per README).

**Options:** (a) keep but move under `src/native/` with a README, and make `visualize.outputDir: false` the default so the FFI path is opt-in; or (b) replace with `fs.open(dir, O_DIRECTORY)` + `realpath` check + `open(join(dir,name), O_CREAT|O_EXCL|O_NOFOLLOW)` + post-write `fstat` dev/ino comparison against the directory handle — the same race window exists but no compiler. Decide, then document in `VISUALIZATION.md`.

---

### F10 — `TaskClassification.verification` is dead data — **P3 (dead code)**

**Where:** `src/task/classify.ts:19, 39-45`. Never read outside the file (grep confirmed). It's labelled "legacy lexical hint" but still computed and typed publicly. Remove it (and the associated branches) to stop future agents from "using" it to select checks, which README explicitly forbids.

---

## 3. Performance optimizations (measured or high-confidence)

### O1 — Run the test suite in parallel: 117 s → 44 s (measured)

Bun runs test files serially in one process. All fixtures already use `mkdtemp` + `port: 0` + `HOME` overrides, and the 4-way parallel run passed 358/358.

```json
// package.json
"test": "bun test",
"test:fast": "ls tests/*.test.ts | xargs -P 4 -n 1 bun test",
"check": "bun run typecheck && bun run test:fast"
```

Better: a tiny `scripts/test-parallel.ts` that shards files by the measured durations above (put `phase9-learn`, `phase8-pi`, `phase7-sessions`, `phase5-lsp-real` in different shards) and aggregates pass/fail counts so `bun run check` still fails on any failure. Run it 5× to confirm no port/tmp flakes before adopting; keep serial `bun test` as the fallback documented in HANDOFF.

### O2 — Lazy-import the MCP SDK and ajv: −~85 ms on every local command

`src/mcp/manager.ts:1-5` and `src/capabilities/broker.ts:2` import the SDK statically; `app.ts` imports both. Servers start *disconnected* by design, so nothing needs the SDK until `/mcp connect` or `call_capability` validation. Convert to `await import(...)` inside `MCPManager.connect()`/the transport factory and inside the broker's validator creation (cache the module promise). Pi is already lazy (`app.ts:130`); this makes the whole "local commands need no heavy deps" story true. `/project` should drop from ~290 ms to ~200 ms.

### O3 — Parallelize startup discovery: −~30–60 ms

`CasperApp.start()` (`app.ts:169-174`) awaits inspect → context → skills → MCP → LSP → references sequentially, but `rebindWorkspace()` (`app.ts:642-650`) already uses `Promise.all` for the last four. Make `start()` match `rebindWorkspace()` (extract a shared `loadWorkspace(cwd)` helper — they duplicate ~20 lines).

### O4 — One `git` spawn instead of two in `inspectProject`: −~30 ms

`src/project/inspect.ts:27-28`. Use `git rev-parse --show-toplevel --abbrev-ref HEAD` (two output lines; map `HEAD` → `null` for detached) or run the two commands concurrently from `cwd` (git resolves from any subdirectory).

### O5 — Parallelize skill discovery: 132 ms → est. 30–50 ms

`src/skills/registry.ts:117-185`: ten roots walked serially; within a directory each entry is `stat`→`realpath`→`readSkillHeader` serially. Walk roots with `Promise.all` and per-directory entries with bounded concurrency (e.g. 8). Preserve deterministic ordering by sorting `entries` at the end (already done) and keeping the `seenFiles` dedupe — make it root-ordered (user → project → external) so canonical-path dedupe still prefers the earlier root; simplest is: walk each root fully in parallel into its own list, then merge in root order applying `seenFiles`.

### O6 — LSP `afterEdit` cost per native write

`src/lsp/manager.ts:254-266`: each `edit`/`write` runs `syncOpen` (re-snapshots every open doc, up to 100) and, if anything changed, `refreshReports` re-sends *all* documents and clears all diagnostics, then polls at 20 ms up to `timeoutMs` (10 s). With a slow server this adds up to 10 s per edit to the model loop. Phase 5 already optimized the batch path; two cheap additions: (1) make the post-edit wait budget separate and smaller (e.g. 2–3 s; a `timeout` status is already honest), (2) in `afterEdit` skip `refreshReports` when only the edited file changed and no other document is open. Measure with `scripts/benchmark-lsp.ts` before/after (ABBA, as in `PHASE5_PERFORMANCE.md`).

---

## 4. Architecture & maintainability

### A1 — `src/app.ts` (918 lines) is the god object

It owns: startup, REPL, 12 slash commands, runtime lifecycle, verification orchestration, session/worktree transitions, capability preparation, confirmations, event rendering, memory persistence, and receipts. Consequences already visible: 17 non-null assertions (`this.projectContext!`, `this.lsp!`…), duplicated workspace-load code (`start` vs `rebindWorkspace`), and a regex chain for command dispatch.

Suggested seams (each independently testable, no behaviour change):
- `src/app/commands.ts` — a `Map<string, CommandHandler>` with usage strings; gives F2's unknown-command rejection and a `/help` for free.
- `src/app/workspace.ts` — `loadWorkspace(cwd) → { context, registry, mcp, lsp, references, visualization, broker }` used by both `start` and `rebindWorkspace` (fixes O3 duplication).
- `src/app/receipt.ts` — `observedEdits/observedChecks/possibleMutations` + `handleRuntimeEvent` rendering.
- Keep `CasperApp` as the thin orchestrator; the `CasperAppOptions` test seams stay identical.

### A2 — Five hand-rolled JSONL/atomic-write stores

`memory/store.ts`, `learn/candidates.ts`, `skills/registry.ts` (trust store), `project/model.ts` (cache), `sessions/store.ts`. Each re-implements: nonblocking open, size guard, `O_NOFOLLOW`, temp+rename, mkdir-lock. Extract `src/state/store.ts` with `readBoundedFile`, `writeAtomic`, `withDirLock` (with stale-lock reclamation from F3). Then the next fix lands once.

### A3 — Profile-name validation ×3 (see F1). Same remedy: one function.

### A4 — Terminal-escaping helpers ×4

`terminalSafe` in `sessions/manager.ts`, `agents/manager.ts`; `safe` in `task/result.ts`; `formatTerminalJSON` in `tui/json.ts`; an inline regex in `app.ts:handleMemoryCommand`. Slightly different character classes each. Consolidate into `src/tui/escape.ts`.

### A5 — No lint/format configuration

`package.json` has no `lint` script, so Casper's own `/verify lint` is a permanent skip (exit 2) and `--verify` tasks on this repo can never be "complete". Add at minimum `"lint": "tsc --noEmit -p tsconfig.json --strict"`-equivalent or (preferably) `oxlint`/`biome` with a minimal config, plus a `.casper/project.yaml` in the repo declaring `verify:` and `verification.scopes` — Casper should dogfood its own scoped-freshness feature. Also add `noUnusedLocals`/`noUnusedParameters`/`noImplicitOverride`/`exactOptionalPropertyTypes` to `tsconfig.json` and see what falls out.

### A6 — Test fixture duplication

The scripted-OpenAI-SSE Pi fixture (`models.json` + `settings.json` + `Bun.serve` + `stream()/answer()/calls()`) is copy-pasted in 5 files (`phase4-app`, `phase5-app`, `phase8-pi`, `phase9-learn`, `phase9-references-app`). Move to `tests/fixtures/pi-local-provider.ts`. Same for the CLI `run()` helper with kill-timer.

---

## 5. Documentation

- **README.md is 28 KB**; the "Verification and repair" section alone is ~2,000 words of dense contract prose (freshness/aliases/symlinks). Move the contract detail into `docs/CODING_LOOP_EVIDENCE_CONTRACT.md` (which already exists) and leave a 10-line summary + link. New users need "how do I run it" in the first screen.
- **37 docs, many historical** (`PHASE*_REVIEW.md`, `*_IMPLEMENTATION.md`, `CODING_LOOP_*`). Add `docs/README.md` index with two headings: *Current contracts* (LSP, MCP, SESSIONS, VISUALIZATION, REFERENCES, LEARNING, EVIDENCE_CONTRACT, HANDOFF) and *Historical evidence* (everything else). Agents keep re-reading historical reviews as if they were live instructions — HANDOFF already warns about this.
- `HANDOFF.md` cites `/tmp/...` evidence paths extensively; these will not survive a reboot. Either copy the key logs to `docs/reviews/` or mark the section "may be absent".
- README "Current scope" still says "Phases 0–8; Phase 9 started" — align with HANDOFF's Phase 9 status.
- Help text (`cli.ts:printHelp`) and README command lists are maintained separately; generate one from the other (A1 command table) or at least add a test that every `/command` in `printHelp` is dispatched by `handlePromptCommand`.

---

## 6. Things checked and found sound (so agents don't re-audit them)

- `verify/command.ts`: process-group kill on POSIX, head/tail output bounding, `close` ordering, cancellation before spawn. OK.
- `verify/task.ts` + `workspace-state.ts`: heavily tested (11+ symlink/alias regressions); no new defect found. Do not reopen without a concrete repro (HANDOFF says the same).
- `runtime/pi.ts`: read-only child limits (`tool_call` block + `shouldStopAfterTurn`), in-memory settings for children, `noSkills` override, writable-state preflight. OK.
- `agents/manager.ts`: concurrency reservation before runtime load, cleanup grace, byte bounds, surrogate handling. OK.
- `lsp/manager.ts` rename: snapshot → plan → approve (cloned) → re-validate under locks → commit → two-phase diagnostics. OK.
- `sessions/manager.ts` / `worktree.ts`: hooks disabled via `core.hooksPath=/dev/null`, patch identity by SHA-256 shown at approval and re-captured after verification. OK.
- No `any`, no TODO/FIXME, `.DS_Store` untracked, `git diff --check` clean.

---

## Follow-up implementation status

First bounded batch implemented locally, uncommitted:

- **O1:** Added `scripts/test-parallel.ts` and `bun run test:fast`: four workers,
  longest known files first, isolated processes, grouped diagnostics and file-level
  pass/fail totals. A regression checks failure propagation and remaining queued
  work. Five initial full runs passed in **44–45 s** each; a subsequent full
  typecheck/parallel gate also passed. A later parallel gate failed the existing
  `CLI termination cleans up a running verifier process group` test: its `leaked`
  marker existed after SIGTERM. Isolated rerun passed. Cause remains unresolved;
  **parallel mode stays opt-in and `bun run check` remains serial**. No cleanup
  contract or deadline was weakened.
- **F2:** Shared CLI/app help in `src/tui/help.ts`; `/help` stays local, `/exit`
  and `/quit` are successful one-shot no-ops, unknown slash commands throw before
  classification/runtime/memory work. `runOnce` trims input like CLI/interactive
  input. Six public-app regressions failed before the fix and now pass; additional
  real CLI coverage checks help parity and exit codes. Local commands clear the
  previous task receipt and do not record outcomes or initialize the runtime.
- Final `bun run check`: **366 pass, 0 fail, 2,326 assertions**, TypeScript clean,
  serial suite **121.33 s**. `git diff --check` passed. Temporary red/parallel/
  isolated/serial logs: `/tmp/casper-review-validation/` (may be absent later).
- Existing learning changes, native bash, command runner, runtime adapter and
  dependency pins were preserved. No live-model calls, commits or pushes.
  This is same-agent validation, not independent acceptance.

Second bounded batch: **F1 implemented locally, uncommitted.**

- Reproduced project `profile: ../../evil` loading an outside `rules.md` as
  `profileRules`. The cause was unchecked profile selection before path joining.
- `src/config/profile.ts` supplies one predicate for policy, MCP, LSP and reference
  loaders. Names are 1–64 ASCII letters/digits/underscores/dots/hyphens, beginning
  with a letter or digit. Policy loading rejects every invalid supplied candidate,
  even when overridden; no trimming or non-string fallback. Selection precedence
  remains option → environment → project → global → default. Direct discovery
  retains its existing skip-invalid-profile behavior.
- README Configuration explicitly retains project selection of user profiles,
  including reference sources and MCP/LSP metadata, with existing connection
  consent unchanged. This is lexical validation, not symlink confinement.
- Two permanent public-loader regressions in `tests/review-config.test.ts` failed
  before the fix and pass afterward. They cover traversal, malformed values at
  each selection layer, overridden invalid values, length/character boundaries,
  and matching profile-file provenance across all four loaders.
- Serial `bun run check`: **368 pass, 0 fail, 2,461 assertions**, TypeScript clean,
  **120.18 s** test-runner time. `git diff --check` passed. Full gate log:
  `/tmp/casper-f1-check.log` (may be absent later). Same-agent validation only;
  no live-model calls, commits or pushes. Prior uncommitted work preserved.

Third bounded batch: **F3 optional-facts fallback and F5 implemented locally,
uncommitted. F3 lock reclamation and F4 retention remain unimplemented.**

- Reproduced a corrupt facts file blocking `CasperApp.runOnce()` before the runtime
  prompt. The app now warns and continues without the entire facts block when
  `ProjectMemory.context()` fails. The warning is fixed text, not raw filesystem
  errors or stored content. Explicit `/memory` commands still fail closed; no
  facts are reset, repaired, partially admitted or cached for fallback.
- Measured the old allocation through the real store read: an 84-byte file used
  a 1,048,577-byte buffer. The corrected read allocates 85 bytes. This establishes
  allocation reduction, not measured end-to-end latency improvement.
- Buffers use `min(fstat size + 1, MAX_FILE_BYTES + 1)`. Filling the sentinel buffer
  rejects growth; merely retaining the old `count > MAX_FILE_BYTES` guard would
  risk accepting a truncated valid JSONL prefix. A controlled real append after
  fstat tests this new conservative behavior. Reads remain non-atomic.
- Four permanent tests added in `tests/phase9-memory.test.ts`: app fallback and
  recovery (including malformed/schema/oversized/invalid-UTF-8/symlink cases),
  measured allocation, controlled growth, and empty/exact-byte/record bounds.
  The first three were red before the correction; growth rejection is a new
  safeguard for smaller buffers, not a demonstrated old truncation defect.
  Existing concurrent-writer, FIFO, evidence and acceptance tests remain green.
- Focused suite: **13 tests / 158 assertions**, passing. Serial `bun run check`:
  **372 pass, 0 fail, 2,528 assertions**, TypeScript clean, **121.07 s**. Diff check
  passed. Logs: `/tmp/casper-memory-followup-{red,check}.log` (may be absent later).
  Same-agent validation only; no live-model calls, commits or pushes.

Fourth bounded batch: **memory self-review and F6 implemented locally,
uncommitted.**

### Memory review — Standards

Reviewed the latest F3/F5 hunks in `src/app.ts`, `src/memory/store.ts` and
`tests/phase9-memory.test.ts`, plus their README/Phase 9 contract changes. Baseline:
`c8df223`, restricted to those memory-follow-up hunks rather than unrelated
uncommitted work. No repository coding-standards file was found; applied the
report's standing constraints and the code-review smell baseline. **No actionable
Standards finding.** Small app-level fallback preserves the storage module's
fail-closed interface; no store abstraction or unrelated refactoring was added.

### Memory review — Spec

Spec: F3/F5 above, narrowed by the agreed non-destructive follow-up contract.
**No reproduced Spec defect within that scope.** Added passing controls for
context-budget overflow (structurally valid facts remain locally inspectable),
runtime failure after fallback (still failed/unaccepted), and shutdown during a
failed facts read (no late runtime, warning or outcome). Locks and retention remain
explicitly deferred, not represented as complete. Memory suite: **14 tests / 177
assertions**. Single-agent Standards/Spec review, not independent acceptance;
no parallel review-agent tool was available.

### F6 continuation

- Reproduced unknown `commands:` keys appearing in formatted project context,
  including `deploy=UNSUPPORTED_DEPLOY`. YAML command overrides now retain only
  string-valued `CHECK_NAMES`; `ProjectModelOverrides.commands` uses
  `Partial<Record<ProjectCommand, string>>`. Existing `verify:` precedence and
  stricter validation are unchanged. Unknown keys are ignored, not executed.
- A permanent public-context regression failed before the fix and now passes:
  flat/nested YAML, unknown and wrong-case keys, non-string values, detected
  command fallback, explicit verification override, prompt output and persisted/
  reopened cache. README Configuration documents the contract. This is filtering
  YAML metadata, not validation of shell-command safety or an arbitrary cache/
  untyped-caller audit.
- Focused config/memory suites: **22 tests / 355 assertions**. Serial
  `bun run check`: **374 pass, 0 fail, 2,559 assertions**, TypeScript clean,
  **119.95 s**. `git diff --check` passed. Logs: `/tmp/casper-f6-red.log` and
  `/tmp/casper-memory-review-f6-check.log` (may be absent later). No live-model
  calls, commits or pushes; all previous uncommitted work preserved.

Fifth bounded batch: **O2 implemented locally, uncommitted.**

- `src/mcp/manager.ts` loads the SDK client and needed transport only for approved
  connections. Close/disconnect/deadline guards after imports prevent late
  transport creation. Direct stdio handles retain existing TERM/KILL cleanup
  without a runtime class import during local-only close.
- `src/capabilities/broker.ts` loads/caches the validator module on first use;
  compiled validators remain capability-revision-local. Cancellation and catalog
  identity are rechecked before confirmation across the new first-use await.
  The pinned MCP client itself imports Ajv on connect; this does not defer Ajv
  beyond every connection or eliminate its cost.
- Paired fresh-process benchmark (five ABBA blocks, ten samples per variant):
  `/project` median **143.769 → 92.494 ms** (~36% lower), app import **91.370 →
  36.954 ms**, and **81 → 0 MCP/Ajv modules** after local app import. Isolated HOME,
  empty cached fixture project, one unconnected synthetic definition, same
  dependencies. No general real-project/model-speed claim. Permanent ordered
  samples, reproduction and limits: [O2 benchmark](benchmarks/STARTUP_O2.md).
- Eleven fresh-process tests added in `tests/mcp-lazy-startup.test.ts`: local
  commands avoid imports, cold approved connection works, target validation
  remains active, client/transport load cancellation cannot spawn children, and
  validator load cancellation/refresh cannot ask for stale approval or invoke.
  The eager-import tracer was red before edits. Delay-boundary cases enforce
  safeguards required by the new asynchronous behavior, not old production bugs.
- One initial focused gate failed the existing concurrent cancelled-call cleanup
  test because each newly compiled capability unnecessarily awaited an already
  loaded module. Caching the resolved module removed that warm-path yield. The
  existing test passed unchanged; no cleanup deadline or assertion was weakened.
- Serial `bun run check`: **385 pass, 0 fail, 2,570 assertions**, TypeScript clean,
  **118.00 s**. `git diff --check` passed. Temporary logs:
  `/tmp/casper-o2-{red,focused,check}.log` (may be absent later). No live-model calls,
  production MCP connections, commits or pushes. Same-agent validation only.

Sixth bounded batch: **O3 implemented locally, uncommitted.**

- `src/app.ts` uses one private `loadWorkspace()` for startup and rebinding.
  Inspection/context loading remain ordered; skill/MCP/LSP/reference discovery
  runs concurrently afterward. Shared initialization follows successful discovery
  and a shutdown check. Startup retains its banner/diagnostic order; rebinding
  retains capability revocation, runtime context append and fresh connection
  consent. No broader A1 decomposition or lifecycle redesign was added.
- Four public-app tests cover dependency ordering, all-loader overlap, delayed
  publication, diagnostics, rejection/retry, shutdown and invalid context. Two
  scheduling/failure tracers were red before the change; both existing-behavior
  controls passed. Existing named-session/reference rebinding tests pass unchanged.
- Paired fresh-process `/project`: **99.530 → 97.690 ms median**, with overlapping
  ranges. **No material speedup established; no 30–60 ms saving claimed.** The
  deterministic benefit is shared loading and removal of serial waits. Both
  variants still load zero MCP/Ajv modules on local startup. Full ordered samples,
  O3-only reconstruction diff and limits: [O3 benchmark](benchmarks/STARTUP_O3.md).
- Focused suites: **39 tests / 253 assertions**. Serial `bun run check`: **389 pass,
  0 fail, 2,599 assertions**, TypeScript clean, **118.66 s**. Diff check passed.
  Logs: `/tmp/casper-o3-{red,focused,check}.log` (may be absent later). Same-agent
  validation only; no live-model/production MCP calls, commits or pushes.
- Read failures may settle before already-started sibling reads; `Promise.all`
  handles their rejections but does not cancel/drain filesystem work. No metadata
  snapshot or new shutdown-draining guarantee. Shutdown prevents late publication.

**Subsequent direction: optimization paused; one approved acceptance trial executed.**
O4 remains unimplemented in the original working tree, but a disposable candidate
and unapplied patch now exist. See [trial 01](acceptance/TRIAL_01.md) and the retained
[plan](ACCEPTANCE_TRIAL.md). One Codex-subscription task, fixed medium effort,
286.10 s, no model rerun/host code repair. Candidate behavior controls and the host
serial gate passed (**398 tests / 2,609 assertions**, 120.49 s); the live task itself
exited 1 because its managed full suite timed out at the existing 120-second check
limit. The 10-minute outer task timeout was not reached. Do not conflate those gates.

The original source/auth/settings were unchanged at the end-of-run audit, and
temporary credentials were removed. The patch stays unapplied pending a decision.
Ordinary Git starts fall 2 → 1, but unborn rises 2 → 3 and non-Git 1 → 2; review
those costs rather than claiming universal startup improvement. Independent Phase 9
review and promotion remain pending; no Phase 10 readiness claim.

The trial's first **serial** isolated baseline also reproduced the SIGTERM cleanup
`leaked` marker failure. Two other baseline failures were due to a harness-forced
profile override; removing that override yielded a clean 389-test baseline. The
cleanup failure is still unresolved and is not attributed to the profile setting
or diagnosed as parallel-only. No cleanup assertion or deadline was weakened.

**Still-pending decision: F3 lock ownership/recovery and F4 outcome retention.** Existing
locks are not stolen; full stores still refuse writes with the existing warning.
Agree explicit recovery/retention semantics before changing stored state. The
report's age/PID heuristic and deletion proposals are not validated algorithms;
legacy locks contain no owner metadata. No shared-store extraction was needed
for this batch. Diagnose the observed parallel cleanup failure before making the
fast runner the default.

## 7. Suggested execution order for agents

Each item is independently shippable with its own regression test; run `bun run check` (or the parallel variant after O1) after each.

1. **O1** parallel test runner — everything after this iterates 2.6× faster.
2. **F2** unknown-command rejection + `/help` (prevents accidental model spend during the rest of this work).
3. **F1** shared profile-name validation (small, security-adjacent, four call sites).
4. **F3 + F4 + F5** memory store: degrade gracefully, stale-lock reclaim, rotation, right-sized buffer — ideally via **A2** extraction.
5. **O2 + O3 + O4 + O5** startup: lazy MCP SDK, parallel discovery, single git spawn, parallel skill walk. Measure with a fresh-process timer before/after (ABBA, 10 samples), record in `docs/benchmarks/`.
6. **F6, F10** small contract cleanups.
7. **A5** lint + dogfood `.casper/project.yaml`.
8. **A1** split `app.ts` (behaviour-preserving; existing integration tests are the safety net).
9. **F7, F8** CLI UX.
10. **F9** decide on FFI; **§5** docs consolidation.

Suggested agent prompt:

> Read docs/DEBUG_OPTIMIZATION_REVIEW.md §0 and item <N>. Reproduce the issue with the listed command first, write the regression test red, then fix. Do not touch src/verify/command.ts, src/runtime/pi.ts (except where the item names it), dependency versions, or the repair-loop ownership. Run `bun run check`, then `git diff --check`. Do not commit.
