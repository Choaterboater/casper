# Casper code deep dive and debugging report

Date: 2026-10-06  
Status: report only; application code was not changed.

## Executive summary

Six defects were reproduced through Casper's real change-detection and verification functions. The most important problems are misleading verification signals: independent acceptance can report a pass without executing its generated test, and a smoke check can pass a full-body regular expression after the mismatching response tail has been discarded.

The other findings concern missed test-runner changes, skipped checks on case-insensitive filesystems, invisible executable-bit changes, and proof copies that break relative dependency symlinks.

**This is not a clean bill of health or a release approval.** Typecheck and lint passed. The full test run was stopped after extensive failures on a heavily loaded shared host. Focused existing tests also encountered failures; one passed when isolated with more time, while another remained unresolved. Those failures are reported separately rather than being counted as additional confirmed code defects.

## Scope and evidence boundaries

- Read `CONTEXT.md`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`, ADR 0001, and the previous pre-release review.
- Examined task execution, receipts, snapshots, verification selection, check execution, proof copying, independent acceptance, test-definition tracking, smoke checks, services, session persistence, worktrees, configuration, spend limits, and update handling.
- Concentrated executable probes on change detection and verification, where the implementation must support Casper's evidence-first receipt contract.
- Used temporary local fixtures and the real production functions. The acceptance completion was a deterministic fake; no paid model or live provider was needed.
- Reproduced six cases using a temporary test file. Its final run reported **0 pass, 6 fail, 9 assertions**, in **19.46 seconds**. These are deliberately failing assertions for the desired behavior, not six newly broken existing tests.
- Removed that temporary test from the repository after preserving the harness in the local session artifacts and in this report's appendix.

The checkout was not frozen. HEAD advanced from `fbfdfef3` to `99039987` while the review ran. The intervening commits changed CI cancellation behavior and the shell read-only allow-list, not the production files supporting the six findings. Typecheck and lint were rerun after that change. The full-suite run is therefore not a certified result for one immutable revision.

No Windows/Linux native run, compiled-release run, paid-model acceptance trial, real device operation, or dedicated exploit-focused security audit was performed. Findings below establish the stated function-level behavior; broader end-to-end impacts are identified as consequences, not falsely presented as live trials.

## Findings ranked by repair priority

Severity is functional impact, not a CVSS or exploitability rating. High means a misleading evidence result or a significant verification-contract defect; Medium means missed checks, misleading change reporting, or a supported-workflow failure.

| Priority | Finding | Severity | Source | Reproduced signal |
| --- | --- | --- | --- | --- |
| 1 | AUDIT-05: acceptance passes without running the generated test | High | `src/verify/acceptance.ts:123-125` | `status: "pass"`, generated test not loaded, direct execution of that test exits 1 |
| 2 | AUDIT-06: truncated response passes a full-body regex | High | `src/services/smoke.ts:116-120`; `src/services/tool.ts:30-39` | Matcher returns `pass: true`, although the complete body does not match |
| 3 | AUDIT-03: retargeted runner symlink does not change the test definition | High | `src/verify/test-definition.ts:192-198` | Definition-change list remains empty after the runner target changes |
| 4 | AUDIT-02: case aliases cause auto verification to skip covered changes | Medium | `src/verify/mode.ts:120-127` | Same filesystem directory; planner returns `run: []`, `skipped: "not-covered"` |
| 5 | AUDIT-01: executable-bit changes disappear from workspace diffs | Medium | `src/task/changes.ts:132-146` | `chmod 0644 -> 0755` produces no modified paths |
| 6 | AUDIT-04: proof copies break relative dependency symlinks | Medium | `src/verify/proof.ts:98-104,153-162` | Real workspace check exits 0; proof returns `unavailable` because its current copy cannot pass |

### 1. AUDIT-05: independent acceptance reports a pass without executing its test

**Actual behavior.** A valid shell-chain test command:

```sh
bun test tests/existing.test.ts && true
```

is extended by concatenating the generated path:

```sh
bun test tests/existing.test.ts && true ./tests/casper-acceptance-<id>.test.ts
```

The path becomes an argument to `true`, not to Bun's test runner. The existing test passes, `true` exits 0, and acceptance reports a pass.

**Evidence.** The generated test writes a sentinel at module load and contains a deliberately failing assertion. Running that file directly exits 1. Running it through `independentAcceptance` with the shell-chain command produces:

```json
{"status":"pass","usage":null,"generatedTestRan":false,"directGeneratedTestExit":1}
```

This occurred in two controlled runs. An earlier attempt timed out and was not accepted as proof of the defect.

**Cause.** `independentAcceptance` appends a filename to an arbitrary shell command and interprets exit 0 as evidence that the generated tests passed. It does not establish that the runner loaded the file.

**Impact.** The optional independent-acceptance feature can emit a positive signal without checking the request. Its passing receipt text can be misleading. This does not demonstrate that ordinary baseline verification or change proof also passed in a complete Casper task.

**Recommended correction.** Use an explicit runner invocation that actually targets the generated file. Support known runner forms and return an explicit acceptance error for unsupported compound commands; do not guess where to insert a filename. Where available, record structured runner evidence identifying the generated test.

**Regression requirement.** A generated failing test must not report a pass with a compound command, a filtered runner, or a command that ignores the appended filename. Retain coverage for direct Bun and Python runner forms and package-manager argument forwarding.

### 2. AUDIT-06: body truncation can turn a failing smoke assertion into a pass

**Actual behavior.** A response contains 65,536 `a` characters followed by `X`. The expectation is `^a+$`. The complete response fails that expression. `readBody` discards the final `X` at its 64 KiB limit and sets `complete: false`; `matchSmoke` tests only the retained prefix and returns a pass.

**Evidence.**

```json
{"pass":true,"complete":false,"originalMatches":false}
```

The probe uses a real `Response` and the real `readBody` and `matchSmoke` functions. It reproduced on all three probe runs.

**Cause.** The regular-expression branch applies the expression to the truncated string without qualifying a successful match. Truncation is mentioned only when the expression fails.

**Impact.** A configured smoke check can count a partial-body match as evidence through `SmokeChecks.result` (`src/services/smoke.ts:220-223`). End anchors and other whole-body expectations can pass incorrectly. The established defect is in response handling and matching; the probe did not start a managed HTTP server.

**Recommended correction.** Do not treat an arbitrary regex pass on an incomplete body as a complete-body pass. Return a clear incomplete/matching-unavailable result for body expectations on truncated input. If prefix-only assertions are wanted, give them explicit semantics rather than silently treating the truncated prefix as the whole response.

**Regression requirement.** Exercise the body reader and matcher together with a passing 64 KiB prefix and a failing tail. Also test a complete small body, status/header-only checks on large bodies, and cancellation.

### 3. AUDIT-03: test-definition tracking ignores a runner symlink's target

**Actual behavior.** `scripts/check.js` initially links to `strict.js`, then is retargeted to `other.js`. The command is `bun scripts/check.js`. The definition includes the runner entry, but changing the link target produces no definition change.

**Evidence.**

```text
AUDIT-03 observed: [] runnerRecorded=true
```

The controlled probe first asserts that `scripts/check.js` was recorded. That rules out a parser miss as the explanation for this result.

**Cause.** `readText` returns `link:${relative}` for any symlink. This identifies the link's pathname, which did not change, rather than its destination or executable content.

**Impact.** The guard intended to recognize changes to the meaning of the test command can miss a runner retarget. Task execution relies on `definitionChanges` before deciding whether to permit proof and acceptance (`src/app/task-run.ts:324-349`). The definition-detection miss was reproduced; a complete false-Verified task was not.

**Recommended correction.** At minimum, include the link destination in the definition identity. If its actual runner content cannot be observed safely and within bounds, report the definition as unavailable rather than claiming it is unchanged. Do not blindly follow arbitrary external symlinks while collecting prompt or verification data.

**Regression requirement.** Cover a changed link destination, a changed referent with the same link destination, a broken link, and the existing ordinary script-file cases.

### 4. AUDIT-02: automatic check selection disagrees with filesystem identity

**Actual behavior.** On this host, `src` and `SRC` resolve to the same directory. A check declares inputs `["SRC"]`, while the actual edited path is `src/index.ts`. The planner excludes the test.

**Evidence.**

```json
{"run":[],"skipped":"not-covered"}
```

The probe separately confirms that both directory spellings resolve to the same filesystem path. This is a real host reproduction, not an assumption that every filesystem is case-insensitive.

**Cause.** `planAutoChecks` uses literal string equality and prefix comparisons. It lacks the alias-aware treatment already present in `editAffects` (`src/verify/task.ts`).

**Impact.** A configured check can be skipped on case-insensitive macOS or Windows filesystems even though its scope covers the changed file. The receipt can say that no configured check covers the change. This particular case does not reproduce on a case-sensitive volume.

**Recommended correction.** Give selection the workspace context needed to resolve path identity, and share the existing conservative scope semantics. Unknown identity should not prove that a check is unaffected. Avoid blanket lowercasing: that would create incorrect matches on case-sensitive volumes.

**Regression requirement.** Cover real case aliases where the host supports them, injected cross-platform identity cases, ancestor edits, missing paths, and exclusions. Keep genuinely unrelated paths skippable.

### 5. AUDIT-01: chmod-only edits are invisible to snapshot comparisons

**Actual behavior.** A script changes from mode 0644 to 0755 without changing its bytes. The before/after snapshots produce:

```json
{"added":[],"modified":[],"removed":[]}
```

**Cause.** A normal file's snapshot identity is only its content hash. For large files it is size and modification time. Neither representation includes its executable mode.

**Impact.** A meaningful script change can be reported as no files changed and skip the automatic checks, since the app derives `changedPaths` from these snapshots. The probe establishes the snapshot miss. It does not claim that the separate Git-based undo store also loses executable modes; that subsystem has its own tree entries.

**Recommended correction.** Include the executable bits, or the documented relevant mode subset, in file identity. Keep the bounded streaming hash and no-follow protections.

**Regression requirement.** Changing a script from non-executable to executable and back must appear as a modification on POSIX. Unchanged content and mode must remain unchanged. Explicitly define the behavior on Windows.

### 6. AUDIT-04: relative dependency links break in change-proof copies

**Actual behavior.** The workspace's `node_modules` links to `../deps`. Its real check passes after the source changes from `old` to `new`. The proof step cannot validate the current comparison copy:

```text
AUDIT-04 original workspace exit: 0
```

```json
{"status":"unavailable","check":"test","reason":"test does not pass in a copy of the workspace, so Casper cannot compare with and without the change"}
```

**Cause.** `cloneTree` collects dependency locations in its directory branch. A dependency location that is itself a symlink takes a different branch: its relative link text is copied unchanged, and the location is not added to the dependency-link list. In a relocated copy, `../deps` no longer names the original dependency directory. `linkDependencies` therefore never replaces that link with a usable workspace dependency link.

**Impact.** A correct, testable change can remain unproven in a workspace using a shared relative dependency link. This is an availability/compatibility problem, not a reproduced false-positive verification result.

**Recommended correction.** Handle recognized dependency symlinks as dependency locations as well as directories, then link them consistently in both comparison copies. Preserve the existing restrictions on parent traversal and on mutation of linked environments.

**Regression requirement.** Verify the same source change with a physical dependency directory, an absolute dependency symlink, a relative dependency symlink, and a broken link. Unsupported links must receive an explicit unavailable reason, not a misleading generic test failure.

## Existing checks and unresolved failures

| Command | Observed result |
| --- | --- |
| `bun --version` | `1.4.0` |
| `bun run check` | Typecheck and lint passed; full test phase was stopped, not completed |
| `bun run typecheck && bun run lint` | Passed again after the concurrent revision change |
| `bun test tests/audit-deep-dive.tmp.test.ts` | Final probe: 0 pass, 6 intentionally failing regressions, 9 assertions, 19.46 s |
| `bun test tests/test-definition.test.ts tests/smoke.test.ts tests/change-proof.test.ts tests/acceptance.test.ts` | 36 pass, 2 fail, 1 unhandled error; 160 assertions; 111.58 s |
| `bun test --timeout 60000 tests/change-proof.test.ts tests/acceptance.test.ts -t 'a failure without the change that is a crash\|tests that pass the change make the check pass'` | 1 pass, 1 fail, 20 filtered; 59.76 s |

The `\|` in the last table cell is Markdown escaping. The actual command's filter was:

```sh
bun test --timeout 60000 tests/change-proof.test.ts tests/acceptance.test.ts \
  -t 'a failure without the change that is a crash|tests that pass the change make the check pass'
