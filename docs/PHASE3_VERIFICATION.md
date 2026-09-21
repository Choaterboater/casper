# Phase 3 — Verification and Repair

## Delivered scope

- `src/verify/registry.ts`: small verifier registry and project-native typecheck/lint/test/build command adapters.
- `src/verify/command.ts`: sequential shell execution at the project root, bounded head/tail capture, timeout/cancellation, and structured execution failures.
- `src/verify/evidence.ts`: per-check evidence, report status, and concise terminal formatting.
- `src/verify/repair-loop.ts`: bounded repair via a callback to the existing runtime boundary, targeted reruns, and full selected-suite regression gates.
- `src/app.ts`, `src/cli.ts`: `/verify`, `/verify repair`, opt-in `--verify`, lazy runtime startup, programmatic reports, meaningful exit codes, and termination cleanup.
- Configuration: project-local `verify:` command overrides; layered `verification.timeoutMs` and `repair.maxAttempts`.

Pi remains behind the unchanged runtime adapter. No new dependencies, MCP, LSP, subagents, database, or later-phase features were added.

## Execution decision

Verification commands execute repository code. Phase 3 does not add a persisted repository-trust subsystem or silently authorize commands from YAML. `/verify` is explicit permission to execute checks; `/verify repair` additionally permits model-assisted edits. `--verify` opts a one-shot task or interactive session into automatic post-task verification/repair for tasks selected by the existing classifier. Defaults preserve the prior prompt behavior.

This consent boundary applies to Casper's deterministic verifier, not to the runtime's existing tools. Those tools remain unsandboxed. Project policy and repair constraints are prompt guidance, not enforced filesystem restrictions.

## Verification

`bun run check`:

```text
TypeScript passed
41 tests passed
0 failed
225 assertions
```

`git diff --check`: passed.

Automated coverage includes:

- canonical command precedence, cache invalidation, layered limits, invalid configuration;
- command cwd, stdout/stderr, nonzero exits, missing executables, spawn failures;
- bounded noisy output, intact UTF-8 capture across head/tail boundaries, timeout cleanup of child processes, cancellation;
- missing-check skips and incomplete reports;
- real failing Bun test → evidence-driven fixture repair → targeted and full reruns;
- repair introducing a regression in a previously passing gate;
- frozen command selection, default three-attempt limit, zero attempts, runtime failures;
- registry duplicate rejection and explicit check ordering;
- local commands without model startup, opt-in automatic checks, session reuse;
- app shutdown during initial prompts/startup, abort-error disposal, cancellation during repair startup, and CLI SIGTERM process-group cleanup;
- explicit repair objectives independent of prior requests and a CLI exit deadline for stalled runtime startup;
- real CLI success/failure/incomplete exit codes.

The automated repair tests use an injected runtime/callback to make deterministic edits. The following smoke additionally used the real Pi adapter and a live model.

## Live CLI/Pi smoke

Environment: Bun 1.4.0, pinned Pi SDK 0.85.1, GitHub Copilot `gpt-5.4`, macOS. Used a temporary project and isolated HOME/Pi session/config directories. A temporary mode-0600 auth copy was removed after the run; real user skill trust/config was not changed.

Fixture:

```ts
// sum.ts — intentionally broken
export function sum(a: number, b: number): number { return a - b; }
```

```ts
// sum.test.ts
import { expect, test } from "bun:test";
import { sum } from "./sum";
test("adds two numbers", () => {
  expect(sum(2, 3)).toBe(5);
  expect(sum(-2, 3)).toBe(1);
});
```

Project config:

```yaml
verify:
  test: bun test
repair:
  maxAttempts: 2
```

Project rule: repair only `sum.ts`; preserve its exported API; do not change tests or verification configuration; do not commit.

Ran Casper from that project:

```bash
bun /path/to/Casper/src/cli.ts "/verify repair test"
```

Latest post-review repeat, with all fixes applied (runtime tool stream omitted):

```text
> /verify repair test
✗ test  bun test  (exit 1; 54ms)
↻ repair 1/2
✓ test  bun test  (exit 0; 169ms)
✓ test  bun test  (exit 0; 54ms)
Verification pass: 1 pass, 0 fail, 0 skip; 1 repair attempt(s).
```

CLI exit: **0**.

The saved Pi session confirmed that the repair prompt contained the actual failing command `bun test`, cwd, exit code 1, original request, project constraints, Git changed-file context, and the exact captured diagnostic:

```text
Expected: 5
Received: -1
.../sum.test.ts:3:52
0 pass
1 fail
```

Pi changed only the implementation from `a - b` to `a + b`. Casper independently reran the failed check, then the complete selected suite (also `test` in this fixture). The test/config/rule files remained unchanged. A separate final `bun test` passed: **1 test, 2 assertions**.

This was a real model-assisted repair, not a model claim substituted for verifier evidence.

## Intentional limits

- Checks are shell commands, not language-specific diagnostic parsers. The shell is the platform's (`sh` on macOS/Linux, `cmd.exe` on Windows — see [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md)), so a POSIX-only pipeline in a check only works on a POSIX host. No sandbox, dependency installer, persistent trust store, or permission broker.
- Settings and command discovery are loaded at startup. The selected command strings stay frozen through repair, but the scripts/configuration those commands execute can still be modified by the model; preventing test weakening remains prompt guidance.
- Missing commands stay skips; an explicitly selected subset only proves that subset. No overall success when a selected check is skipped.
- Each stream retains 8 KiB of original output bytes plus a truncation marker. Large middle sections are discarded, not persisted as raw artifacts. Reports/history live in memory; normal Pi conversation persistence may retain injected failure evidence.
- Git changed-file context is best-effort and may include pre-existing user changes. It is bounded to 16 KiB; unavailable context is reported explicitly.
- Repair prompts are bounded in count, not by a separate model wall-clock/token deadline. Per-command timeouts do not govern Pi's own tools. CLI termination signals allow up to one second of graceful cleanup before forced exit; programmatic `app.close()` itself can still wait for stalled runtime startup/abort.
- POSIX process-group timeout/cancellation cleanup is tested. Windows direct-process fallback is not validated; escaped/daemonized processes are outside this cleanup guarantee.
- Task classification is still lexical. Use explicit `/verify` when automatic selection is insufficient.
- Independent standards/spec reviews and targeted debug/performance checks are recorded in `docs/PHASE3_REVIEW.md`. Passing review and tests is evidence, not a claim of zero defects.
