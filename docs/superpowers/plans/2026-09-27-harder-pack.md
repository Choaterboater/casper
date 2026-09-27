# Harder Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A frozen `harder` eval pack of 6 tasks that Pi fails 25-60% of the time, and a pre-registered run
that decides whether `verification.checklist` becomes Casper's default.

**Architecture:** Each task is a solved fixture (`evals/fixtures/<name>/`, reference solution plus hidden
`acceptance/` tests) and a setup overlay (`evals/setups/<name>/`) that turns it into a failing stub. Tasks are
registered in `evals/packs.ts` as `HARDER_PACK` and exposed through the existing benchmark CLI
(`bun tools/eval.ts --pack harder`). Nothing in `src/` changes.

**Tech Stack:** Bun 1.4, TypeScript, `bun:test`. No new dependencies.

**Spec:** docs/superpowers/specs/2026-09-27-harder-pack-design.md

## Global Constraints

- 6 tasks, pack id `harder`, task ids `harder-<name>`; every fixture and setup is new (no reuse).
- **30-35 stated cases per task; 35 is a hard ceiling** (the checklist keeps at most 40, `CASE_COUNT` in
  src/task/checklist.ts).
- **Every case is stated in the prompt**, in prose paragraphs, never as a numbered or bulleted list.
  `CONTEXT.md` holds project rules only (file layout, error class, no dependencies, tests in `tests/`).
- **One hidden test per stated case**, named after the case; no hidden test checks anything the prompt does not
  state. Case numbers below map 1:1 to hidden tests.
- Several deliberate departures from a well-known convention per task, each stated plainly (marked **[D]** below).
- Single module per task, deterministic: no network, no real timers, no dependence on the host time zone or locale.
- Prompts end with the shared `RULES` constant in `evals/packs.ts` and never mention `acceptance/`.
- Fixture `package.json`, `.casper/project.yaml` and `CONTEXT.md` follow `evals/fixtures/rate-limiter/` exactly
  in shape (see Task 1, Step 1).
- Calibration runs Pi only. Band: 25-60% not accepted across the pack. At most 2 rounds.
- Decision rule: casper-checklist not-accepted ≤ 2/3 × Pi's, and casper-checklist median wall time and median
  tokens each ≤ 1.25× Pi's.
- Bug rule: a wrong hidden test, a grader/harness fault, or a harness failing for non-model reasons in ≥ 5% of
  its runs stops the run; fix, record, rerun every harness from scratch.
- Models: `openrouter/z-ai/glm-5.3-flash --route Together` and
  `openrouter/deepseek/deepseek-v4.1-flash --route DeepSeek,Together`; `--time-limit 600`.
- Runs launch from this worktree (the only checkout with the pack), output under
  `/Users/stephenchoate/Documents/Casper/.scratch/harder/`. Never touch the main checkout's uncommitted edits.

## Review Focus

1. **A hidden test asserts something the prompt does not say** (a message wording, an order, a default). Expected:
   every assertion traces to a prompt sentence. Pinned by each fixture task's Step 7 trace table and the
   reviewer's prompt-only read (Step 8).
2. **Host time zone or locale changes a result** (cron, dates, sorting). Expected: identical results anywhere.
   Pinned by running each fixture's hidden tests under `TZ=Pacific/Chatham LANG=tr_TR.UTF-8` in Step 6.
3. **A task drifts past 35 or below 30 cases while being edited during calibration.** Expected: every harder
   task has 30-35 hidden tests. Pinned by the count test added in Task 1.
4. **The stub or visible tests give the answer away** (a stub comment stating a case the prompt does not, or a
   visible test covering a hidden case). Expected: stub types and doc comments restate prompt facts only; visible
   tests cover 2-3 basic-path cases. Pinned by Step 8's review checklist.
5. **Two readings of the prompt are both reasonable** and the hidden test picks one. Expected: each case has one
   reading. Pinned by Step 8: a reviewer who sees only the prompt predicts 5 hidden results; any mismatch is
   rewritten in the prompt.

---

## Fixture task template (Tasks 2-7)

Every fixture task follows these steps. Each task below gives its fixture name, API, stub signature, visible
tests and the numbered case list; the steps refer to them.

- **Step 1: Scaffold the fixture.** Create `evals/fixtures/<fixture>/package.json`, `.casper/project.yaml` and
  `CONTEXT.md` as in Task 1 Step 1's templates, with the task's name, one-line description and conventions.
- **Step 2: Write the hidden tests.** `evals/fixtures/<fixture>/acceptance/<module>.test.ts`: one `test()` per
  numbered case, titled with the case number and a short name (`"07 [D] backslash escapes a quote inside quotes"`),
  asserting exactly that case with the concrete values given.