```

### Full-suite run was not a usable baseline

Before stopping, its log contained **1,177 lines beginning with `(pass)`, 242 beginning with `(fail)`, and 15 beginning with `(skip)`**. These are incomplete log observations, not final test-run totals. Examples included service-readiness timeouts, verification command timeouts, and 30-second test timeouts.

At one diagnostic observation, the shared host had a one-minute load average of **48.64**, 917 processes, and 89 processes whose command names matched Bun, Node, or Python. This establishes substantial host load; it does not prove that load caused every failed test. No unrelated process was terminated.

The broad run was stopped to avoid continuing a high-failure, resource-intensive run on the shared machine. Do not turn its 242 failure lines into 242 diagnosed application bugs or claim the suite passed.

### Two existing focused-test failures

1. **Acceptance success test:** `tests/acceptance.test.ts:60-63` timed out at 5 seconds in the four-file run. Isolated with `--timeout 60000`, it passed in 39.42 seconds. This proves sensitivity to the run's timing environment; it is not sufficient evidence for a production acceptance defect or a fully diagnosed flake.
2. **Crash-evidence proof test:** `tests/change-proof.test.ts:65-75` expected `proven` but received `unavailable`, both in the focused run and when isolated. The runs took approximately 20.15 and 20.14 seconds, close to the proof helper's 20-second command limit. The precise internal reason was not captured by that existing assertion. Its root cause remains unresolved; increasing the outer test timeout did not settle it.

The initial dependency-copy probe also encountered command timeouts. Its final reproduction used a shell-only check and obtained the explicit current-copy failure shown in AUDIT-04, with the real-workspace control passing. This separates the reported dependency-link defect from the timing problem.

### Behaviors deliberately not reported as new bugs

- Weak without-change proof evidence such as a crash is already explicitly represented and tested. This review does not silently reinterpret that intentional contract.
- Acceptance errors not downgrading a proven task are covered by existing tests. That policy may deserve discussion, but it is not the unexecuted-test defect reported here.
- A large tree making proof unavailable is a documented bound, not itself a defect.
- Historical findings in `docs/PRE_RELEASE_REVIEW.md` were not counted again without a new reproduction.

## Suggested repair sequence

1. Correct acceptance execution and truncated smoke matching first. Both can manufacture positive evidence without the corresponding behavior being checked.
2. Repair runner-definition identity before expanding proof or acceptance support.
3. Align auto-check scope selection with the existing filesystem-aware invalidation rules.
4. Include meaningful executable modes in snapshots, then handle dependency symlinks in proof copies.
5. Investigate the unresolved crash-evidence test with a dedicated timing/reason-capturing harness. Rerun the complete suite on a stable host and fixed revision before release.

For each application fix, first add the relevant failing case at the existing test seam, then demonstrate red-to-green. None of these fixes was applied during this report-only investigation.

## Appendix: reproducible audit harness

Save the following as `tests/audit-deep-dive.tmp.test.ts` in the checkout, then run:

```sh
bun test tests/audit-deep-dive.tmp.test.ts
```

At the reviewed revision, all six desired-behavior assertions fail. AUDIT-02 applies only when the fixture volume supports case aliases; its non-applicable branch logs that limitation rather than proving a fix. The harness uses POSIX `test` and `grep` for AUDIT-04, so that case needs an equivalent command before using this harness natively on Windows.

Use a quiet host. The fixture checker timeouts are 20 seconds; an overloaded host can produce an inconclusive timeout rather than the meaningful copy-failure or false-pass signals. The generated fixtures are cleaned in `afterEach`, and the proof baseline is disposed in `finally`. Remove the temporary repository test after use.

```ts
import { afterEach, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { snapshotTree, diffSnapshots } from "../src/task/changes";
import { planAutoChecks } from "../src/verify/mode";
import { ChangeBaseline } from "../src/verify/proof";
import { definitionChanges, testDefinition } from "../src/verify/test-definition";
import { independentAcceptance } from "../src/verify/acceptance";
import { matchSmoke } from "../src/services/smoke";
import { readBody } from "../src/services/tool";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-audit-"));
  roots.push(root);
  return root;
}
const bun = JSON.stringify(process.execPath);

