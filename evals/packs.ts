import type { EvalAcceptance, EvalConvention, EvalTask, EvalVerification } from "./runner";

/** Quality-benchmark tasks. Each fixture is the reference solution; its `acceptance/` directory holds
 * the hidden tests, which the setup removes from the candidate and the frozen evaluator runs. Prompts
 * carry the contract; the fixture's CONTEXT.md carries the conventions (neither harness auto-loads it). */

const VISIBLE: EvalVerification = { name: "visible tests", argv: ["{{bun}}", "test", "./tests"] };
const HIDDEN: EvalVerification = { name: "hidden acceptance", argv: ["{{bun}}", "test", "./acceptance"] };
const TSC: EvalVerification = { name: "tsc --noEmit", argv: ["{{bun}}", "{{tsc}}", "--noEmit", "-p", "tsconfig.json"] };

const RULES = " Read CONTEXT.md first; it describes this project's conventions. The visible tests in tests/ are "
  + "incomplete: hidden acceptance tests will check exactly the behavior described here and in CONTEXT.md. Keep the "
  + "visible tests passing without modifying them (you may add new test files). Do not add dependencies.";

/** Explicit prompt rules only: no dependency changes and nothing edited outside source and tests. */
const SCOPE: EvalAcceptance = { unchanged: ["package.json", "CONTEXT.md", ".casper/"] };

const convention = (id: string, check: EvalAcceptance): EvalConvention => ({ id, check });
const onlyEdits = (...prefixes: string[]) => convention("edits-in-scope", { allowedChanges: prefixes });

function task(fields: Omit<EvalTask, "verify" | "candidatePaths" | "initialVerification" | "acceptance"> & Partial<EvalTask>): EvalTask {
  return {
    verify: [VISIBLE, HIDDEN], candidatePaths: ["src"], initialVerification: "fail", acceptance: SCOPE, ...fields,
  };
}