- **Step 3: Run them against nothing.** `bun test ./acceptance` in the fixture. Expected: FAIL (module missing).
- **Step 4: Write the reference solution** in `src/<module>.ts` until `bun test ./acceptance` passes.
- **Step 5: Write the visible tests** `tests/<module>.test.ts` (the 2-3 basic-path tests listed for the task);
  `bun test ./tests` passes on the reference.
- **Step 6: Robustness.** In the fixture: `TZ=Pacific/Chatham LANG=tr_TR.UTF-8 bun test ./acceptance` passes.
  Then break the reference one case at a time for at least 8 cases (including every [D] case): each break fails
  exactly that case's test and no other. Undo each break. Record which cases were checked in the commit message.
- **Step 7: Write the setup.** `evals/setups/<setup>/remove.json` = `["acceptance/"]`;
  `evals/setups/<setup>/files/src/<module>.ts` = the stub (exported types and signatures, every body
  `throw new Error("not implemented")`, doc comments that restate only prompt facts). Write the prompt (prose,
  every case in order, ends with `RULES`) and a trace table in the commit message: `case → test title → prompt
  sentence`.
- **Step 8: Register and review.** Add the task to `HARDER_PACK` in `evals/packs.ts` (template in Task 1) and
  run `bun test tests/eval-packs.test.ts tests/eval-suite.test.ts`. Expected: PASS. A reviewer reads only the
  prompt, predicts the hidden result for 5 cases picked at random, and checks Review Focus items 1, 4 and 5;
  any mismatch is fixed in the prompt (not by weakening the test).
- **Step 9: Commit** fixture, setup and pack entry together:
  `git add evals/fixtures/<fixture> evals/setups/<setup> evals/packs.ts tests/eval-packs.test.ts && git commit`.

---

### Task 1: Register the `harder` pack

**Files:**
- Modify: `evals/runner.ts:50` (`EvalPack`)
- Modify: `evals/packs.ts` (append `HARDER_PACK`)
- Modify: `evals/tasks.ts:1,212-216` (import, spread, `BENCHMARK_PACKS`)
- Modify: `tools/eval.ts:48` (help text)
- Test: `tests/eval-packs.test.ts:20-31`

**Interfaces:**
- Produces: `export const HARDER_PACK: readonly EvalTask[]` in `evals/packs.ts`; `EvalPack` includes
  `"harder"`; `BENCHMARK_PACKS` is `["core", "network", "hard", "harder"]`; `packTasks("harder")`.

- [ ] **Step 1: Note the fixture templates** (used by Tasks 2-7; copied from `evals/fixtures/rate-limiter/`):

`package.json`:
```json
{
  "name": "fixture-<fixture>",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.4.0",
  "scripts": {
    "test": "bun test"
  }
}
```

`.casper/project.yaml`:
```json
{
  "verify": {
    "test": "bun run test"
  },
  "verification": {
    "scopes": {
      "test": {
        "inputs": [
          "src",
          "tests"
        ]
      }
    }
  }
}
```

`CONTEXT.md`:
```markdown
# <fixture>

<one-line description>

## Conventions

- <the module> lives in `src/<module>.ts`.
- <the task's error-class rule>
- Tests live in `tests/`. No runtime dependencies.
```

- [ ] **Step 2: Write the failing test.** In `tests/eval-packs.test.ts`, replace the first test's pack
  assertions and add a case-count test:

```ts
/** Harder tasks built so far; Tasks 2-7 each raise it by one, ending at 6. */
const HARDER_BUILT = 0;

test("the benchmark has 9 core, 9 network, 6 hard and 6 harder tasks, each on its own fixture except the two notes-api tasks", () => {
  expect(BENCHMARK_PACKS).toEqual(["core", "network", "hard", "harder"]);
  expect(packTasks("core")).toHaveLength(9);
  expect(packTasks("network")).toHaveLength(9);
  expect(packTasks("hard")).toHaveLength(6);
  expect(packTasks("harder")).toHaveLength(HARDER_BUILT);
  expect(new Set(benchmark.map((task) => task.fixture)).size).toBe(23 + HARDER_BUILT);
  // (the rest of the existing test body unchanged)
});

test("every harder task states 30-35 cases: one hidden test each, under the checklist's 40-case cap", async () => {
  for (const task of packTasks("harder")) {
    const dir = path.join(repoRoot, "evals/fixtures", task.fixture, "acceptance");
    let count = 0;
    for (const file of await readdir(dir)) if (file.endsWith(".test.ts")) count += ((await Bun.file(path.join(dir, file)).text()).match(/^test\(/gm) ?? []).length;
    expect({ task: task.id, count, inRange: count >= 30 && count <= 35 }).toEqual({ task: task.id, count, inRange: true });
  }
});
```