test("AUDIT-01 chmod-only edits must appear in the change list", async () => {
  const root = await fixture();
  const file = path.join(root, "run.sh");
  await writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  const before = await snapshotTree(root, undefined, { git: false });
  await chmod(file, 0o755);
  const changes = diffSnapshots(before, await snapshotTree(root, undefined, { git: false }));
  console.log("AUDIT-01 observed:", JSON.stringify(changes));
  expect(changes.modified).toContain("run.sh");
});

test("AUDIT-02 auto-check selection must cover filesystem case aliases", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "index.ts"), "export const n = 1;\n");
  const actual = await realpath(path.join(root, "src"));
  const alias = await realpath(path.join(root, "SRC")).catch(() => undefined);
  if (alias !== actual) {
    console.log("AUDIT-02 not applicable: case-sensitive filesystem");
    return;
  }
  const planned = planAutoChecks({ commands: { test: "bun test" }, scopes: { test: { inputs: ["SRC"] } }, changedPaths: ["src/index.ts"] });
  console.log("AUDIT-02 observed:", JSON.stringify(planned), "sameFilesystemDirectory=true");
  expect(planned.run).toContain("test");
});

test("AUDIT-03 switching a runner symlink must change the test definition", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "strict.js"), "process.exit(1);\n");
  await writeFile(path.join(root, "scripts", "other.js"), "process.exit(0);\n");
  const link = path.join(root, "scripts", "check.js");
  await symlink("strict.js", link);
  const command = "bun scripts/check.js";
  const before = await testDefinition(root, command);
  expect(before.has("scripts/check.js")).toBe(true);
  await unlink(link);
  await symlink("other.js", link);
  const changed = definitionChanges(before, await testDefinition(root, command));
  console.log("AUDIT-03 observed:", JSON.stringify(changed), "runnerRecorded=true");
  expect(changed).toContain("scripts/check.js");
});