export const CORE_PACK: readonly EvalTask[] = [
  task({
    id: "core-rest-validation", pack: "core", fixture: "notes-api", setup: "add-validated-endpoint",
    prompt: "Add `POST /notes` to this notes service. It accepts a JSON object `{ title, body?, tags? }`: `title` is a "
      + "string of 1-100 characters after trimming (store it trimmed); `body` is an optional string of at most 1000 "
      + "characters (default \"\"); `tags` is an optional array (default []) of at most 5 unique strings, each 1-20 "
      + "characters of a-z, 0-9 and `-`. Success is 201 with the created note and a `Location: /notes/<id>` header. "
      + "Errors: a content type other than application/json is 415 `unsupported_media_type`; malformed JSON is 400 "
      + "`invalid_json`; anything else invalid (wrong types, out-of-range values, unknown fields, or a body that is not "
      + "a JSON object) is 422 `{ \"error\": \"validation_failed\", \"fields\": { <field>: <message> } }` naming every "
      + "offending field. A rejected request must not create a note." + RULES,
    conventions: [
      onlyEdits("src/", "tests/"),
      convention("errors-through-jsonError", { contains: [{ path: "src/handlers.ts", text: "validation_failed" }], noMatch: [{ text: "new Response(", under: "src/handlers.ts" }] }),
    ],
  }),
  task({
    id: "core-ui-tabs", pack: "core", fixture: "ui-kit", setup: "add-tabs-component",
    prompt: "Add a `Tabs` component: `createTabs({ tabs: [{ id, label, panel }], selected? })`, exported from the package "
      + "index. It follows the WAI-ARIA tabs pattern: one `role=\"tablist\"` containing a `<button role=\"tab\">` per tab "
      + "with `id=\"tab-<id>\"`, `aria-controls=\"panel-<id>\"`, `aria-selected` and a roving `tabindex` (0 on the selected "
      + "tab, -1 on the others); one `role=\"tabpanel\"` per tab with `id=\"panel-<id>\"`, `aria-labelledby=\"tab-<id>\"` "
      + "and the `hidden` attribute unless selected. Labels and panel text are HTML-escaped. State: the first tab is "
      + "selected unless `selected` says otherwise; `select(id)` changes it; `key(k)` handles ArrowRight/ArrowLeft "
      + "(wrapping), Home and End and ignores other keys; the `selected` getter returns the selected id. Empty tabs, "
      + "duplicate ids and unknown ids throw." + RULES,
    conventions: [
      onlyEdits("src/", "tests/"),
      convention("component-file", { contains: [{ path: "src/components/tabs.ts", text: "createTabs" }, { path: "src/index.ts", text: "createTabs" }] }),
    ],
  }),
  task({
    id: "core-portcheck-cli", pack: "core", fixture: "portcheck", setup: "add-portcheck-json-tls",
    prompt: "Extend the `portcheck` CLI with `--json` and `--tls`. `--json` prints one JSON array line with a row per "
      + "target in argument order: `{ target, host, port, status, ms }` where status is open, closed, timeout, tls-error or "
      + "invalid; an unparseable target is `invalid` with host, port and ms null (not a usage error). `--tls` completes a "
      + "TLS handshake after connecting, without verifying the certificate chain (self-signed is fine), and adds "
      + "`tls: { expires, daysLeft }` to open rows: `expires` is the peer certificate's notAfter as an ISO-8601 string and "
      + "`daysLeft` the whole days until then (rounded down). A listener that accepts TCP but fails the handshake is "
      + "`tls-error`; a handshake that does not finish within `--timeout` is `timeout`. Human output adds "
      + "`expires <YYYY-MM-DD> (<n> days)` to open TLS rows. `--timeout` must be a positive integer; unknown flags, a bad "
      + "timeout or no targets are usage errors (exit 64, usage on stderr, nothing on stdout)." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("probe-in-probe-module", { contains: [{ path: "src/probe.ts", text: "tls" }] })],
  }),
  task({
    id: "core-resilient-client", pack: "core", fixture: "api-client", setup: "add-resilient-client",
    prompt: "Make this API client resilient. Add `listAll(path)`: it follows each page's `next` link (relative to the "
      + "page URL, or absolute) until `next` is null and returns all `items` in order; a `next` that repeats an "
      + "already-fetched URL is an error. Every request retries 429, 5xx and network errors up to `maxRetries` times "
      + "(option, default 3): a 429 waits `Retry-After` seconds when present, otherwise the wait is 100, 200, 400, 800 ms "
      + "for retries 1-4. Waiting goes through an injectable `sleep(ms)` option. Other 4xx fail at once. When retries run "
      + "out, throw `HttpError` with the last status. A request slower than `timeoutMs` (option) is aborted through its "
      + "AbortSignal and rejects with a new exported `TimeoutError` (name \"TimeoutError\"), without retrying." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("errors-module", { contains: [{ path: "src/errors.ts", text: "TimeoutError" }, { path: "src/index.ts", text: "TimeoutError" }] })],
  }),
  task({
    id: "core-log-parser", pack: "core", fixture: "log-parser", setup: "add-log-parser",
    prompt: "Implement `parseLog(text)` in src/parse.ts for the log format in CONTEXT.md. It returns "
      + "`{ records, problems }` using the types in src/types.ts. Handle every rule in CONTEXT.md, including quoted "
      + "values with escapes, continuation lines, CRLF, invalid timestamps (including impossible dates such as "
      + "February 30), and invalid lines, which are reported as problems while parsing continues." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("pure-parser", { noMatch: [{ text: "node:fs", under: "src" }, { text: "console.", under: "src" }] })],
  }),
  task({
    id: "core-refactor-across-files", pack: "core", fixture: "people", setup: "reshape-person-name",
    prompt: "Replace `User.fullName` with a structured `name: { given: string; family: string }` (export the "
      + "`PersonName` type) everywhere: src/ and the test data in tests/. Add `displayName(user)` (\"Given Family\", "
      + "skipping an empty part) and `sortName(user)` (\"Family, Given\", skipping an empty part) to src/user.ts and use "
      + "them instead of building name strings elsewhere. Search matches the display name or email, case-insensitively; "
      + "sorting is by family, then given (ignoring case and accents), then id; greetings use the given name (the family "
      + "name when there is none); `fromLegacy` splits the last word off as the family name. No `fullName` may remain. "
      + "Read CONTEXT.md first. Both `bun test` and `tsc --noEmit -p tsconfig.json` must pass; hidden acceptance tests "
      + "will also check this behavior. Keep tsconfig.json and bun-test.d.ts unchanged. Do not add dependencies.",
    verify: [VISIBLE, HIDDEN, TSC],
    candidatePaths: ["src", "tests"],
    acceptance: {
      unchanged: ["package.json", "tsconfig.json", "bun-test.d.ts", "CONTEXT.md", ".casper/"],
      noMatch: [{ text: "fullName", under: "src" }, { text: "fullName", under: "tests" }],
    },
    conventions: [
      onlyEdits("src/", "tests/"),
      convention("names-formatted-in-user-module", { contains: [{ path: "src/user.ts", text: "export function displayName" }, { path: "src/user.ts", text: "export function sortName" }] }),
    ],
  }),
  task({
    id: "core-flaky-test", pack: "core", fixture: "ttl-cache", setup: "fix-flaky-ttl-test",
    prompt: "tests/cache.test.ts is flaky: it sleeps against real time. Make it deterministic without weakening it: "
      + "give `TtlCache` an optional `now: () => number` clock option (default `Date.now`) used for every time read, "
      + "and rewrite the three tests to drive a fake clock instead of sleeping. Keep all three tests and what they check, "
      + "including that an entry is gone exactly when its TTL has elapsed. No sleeps, timers, retries, skips or widened "
      + "margins. Read CONTEXT.md first; hidden acceptance tests will check the clock option and rerun the suite many "
      + "times. Do not add dependencies.",
    candidatePaths: ["src", "tests"],
    acceptance: {
      unchanged: ["package.json", "CONTEXT.md", ".casper/", "bunfig.toml"],
      noMatch: [
        { text: "setTimeout", under: "tests" }, { text: "sleep(", under: "tests" }, { text: ".skip(", under: "tests" },
        { text: ".only(", under: "tests" }, { text: ".todo(", under: "tests" },
      ],
      contains: [
        { path: "tests/cache.test.ts", text: "returns a value before it expires" },
        { path: "tests/cache.test.ts", text: "an entry expires once its TTL has elapsed" },
        { path: "tests/cache.test.ts", text: "setting again restarts the TTL" },
      ],
    },
    conventions: [onlyEdits("src/", "tests/"), convention("clock-option-typed", { contains: [{ path: "src/cache.ts", text: "now?: () => number" }] })],
  }),
  task({
    id: "core-mcp-tool", pack: "core", fixture: "mcp-server-kit", setup: "add-search-files-tool",
    prompt: "Add a `search_files` tool to this MCP server's catalog. Arguments: `query` (required string, at least 1 "
      + "character, matched as literal text, not a regular expression), `limit` (optional integer 1-50, default 10) and "
      + "`caseSensitive` (optional boolean, default false); every property has a description and no other properties are "
      + "allowed. Annotations: read-only, not destructive, idempotent, closed-world. It searches every workspace file in "
      + "path order, line by line (LF or CRLF), and returns one `path:line: text` line per match with 1-based line "
      + "numbers. At most `limit` matches are returned; when matches are left out, the last line is exactly "
      + "`… truncated (<n> more matches)`. The whole output never exceeds 4000 characters, even with very long lines. "
      + "No matches is a normal (non-error) result that names the query. Invalid arguments return a tool error whose text "
      + "starts with `Invalid arguments`; the tool never throws." + RULES,
    conventions: [
      onlyEdits("src/", "tests/"),
      convention("one-tool-per-file", { changed: ["src/tools/"], contains: [{ path: "src/catalog.ts", text: "search" }] }),
    ],
  }),
];