- [ ] **Step 3: Run it.** `bun test tests/eval-packs.test.ts -t "harder"`. Expected: FAIL
  (`BENCHMARK_PACKS` lacks `"harder"`; `packTasks("harder")` is a type error or empty).

- [ ] **Step 4: Implement.**
  - `evals/runner.ts:50`: `export type EvalPack = "core" | "network" | "hard" | "harder";`
  - `evals/packs.ts`, after `HARD_PACK`:
    ```ts
    /** Tasks for confirming the request checklist against Pi (docs/superpowers/specs/2026-09-27-harder-pack-design.md):
     * 30-35 cases per task, all stated in the prompt as prose, several deliberate departures from a well-known
     * convention, one hidden test per case. Calibrated on Pi only. */
    export const HARDER_PACK: readonly EvalTask[] = [];
    ```
  - `evals/tasks.ts`: import `HARDER_PACK`; add `...HARDER_PACK,` after `...HARD_PACK,`;
    `BENCHMARK_PACKS = ["core", "network", "hard", "harder"]`.
  - `tools/eval.ts:48`: `--pack <core|network|hard|harder>`.

- [ ] **Step 5: Run.** `bun test tests/eval-packs.test.ts tests/eval-suite.test.ts && bun run typecheck`.
  Expected: PASS.

- [ ] **Step 6: Commit.** `git commit -am "Eval: register an empty harder pack and its 30-35 case bound."`

Pack entry template for Tasks 2-7 (append to `HARDER_PACK`, then raise `HARDER_BUILT` by one):
```ts
  task({
    id: "harder-<name>", pack: "harder", fixture: "<fixture>", setup: "<setup>",
    prompt: "<prose stating every case, in case order>" + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("<module>-in-place", { changed: ["src/<module>.ts"] })],
  }),
```

---

### Task 2: `harder-csv-reader`

Fixture `csv-reader`, setup `add-csv-reader`, module `src/csv.ts`.

**API:** `readCsv(text: string, options?: CsvOptions): { rows: (string[] | Record<string, unknown>)[]; problems: { line: number; column: number; message: string }[] }`
with `CsvOptions = { delimiter?: string; quote?: string; header?: boolean; trim?: boolean; comment?: string; columns?: Record<string, "number" | "boolean" | "date"> }`.
Invalid options throw `RangeError`; everything about the text is a problem, never a throw.

**Visible tests:** plain rows split on `,` and `\n`; a quoted field containing a comma; `header: true` gives objects.

**Cases:**
1. Rows end at `\n` or `\r\n`.
2. **[D]** A lone `\r` is ordinary data (`"a\rb,c"` → `[["a\rb", "c"]]`).
3. Fields split on `delimiter`, default `,`.
4. `delimiter` must be one character other than the quote, `\n` or `\r`: RangeError `invalid delimiter`.
5. `quote` (default `"`) must be one character other than the delimiter, `\n` or `\r`: RangeError `invalid quote`.
6. A quoted field may contain the delimiter and newlines.
7. A doubled quote inside a quoted field is one quote character.
8. **[D]** Inside a quoted field, `\` before the quote character is a literal quote and `\\` is one backslash; elsewhere a backslash is literal.
9. **[D]** A quote character inside an unquoted field is literal (`ab"c` → `ab"c`).
10. Text between a closing quote and the next delimiter or row end: problem `text after closing quote` at that text's column; the field keeps the quoted content.
11. A quote still open at the end of input: problem `unterminated quote` at the opening quote's line and column; that row is dropped.
12. Empty input gives no rows and no problems.
13. A newline at the very end does not add a row.
14. **[D]** Lines that are empty or only spaces and tabs are skipped anywhere (not rows with one empty field).
15. With `comment: "#"`, a line whose first character is `#` is skipped; one with spaces before `#` is a row.
16. A comment character inside a quoted multi-line field is data.
17. `trim` (default false): when true, spaces and tabs around unquoted fields are removed.
18. With `trim: true`, whitespace outside a quoted field is ignored and whitespace inside it is kept.
19. With `trim: false`, whitespace before an opening quote makes the whole field unquoted and literal (` "a"` → ` "a"`).
20. A leading byte-order mark (U+FEFF) is ignored.
21. `header: true`: the first row (after skipped lines) names the columns and every later row is an object.
22. Header names are always trimmed, even with `trim: false`.
23. **[D]** A repeated header name gets `_2`, `_3`, ... in order (`a,a,a` → `a`, `a_2`, `a_3`).
24. An empty header name becomes `column<N>`, N its 1-based position.
25. **[D]** With a header, a row with fewer fields sets the missing columns to `null`, with no problem.
26. With a header, a row with more fields: problem `too many fields` at the first extra field's column; the extra fields are dropped and the row is kept.
27. Without a header, rows may differ in length with no problem.
28. `line` is the 1-based physical line where the row starts, counting newlines inside quoted fields; `column` is the 1-based character position in that line.
29. `columns` without `header: true` throws RangeError `columns requires header`; a `columns` key not in the header is a problem `unknown column <name>` at the header's line, column 1.
30. `number`: after trimming, `-?digits(.digits)?` where **[D]** `_` may separate digit groups (`1_000` → 1000); `1e3`, `0x10`, `.5` and `5.` are problems `not a number in column <name>`.
31. `boolean`: `true`/`false`/`yes`/`no`/`1`/`0`, case-insensitive; anything else is a problem `not a boolean in column <name>`.
32. `date`: a real calendar date `YYYY-MM-DD` stays the same string; `2023-02-29` is a problem `not a date in column <name>`.
33. A typed column's empty value is `null`; a value that fails conversion stays the original string in the row.
34. Problems are ordered by line, then column.