test("AUDIT-04 proof copies must retain a relative dependency symlink", async () => {
  const outer = await fixture();
  const root = path.join(outer, "repo");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"));
  await mkdir(path.join(outer, "deps"));
  await writeFile(path.join(outer, "deps", "marker"), "dependency\n");
  await symlink("../deps", path.join(root, "node_modules"), "dir");
  await writeFile(path.join(root, "src", "value.js"), "old\n");
  await writeFile(path.join(root, "tests", "check.js"), 'const fs = require("fs"); fs.readFileSync("node_modules/marker"); process.exit(fs.readFileSync("src/value.js", "utf8").trim() === "new" ? 0 : 1);\n');
  const before = await snapshotTree(root, undefined, { git: false });
  const baseline = await ChangeBaseline.capture(root);
  try {
    await writeFile(path.join(root, "src", "value.js"), "new\n");
    const control = Bun.spawnSync([process.execPath, "tests/check.js"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    console.log("AUDIT-04 original workspace exit:", control.exitCode);
    expect(control.exitCode).toBe(0);
    const proof = await baseline.prove({ root, changes: diffSnapshots(before, await snapshotTree(root, undefined, { git: false })), check: "test",
      command: "test -f node_modules/marker && grep -q new src/value.js", timeoutMs: 20000 });
    console.log("AUDIT-04 observed:", JSON.stringify(proof));
    expect(proof?.status).toBe("proven");
  } finally { await baseline.dispose(); }
});

test("AUDIT-05 acceptance must not pass when the generated test never runs", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "tests"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "value.ts"), "export const value = 0;\n");
  await writeFile(path.join(root, "tests", "existing.test.ts"), 'import { test, expect } from "bun:test"; test("existing", () => expect(true).toBe(true));\n');
  const generated = 'import { writeFileSync } from "node:fs"; import { test, expect } from "bun:test"; writeFileSync("acceptance-ran", "yes"); test("requested behavior", () => expect(0).toBe(1));\n';
  const controlFile = path.join(root, "tests", "control.test.ts");
  await writeFile(controlFile, generated);
  const control = Bun.spawnSync([process.execPath, "test", controlFile], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(control.exitCode).toBe(1);
  await unlink(controlFile);
  await unlink(path.join(root, "acceptance-ran"));
  const result = await independentAcceptance({
    complete: async () => ({ text: `\`\`\`ts\n${generated}\`\`\``, usage: null }),
    request: "Return one instead of zero",
    root, changes: { added: [], modified: ["src/value.ts"], removed: [] },
    files: await snapshotTree(root, undefined, { git: false }),
    testCommand: `${bun} test tests/existing.test.ts && true`,
    timeoutMs: 20000,
  });
  const executed = await access(path.join(root, "acceptance-ran")).then(() => true, () => false);
  console.log("AUDIT-05 observed:", JSON.stringify({ ...result, generatedTestRan: executed, directGeneratedTestExit: control.exitCode }));
  expect(result.status).not.toBe("pass");
});

test("AUDIT-06 a truncated response must not pass a full-body anchored regex", async () => {
  const response = new Response("a".repeat(65536) + "X");
  const read = await readBody(response);
  const result = await matchSmoke({ bodyMatches: "^a+$" }, { status: 200, headers: new Headers(), body: read.bytes.toString("utf8"), complete: read.complete });
  console.log("AUDIT-06 observed:", JSON.stringify({ ...result, complete: read.complete, originalMatches: /^a+$/.test("a".repeat(65536) + "X") }));
  expect(result.pass).toBe(false);
});
```