- [ ] Steps 1-9 of the fixture task template.

---

### Task 3: `harder-cron-next`

Fixture `cron-next`, setup `add-cron-next`, module `src/cron.ts`.

**API:** `nextRun(expression: string, after: Date): Date`, `nextRuns(expression: string, after: Date, count: number): Date[]`,
`class CronError extends Error { field: "minute" | "hour" | "day" | "month" | "weekday" | "year" | null }` (in the stub).
All times UTC.

**Visible tests:** `* * * * *` gives the next minute; `0 12 * * *` the next noon.

**Cases:**
1. Fields are separated by one or more spaces or tabs; whitespace at the ends is ignored.
2. Five fields: minute (0-59), hour (0-23), day of month (1-31), month (1-12), weekday (0-7, 0 and 7 are Sunday).
3. **[D]** An optional sixth field is the year (1970-2199), with the same syntax.
4. Any other field count: CronError `expected 5 or 6 fields, got <n>` with `field` null.
5. `*` matches every value.
6. Lists `1,5,10`; repeated values are allowed.
7. Ranges `1-5`.
8. **[D]** A range whose start is above its end wraps around (`22-2` in hours is 22, 23, 0, 1, 2; `FRI-MON` is Fri to Mon).
9. Steps `*/15` and `10-50/20`.
10. **[D]** `a/n` means from `a` to the field's maximum in steps of n (`5/15` minutes is 5, 20, 35, 50).
11. A step of 0 or a non-number step: CronError `<field>: invalid step`.
12. Month names `JAN`-`DEC` and weekday names `SUN`-`SAT`, any case, also in ranges and lists.
13. A value outside the field's range: CronError `<field>: <value> out of range <min>-<max>`.
14. Any other token: CronError `<field>: invalid token "<token>"`.
15. `?` means `*` in the day-of-month and weekday fields only; elsewhere it is an invalid token.
16. **[D]** When both day of month and weekday are restricted, a day must match both (not either).
17. When only one of them is restricted, only that one applies.
18. `L` in day of month is the month's last day.
19. `<weekday>L` in the weekday field is the month's last such weekday (`5L` = last Friday).
20. `L` anywhere else is an invalid token.
21. The result is strictly after `after`; a time equal to `after` does not count.
22. Seconds and milliseconds of `after` are ignored for matching; the result has seconds and milliseconds 0.
23. Everything is in UTC whatever the process time zone.
24. The search crosses month and year ends.
25. `0 0 29 2 *` finds the next 29 February, even four years ahead.
26. **[D]** When nothing matches within 8 years after `after` (or after the year field's last year), CronError `never runs` with `field` null.
27. An invalid `after` (Invalid Date) throws RangeError.
28. `nextRuns` returns `count` successive runs; `count` must be an integer from 1 to 1000, otherwise RangeError.
29. Macros `@hourly`, `@daily`, `@weekly` (Sunday 00:00), `@monthly`, `@yearly` and `@annually`.
30. An unknown macro: CronError `unknown macro <macro>` with `field` null.
31. `field` names the field of a field error: `minute`, `hour`, `day`, `month`, `weekday` or `year`.

- [ ] Steps 1-9 of the fixture task template.

---

### Task 4: `harder-semver-range`

Fixture `semver-range`, setup `add-semver-range`, module `src/semver.ts`.

**API:** `parse(version: string): { major: number; minor: number; patch: number; prerelease: (string | number)[]; build: string[] }`,
`compare(a: string, b: string): -1 | 0 | 1`, `satisfies(version: string, range: string, options?: { includePrerelease?: boolean }): boolean`,
`maxSatisfying(versions: string[], range: string): string | null`, `minSatisfying(...)`, `sort(versions: string[]): string[]`,
`class SemverError extends Error` (in the stub).

**Visible tests:** `parse("1.2.3")`; `compare("1.2.3", "1.10.0")` is -1; `satisfies("1.2.3", ">=1.0.0")`.

**Cases:**
1. A version is `MAJOR.MINOR.PATCH` of non-negative integers without leading zeros (`01.2.3` is invalid).
2. A leading `v` or `=` and surrounding whitespace are accepted.
3. A prerelease `-id.id` has identifiers of letters, digits and `-`; numeric identifiers have no leading zeros (`1.0.0-01` invalid) and parse as numbers.
4. Build metadata `+id.id` is parsed into `build` and ignored in comparisons.
5. An invalid version in `parse` or `compare`: SemverError `invalid version "<text>"`.
6. `compare` orders by major, minor, patch numerically.
7. A prerelease is lower than the same release.
8. Prerelease identifiers compare one by one: numbers numerically, strings by ASCII, a number lower than a string, and a shorter list lower when all its identifiers are equal (`1.0.0-alpha < -alpha.1 < -alpha.beta < -beta < -beta.2 < -beta.11 < -rc.1 < 1.0.0`).
9. Comparators `<`, `<=`, `>`, `>=`, `=`, and a bare version meaning `=`.
10. **[D]** `!=` excludes exactly that version.
11. Whitespace between an operator and its version is allowed (`>= 1.2.3`).
12. Comparators separated by whitespace must all hold; `||` separates alternatives.
13. `*`, `x`, `X` and an empty range match any release.
14. `1.x`, `1.2.*`, `1` and `1.2` are x-ranges (`1.2` means `>=1.2.0 <1.3.0`).
15. Partial versions after operators: `>1.2` is `>=1.3.0`, `>=1.2` is `>=1.2.0`, `<1.2` is `<1.2.0`, `<=1.2` is `<1.3.0`.
16. A hyphen range `A - B` (spaces required) includes both ends.
17. A partial right end of a hyphen range is an x-range bound (`1.2 - 2.3` is `>=1.2.0 <2.4.0`); a partial left end is zero-filled.
18. Tilde: `~1.2.3` is `>=1.2.3 <1.3.0`, `~1.2` is `<1.3.0`, `~1` is `<2.0.0`.
19. Caret: `^1.2.3` is `>=1.2.3 <2.0.0`.
20. **[D]** Caret never pins the minor or patch below 1.0.0: `^0.2.3` is `>=0.2.3 <1.0.0` and `^0.0.3` is `>=0.0.3 <1.0.0`.
21. A prerelease version satisfies a range only when one of that alternative's comparators has a prerelease with the same major, minor and patch (`1.2.4-beta` does not satisfy `>=1.2.3`; `1.2.3-beta.2` satisfies `>=1.2.3-beta.1`).
22. `includePrerelease: true` drops that rule.
23. An invalid range: SemverError `invalid range "<range>"`; an empty side of `||` is invalid.
24. **[D]** `satisfies` with an invalid version returns false instead of throwing.
25. `maxSatisfying` returns the highest satisfying version exactly as given in the list, or null.
26. `minSatisfying` returns the lowest, or null.
27. **[D]** `maxSatisfying` and `minSatisfying` skip invalid versions in the list instead of throwing.
28. `sort` returns a new list in ascending order and does not change its input.
29. `sort` keeps the input order of versions that compare equal (different build metadata).
30. **[D]** `sort` puts invalid versions last, in their input order.

- [ ] Steps 1-9 of the fixture task template.

---

### Task 5: `harder-url-router`

Fixture `url-router`, setup `add-url-router`, module `src/router.ts`.

**API:** `class Router { add(method: string, pattern: string, name: string): void; match(method: string, path: string): Match; list(): string[] }`,
`type Match = { status: 200; route: string; name: string; params: Record<string, string> } | { status: 204 | 405; allow: string[] } | { status: 400 | 404 }`,
`class RouteError extends Error` (in the stub).

**Visible tests:** a static route matches; `/users/:id` gives `params.id`; an unknown path is 404.

**Cases:**
1. Static segments match exactly and case-sensitively.
2. `:name` matches one non-empty segment into `params.name`.
3. A param name is `[A-Za-z_][A-Za-z0-9_]*`; any other name: RouteError `invalid param name`.
4. **[D]** `:name<int>` matches only ASCII digits and `:name<slug>` only lowercase letters, digits and `-`; the value stays a string; another type: RouteError `unknown param type <type>`.
5. `:name?` is optional and allowed only as the last segment (RouteError `optional param must be last`); when absent the key is missing from `params`.
6. `*` or `*name` as the last segment matches the rest of the path, possibly empty, into `params["*"]` or `params.name`, without a leading slash; elsewhere RouteError `wildcard must be last`.
7. A pattern must start with `/`: RouteError `pattern must start with /`.
8. **[D]** Precedence is decided segment by segment from the left, not by registration order: static, then typed param, then param, then optional param, then wildcard.
9. Between routes of equal precedence, the one added first wins.
10. The same method and pattern twice, ignoring param names (`/a/:x` and `/a/:y`): RouteError `duplicate route`.
11. **[D]** A trailing slash on the request path is ignored (`/users/` matches `/users`), except the root `/`.
12. **[D]** Repeated slashes in the request path count as one.
13. The query string and fragment are ignored.
14. Param values are percent-decoded after matching (`%20` is a space).
15. An encoded slash `%2F` stays inside its segment and decodes to `/` in the param value.
16. Static segments match their decoded form (`/caf%C3%A9` matches `/café`).
17. Invalid percent-encoding (`%zz`, or bytes that are not UTF-8) is `{ status: 400 }`.
18. A request path not starting with `/` is `{ status: 400 }`.
19. Methods are case-insensitive and stored upper-case.
20. **[D]** An `ANY` route matches every method, but a route for the exact method on the same pattern wins.
21. `HEAD` uses the `GET` route when no `HEAD` route matches.
22. When the path matches a route but not for this method: `{ status: 405, allow }`.
23. `allow` is sorted, includes `HEAD` whenever `GET` is allowed, and always includes `OPTIONS`.
24. **[D]** `OPTIONS` on a matching path with no `OPTIONS` route is `{ status: 204, allow }`.
25. No route matches the path: `{ status: 404 }`.
26. A match returns `route` as the pattern was registered and `name` as given.
27. `params` holds only named params (and `*` for an unnamed wildcard).
28. **[D]** `list()` returns `"<METHOD> <pattern>"` for every route, in precedence order (ties in the order added).
29. Precedence applies across different lengths: `/a/:x` beats `/a/*` for `/a/b`, and `/a/*` matches `/a/b/c`.
30. A typed param that does not match falls through to the next candidate route (`/n/:id<int>` then `/n/:name` for `/n/abc`).

- [ ] Steps 1-9 of the fixture task template.

---

### Task 6: `harder-invoice-totals`

Fixture `invoice-totals`, setup `add-invoice-totals`, module `src/invoice.ts`.

**API:** `totalInvoice(invoice: Invoice): InvoiceTotals` with
`Invoice = { currency: string; taxRate?: string; pricesIncludeTax?: boolean; discount?: { percent?: string; amount?: string }; lines: Line[] }`,
`Line = { id: string; quantity: string; unitPrice: string; taxRate?: string; discount?: { percent?: string; amount?: string }; discountable?: boolean }`,
`InvoiceTotals = { lines: { id: string; subtotal: string; discount: string; net: string; tax: string; total: string }[]; subtotal: string; discount: string; net: string; tax: string; total: string; taxes: { rate: string; net: string; tax: string }[] }`,
`class InvoiceError extends Error { issues: { path: string; message: string }[] }` (in the stub). Currencies in
`src/currencies.ts` (fixture code, not to be changed): USD 2, JPY 0, BHD 3.

**Visible tests:** one USD line with no tax or discount; one line with a 10% tax rate.

**Cases:**
1. Amounts are decimal strings and all arithmetic is exact (no floating point), including amounts above 2^53 minor units.
2. Every output amount has exactly the currency's number of decimal places.
3. A zero result is never printed negative (`0.00`, not `-0.00`).
4. `quantity` is a decimal with at most 3 decimal places.
5. **[D]** `unitPrice` may have up to 4 decimal places, whatever the currency.
6. A line's subtotal is quantity × unit price, rounded once to the currency's minor unit (never the unit price first).
7. **[D]** Rounding is half to even everywhere (`0.125` USD → `0.12`, `0.135` → `0.14`).
8. A line discount is `percent` (0-100, at most 2 decimal places) of the subtotal or a fixed `amount`.
9. A line discount with both `percent` and `amount`: issue `discount: use percent or amount, not both`.
10. A line `amount` discount larger than the subtotal: issue `discount: exceeds subtotal`.
11. Line discounts apply before the invoice discount.
12. The invoice discount (`percent` or `amount`) is shared over the lines in proportion to each line's amount after its own discount.
13. The shared discount is split in minor units by largest remainder, ties to the earlier line, so the line shares add up exactly to the invoice discount.
14. **[D]** Lines with `discountable: false` take no share of the invoice discount.
15. A line's net is its subtotal minus both discounts.
16. A line's tax rate is its own `taxRate`, else the invoice's `taxRate`, else `0`; a rate is a percent with at most 3 decimal places.
17. Tax-exclusive prices (default): a line's tax is net × rate, rounded per line.
18. **[D]** Tax is rounded per line, never on the invoice total.
19. With `pricesIncludeTax: true`, a line's net is its discounted amount ÷ (1 + rate), rounded, and its tax is the discounted amount minus that net.
20. A line's total is net + tax.
21. The invoice's `subtotal`, `discount`, `net`, `tax` and `total` are the sums of the line values.
22. `taxes` groups lines by rate, sorted by rate ascending, with each group's net and tax.
23. A 0% rate appears in `taxes` like any other.
24. `taxes` shows each rate in its shortest decimal form (`"7.5"`, `"20"`, `"0"`).
25. **[D]** A negative quantity (a return) is allowed; its line takes no discount of either kind.
26. The invoice total may be negative.
27. Output lines keep the input order and their `id`.
28. An unknown currency: issue `currency: unknown currency <code>`.
29. No lines: issue `lines: at least one line`.
30. A percent above 100 or below 0: issue `<path>: percent out of range`.
31. All problems are collected and thrown together as one `InvoiceError`, whose `issues` are in input order with paths such as `lines[2].quantity`.
32. A malformed amount (`1.2.3`, `abc`, a leading `+`, whitespace) or too many decimal places: issue `<path>: invalid amount`.

- [ ] Steps 1-9 of the fixture task template.

---

### Task 7: `harder-text-wrap`

Fixture `text-wrap`, setup `add-text-wrap`, module `src/wrap.ts`.

**API:** `wrap(text: string, width: number, options?: { tabWidth?: number; hangingIndent?: number; maxLines?: number }): string`.

**Visible tests:** a sentence wrapped at 20; a single word shorter than the width.

**Cases:**
1. `width` must be a positive integer, otherwise RangeError.
2. Words are separated by spaces; each line takes as many whole words as fit, joined by one space.
3. A line exactly `width` wide fits.
4. **[D]** Runs of spaces between words collapse to one.
5. No output line has trailing whitespace.
6. `\n` in the input is a hard line break; `\r\n` counts as `\n`; the output uses `\n`.
7. A blank line (paragraph break) is kept.
8. **[D]** Several blank lines in a row become one.
9. An empty string returns an empty string.
10. A final newline in the input is kept once; otherwise the output has none.
11. A paragraph's leading spaces are kept on its first line.
12. Continuation lines of a paragraph get the same leading spaces as its first line.
13. `hangingIndent` (default 0) adds that many more spaces to continuation lines only.
14. A tab in the leading indentation advances to the next multiple of `tabWidth` (default 4).
15. **[D]** A tab anywhere else counts as one space between words.
16. A word with a hyphen may break right after a hyphen when the whole word does not fit (`well-` / `known`).
17. **[D]** A word longer than the line is cut into pieces of `width - 1` characters, each followed by `-`, the last piece without one; with width 1 there is no `-`.
18. **[D]** A word starting with `http://` or `https://` is never hyphenated: it is cut at exactly `width` characters without `-`.
19. A soft hyphen (U+00AD) is a break opportunity: shown as `-` where the line breaks there, removed everywhere else.
20. A no-break space (U+00A0) never breaks and counts as width 1.
21. Wide East Asian characters count as width 2.
22. Emoji count as width 2.
23. Combining marks count as width 0 and stay with their base character.
24. Text of wide characters without spaces may break between any two of them.
25. ANSI escape sequences (`\x1b[...m`) count as width 0 and are never split.
26. `maxLines` keeps at most that many lines.
27. **[D]** When `maxLines` cuts text, the last kept line ends with `…` (width 1), dropping whole words from its end until it fits.
28. `maxLines` must be a positive integer when given, otherwise RangeError.
29. `tabWidth` and `hangingIndent` must be non-negative integers (`tabWidth` positive), otherwise RangeError.
30. An indentation (plus `hangingIndent`) that leaves no room for text: RangeError `indent leaves no room`.

- [ ] Steps 1-9 of the fixture task template.

---

### Task 8: Pack docs and full check

**Files:**
- Modify: `docs/EVALUATION.md` (packs intro at lines ~137-144, the pack table at ~177-202, a new subsection after "The hard pack and receipt honesty")

- [ ] **Step 1:** Add the 6 harder rows to the pack table (`| harder | harder-<name> | <fixture> | <case themes> |`),
  name the pack in the intro sentence, and add a subsection "The harder pack": why (the hard pack missed its band),
  the 30-35 case bound and the checklist's 40-case cap, prompts in prose, one hidden test per case, the [D]
  departures, Pi-only calibration.
- [ ] **Step 2:** `bun run typecheck && bun run test:fast`. Expected: all pass except the known
  `tests/daily-terminal.test.ts` rows-only resize failure (fails on e987e18 too); report it by name.
- [ ] **Step 3:** Commit `docs/EVALUATION.md`.

---

### Task 9: Calibration round 1 (Pi only)

**Files:**
- Create: `/Users/stephenchoate/Documents/Casper/.scratch/harder/calibrate1.sh` (gitignored)

- [ ] **Step 1: Write the script.**

```bash
#!/bin/bash
# Harder pack calibration round 1: Pi only, both models, repeat 4 (8 runs per task). Band: 25-60% not accepted.
cd /Users/stephenchoate/Documents/Casper/.claude/worktrees/funny-colden-26e4eb
OUT=/Users/stephenchoate/Documents/Casper/.scratch/harder/cal1
mkdir -p $OUT
BASE="--pack harder --harness pi --repeat 4 --time-limit 600 --concurrency 10"
bun tools/eval.ts $BASE --model openrouter/z-ai/glm-5.3-flash --route Together --json $OUT/glm.json > $OUT/glm.log 2>&1 &
bun tools/eval.ts $BASE --model openrouter/deepseek/deepseek-v4.1-flash --route DeepSeek,Together --json $OUT/deepseek.json > $OUT/deepseek.log 2>&1 &
wait
```

- [ ] **Step 2: Launch detached** and wait on the process IDs (not on a marker file):
  `nohup perl -e 'use POSIX; setsid(); exec @ARGV' /Users/stephenchoate/Documents/Casper/.scratch/harder/calibrate1.sh > /dev/null 2>&1 &`
- [ ] **Step 3: Report.** `bun tools/eval.ts --report $OUT/glm.json --report $OUT/deepseek.json`. For every
  not-accepted run, read the failing hidden test names: a failure caused by the test or grader (not the model)
  triggers the bug rule.
- [ ] **Step 4: Decide.** In band (12-28 of 48 not accepted): go to Task 10. Out of band: adjust only tasks at
  0/8 or 8/8 (add, reword or remove cases in prompt and hidden tests together, keeping 30-35), commit, and run
  round 2 with `cal2`. Still out of band after round 2: stop and report to the owner.

---

### Task 10: Freeze and calibration record

**Files:**
- Create: `docs/evals/<YYYY-MM-DD>-harder-pack-calibration.md`, dated the day calibration finishes

- [ ] **Step 1:** Write the record: rounds, per-task Pi not-accepted by model, what changed between rounds,
  the reprint command, and the frozen commit.
- [ ] **Step 2:** Commit it together with any last pack change as the freeze commit
  (`"Freeze the harder pack after calibration: <n>/48 Pi not accepted."`).

---

### Task 11: Pre-registered decision run

**Files:**
- Create: `docs/evals/<YYYY-MM-DD>-harder-checklist.md`, dated the day of pre-registration (pre-registration first, results appended)
- Create: `/Users/stephenchoate/Documents/Casper/.scratch/harder/decide.sh`

- [ ] **Step 1: Pre-register.** Commit the record's first part before launching: pack commit, harnesses, models,
  volume, the decision rule and the bug rule, copied from Global Constraints.
- [ ] **Step 2: Script.**

```bash
#!/bin/bash
# Harder pack decision run, pre-registered in docs/evals/<record>.md. Rule: casper-checklist not-accepted <= 2/3 x pi's,
# and casper-checklist median wall and tokens each <= 1.25x pi's. Each model stops once its comparison is decided.
cd /Users/stephenchoate/Documents/Casper/.claude/worktrees/funny-colden-26e4eb
OUT=/Users/stephenchoate/Documents/Casper/.scratch/harder/decide
mkdir -p $OUT
BASE="--pack harder --harness casper-checklist --harness pi --harness casper --repeat 10 --time-limit 600 --concurrency 10 --stop-when-success-decided casper-checklist:pi:0.67"
bun tools/eval.ts $BASE --model openrouter/z-ai/glm-5.3-flash --route Together --json $OUT/glm.json > $OUT/glm.log 2>&1 &
bun tools/eval.ts $BASE --model openrouter/deepseek/deepseek-v4.1-flash --route DeepSeek,Together --json $OUT/deepseek.json > $OUT/deepseek.log 2>&1 &
wait
```

- [ ] **Step 3:** Launch detached as in Task 9 Step 2; watch the logs for the bug rule's triggers.
- [ ] **Step 4: Record results:** accepted per harness and model, median wall and tokens, per-task misses,
  receipt honesty, one-sided Fisher exact test of casper-checklist vs pi (labeled inference), and the rule's
  verdict.
- [ ] **Step 5: Act on the verdict.** Met: a separate change (its own design approval) makes
  `verification.checklist` default to true in auto mode, with docs. Not met: the checklist stays opt-in.
  Either way update docs/HANDOFF's Next and commit.
