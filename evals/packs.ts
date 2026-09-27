import type { EvalAcceptance, EvalConvention, EvalTask, EvalVerification } from "./runner";

/** Quality-benchmark tasks. Each fixture is the reference solution; its `acceptance/` directory holds
 * the hidden tests, which the setup removes from the candidate and the frozen evaluator runs. Prompts
 * carry the contract; the fixture's CONTEXT.md carries the conventions (neither harness auto-loads it). */

const VISIBLE: EvalVerification = { name: "visible tests", argv: ["{{bun}}", "test", "./tests"], rubric: "works" };
const HIDDEN: EvalVerification = { name: "hidden acceptance", argv: ["{{bun}}", "test", "./acceptance"], rubric: "complete" };
/** One hidden file, for a fixture whose `acceptance/` serves more than one task. */
const hidden = (file: string): EvalVerification => ({ ...HIDDEN, argv: ["{{bun}}", "test", `./acceptance/${file}.test.ts`] });
const TSC: EvalVerification = { name: "tsc --noEmit", argv: ["{{bun}}", "{{tsc}}", "--noEmit", "-p", "tsconfig.json"], rubric: "clean" };

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
    verify: [VISIBLE, hidden("create-note")],
    prompt: "Add `POST /notes` to this notes service. It accepts a JSON object `{ title, body?, tags? }`: `title` is a "
      + "string of 1-100 characters after trimming (store it trimmed); `body` is an optional string of at most 1000 "
      + "characters (default \"\"); `tags` is an optional array (default []) of at most 5 unique strings, each 1-20 "
      + "characters of a-z, 0-9 and `-`. Success is 201 with the created note and a `Location: /notes/<id>` header. "
      + "Errors: a content type other than application/json is 415 `unsupported_media_type`; malformed JSON is 400 "
      + "`invalid_json`; anything else invalid (wrong types, out-of-range values, unknown fields, or a body that is not "
      + "a JSON object) is 422 `{ \"error\": \"validation_failed\", \"fields\": { <field>: <message> } }` naming every "
      + "offending field by its top-level property name (`title`, `body`, `tags` or the unknown property; a bad tag is "
      + "reported under `tags`, never `tags[0]`). A rejected request must not create a note." + RULES,
    conventions: [
      onlyEdits("src/", "tests/"),
      convention("errors-through-jsonError", { contains: [{ path: "src/handlers.ts", text: "validation_failed" }], noMatch: [{ text: "new Response(", under: "src/handlers.ts" }] }),
    ],
  }),
  task({
    // Only running the server shows these behaviors: the visible tests pass on the start, and the
    // hidden file spawns the real server (docs/EVALUATION.md). Shares notes-api with core-rest-validation.
    id: "core-service-lifecycle", pack: "core", fixture: "notes-api", setup: "add-server-lifecycle",
    verify: [VISIBLE, hidden("server-lifecycle")],
    prompt: "Make this notes service behave as a real server (src/server.ts, started with `bun run dev`). Add `GET /health` "
      + "answering 200 JSON `{ \"status\": \"ok\", \"uptimeMs\": <n> }`, where n is the whole number of milliseconds since "
      + "the server started. Listen on the port in the `PORT` environment variable and the host in `HOST` (defaults 3000 "
      + "and 127.0.0.1); any loopback host must work, including IPv6 `::1`. On SIGTERM, requests already in progress must "
      + "still get their full response, and the process must then exit with code 0 within 2 seconds of the signal." + RULES,
    conventions: [
      onlyEdits("src/", "tests/"),
      convention("health-route-in-app", { contains: [{ path: "src/app.ts", text: "/health" }] }),
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
      + "sorting is by family, then given (ignoring case and accents), then id; greetings use the whole given name "
      + "(`Hi Mary Ann,`), or the family name when there is no given name; `fromLegacy` splits the last word off as the "
      + "family name and keeps the rest as the given name, and a single-word name is a given name with an empty family "
      + "name. No `fullName` may remain. "
      + "Read CONTEXT.md first. Both `bun test` and `bun run typecheck` (strict `tsc` over src and tests) must pass; hidden acceptance tests "
      + "will also check this behavior. Keep tsconfig.json and bun-test.d.ts unchanged. Do not add dependencies.",
    verify: [VISIBLE, HIDDEN, TSC],
    tools: ["typescript"],
    candidatePaths: ["src", "tests"],
    acceptance: {
      unchanged: ["package.json", "tsconfig.json", "bun-test.d.ts", "CONTEXT.md", ".casper/", "node_modules/"],
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
      + "`… truncated (<n> more matches)`. The whole output never exceeds 4000 characters, even with very long lines: a very "
      + "long matching line is shortened (ending in `…`) rather than left out, so the output still starts with the first match. "
      + "No matches is a normal (non-error) result that names the query. Invalid arguments return a tool error whose text "
      + "starts with `Invalid arguments`; the tool never throws." + RULES,
    conventions: [
      onlyEdits("src/", "tests/"),
      convention("one-tool-per-file", { changed: ["src/tools/"], contains: [{ path: "src/catalog.ts", text: "search" }] }),
    ],
  }),
];

export const NETWORK_PACK: readonly EvalTask[] = [
  task({
    id: "net-interface-parser", pack: "network", fixture: "net-interfaces", setup: "add-junos-aoscx-parsers",
    prompt: "Only the IOS-XE `show interfaces` parser exists. Implement the Junos and AOS-CX parsers so all three vendors "
      + "produce the same model, following every rule and the vendor table in CONTEXT.md: sub-interfaces and logical units, "
      + "LAG membership in both directions, abbreviated member names, speeds in Mb/s, MAC normalization, and truncated "
      + "captures (pager prompts). The samples in tests/samples/ show the expected output for each vendor." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("vendor-modules", { changed: ["src/vendors/junos.ts", "src/vendors/aoscx.ts"] })],
  }),
  task({
    id: "net-mac-port-finder", pack: "network", fixture: "net-macfind", setup: "add-macfind-cli-endpoint",
    prompt: "`findMac` returns the first table entry it sees, often an uplink. Fix it and expose it two ways. "
      + "`findMac(devices, mac)` must accept any MAC format in CONTEXT.md (throwing `InvalidMacError` otherwise) and "
      + "return `{ mac, device, port, vlan }` for the edge port where the MAC was learned, ignoring uplinks (including "
      + "LAG uplinks, as CONTEXT.md defines them), or null when it is only seen on uplinks or not at all. Add a CLI "
      + "`main(argv, io)` in src/cli.ts (`io` is `{ out(text), err(text) }` as in CONTEXT.md: both write text exactly as given, like `process.stdout.write`, so "
      + "every line you print must end with `\n`; `argv` is the arguments only; return the exit code): `macfind --data <dir> [--json] <mac>` prints "
      + "`<mac> is on <device> <port> (vlan <vlan>)` (exit 0) or `<mac> not found on any edge port` (exit 1), with the "
      + "MAC normalized; `--json` prints the location object or `null`; an invalid MAC, missing `--data`, a wrong number "
      + "of MACs or an unknown flag is a usage error (exit 64, stderr only). Add `createHandler(devices)` in "
      + "src/server.ts: `GET /mac/<mac>` (URL-decoded) answers 200 with the location, 404 `{\"error\":\"not_found\"}` or "
      + "400 `{\"error\":\"invalid_mac\"}`, all JSON." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("entry-points", { contains: [{ path: "src/cli.ts", text: "export async function main" }, { path: "src/server.ts", text: "createHandler" }] })],
  }),
  task({
    id: "net-meraki-inventory", pack: "network", fixture: "net-meraki-export", setup: "fix-meraki-export",
    prompt: "`exportInventory` only reads the first page and writes broken CSV. Make it export the whole organization as "
      + "CONTEXT.md describes: follow `Link` rel=next pagination, retry 429 after Retry-After through an injectable "
      + "`sleep(ms)` option (giving up after 5 retries for one URL), fail on other HTTP errors with the status in the "
      + "message, and write RFC 4180 CSV sorted by serial with the documented columns and empty fields for missing values."
      + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("csv-module", { contains: [{ path: "src/csv.ts", text: "export" }] })],
  }),
  task({
    id: "net-aoscx-session", pack: "network", fixture: "net-aoscx-session", setup: "fix-aoscx-session-leak",
    prompt: "This AOS-CX REST client leaks sessions: when a request or the caller's work fails, it never logs out, and the "
      + "switch soon refuses new logins. Fix `withSession` so every successful login is followed by exactly one logout on "
      + "every path, following the error rules in CONTEXT.md: a failed login throws `LoginError` and sends nothing else; "
      + "a non-2xx response throws `HttpError` with its status and path; the work's own error is rethrown unchanged; "
      + "if work succeeds but logout fails, reject with `LogoutError`; if both fail, the work's error wins." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("errors-module", { unchanged: ["src/errors.ts"] })],
  }),
  task({
    id: "net-netbox-dry-run", pack: "network", fixture: "net-netbox-plan", setup: "fix-netbox-plan",
    prompt: "`planSync` is a dry run against a NetBox-style API, but it reads only the first page, compares only serials "
      + "and ignores NetBox-only devices. Make it follow CONTEXT.md exactly: follow `next` pages, compare serial, site, "
      + "role (including servers that send `device_role`) and primary IPv4, treat missing/null/empty as no value, fill "
      + "every plan list sorted by name, reject duplicate source names before any request, and fail on HTTP errors with "
      + "the status in the message. It must only ever send GET requests with the token header. The printed format in "
      + "src/format.ts is already right." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("format-untouched", { unchanged: ["src/format.ts", "src/types.ts"] })],
  }),
  task({
    id: "net-radius-test", pack: "network", fixture: "net-radius-test", setup: "finish-radius-test",
    prompt: "Finish the RADIUS test tool. `radiusTest(options)` in src/client.ts must follow the protocol rules in "
      + "CONTEXT.md: accept only replies with the request's Identifier and a valid Response Authenticator, retransmit the "
      + "identical packet after each `timeoutMs` up to `retries` times, report `bad-response` versus `timeout`, map "
      + "Accept/Reject/Challenge, and decode every Reply-Message, every Cisco-AVPair and the first Aruba-User-Role. It "
      + "resolves `{ status, attempts, replyMessages, arubaUserRole, ciscoAvPairs }`. Add `main(argv, io)` in src/cli.ts (`io` is "
      + "`{ out(text), err(text) }` as in CONTEXT.md: both write text exactly as given, like `process.stdout.write`, so every "
      + "printed line must end with `\n`; `argv` is the arguments only; return the exit code): "
      + "`radtest --host <h> [--port 1812] --secret <s> --user <u> --password <p> [--timeout ms] [--retries n] [--json]`. "
      + "Human output is a first line `<Access-Accept|Access-Reject|Access-Challenge> from <host>:<port> (attempts <n>)` "
      + "(for timeout or bad-response, a first line that says so; bad-response must mention the shared secret), then "
      + "indented `  Reply-Message: …`, `  Aruba-User-Role: …` and `  Cisco-AVPair: …` lines in that order. `--json` "
      + "prints the result object. Exit codes are in CONTEXT.md; missing or malformed options print usage to stderr and "
      + "exit 64." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("packet-module-kept", { unchanged: ["src/packet.ts"] })],
  }),
  task({
    id: "net-tacacs-accounting", pack: "network", fixture: "net-tacacs-acct", setup: "add-tacacs-history",
    prompt: "Implement `commandHistory(text, { year })` in src/history.ts: per-user TACACS+ command history built from a "
      + "tac_plus-style accounting log, following the history rules in CONTEXT.md (start/stop pairing by NAS and task id, "
      + "stop-only and never-stopped commands, ISO times in the given year, problems for invalid lines). Use the existing "
      + "record parser." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("uses-record-parser", { contains: [{ path: "src/history.ts", text: "parseRecord" }], unchanged: ["src/record.ts"] })],
  }),
  task({
    id: "net-config-compliance", pack: "network", fixture: "net-config-audit", setup: "add-config-audit",
    prompt: "Config backup diffs are full of noise and there is no compliance check. Implement normalization in "
      + "src/normalize.ts exactly as CONTEXT.md describes for Junos (comments, `$9$` secrets) and AOS-CX (comments, the "
      + "header, `exit`, parent > child hierarchy), so `diffConfigs` reports only real changes. Add `checkCompliance(vendor, "
      + "text)` in src/compliance.ts returning the `ntp`, `aaa` and `snmpv2-off` results defined in CONTEXT.md, each "
      + "`{ rule, passed, detail }`; a failing `snmpv2-off` detail names every community." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("module-layout", { contains: [{ path: "src/compliance.ts", text: "checkCompliance" }], changed: ["src/normalize.ts"] })],
  }),
  task({
    id: "net-mcp-show-interfaces", pack: "network", fixture: "net-mcp-router", setup: "add-show-interfaces-tool",
    prompt: "Add a read-only `show_interfaces` device tool to this router-style MCP server. Arguments: `device` "
      + "(required, non-empty string), `prefix` (optional string: only interface names starting with it) and `operUp` "
      + "(optional boolean filter); each has a description and no others are allowed. Annotations: read-only, not "
      + "destructive, idempotent, closed-world. It returns JSON text `{ device, total, truncated, interfaces }` where each "
      + "interface is `{ name, adminUp, operUp, description, speedMbps }` in inventory order, `total` counts every match, "
      + "and at most 50 are listed; the JSON text stays within 4000 characters (list fewer interfaces with `truncated: true` "
      + "rather than adding anything outside the JSON). An unknown device is a tool error naming the known devices. It must stay out of the "
      + "direct tool list, be found first by `find_tool` for the queries `interfaces` and `interface status`, and run "
      + "through `invoke_read_tool`." + RULES,
    conventions: [
      onlyEdits("src/", "tests/"),
      convention("device-tool-file", { changed: ["src/tools/"], contains: [{ path: "src/tools/index.ts", text: "show" }], unchanged: ["src/router.ts"] }),
    ],
  }),
];

/** Tasks built for the receipt-honesty experiment (docs/evals): models miss or half-do stated requirements
 * often enough to measure how many wrong outcomes Casper's receipt catches. Visible tests cover only the
 * basic path; every hidden check is a requirement the prompt states. */
export const HARD_PACK: readonly EvalTask[] = [
  task({
    id: "hard-job-queue", pack: "hard", fixture: "job-queue", setup: "add-job-queue",
    prompt: "Implement `JobQueue` in src/queue.ts (the types there are the API). `new JobQueue({ concurrency, retries?, sleep? })`: "
      + "`concurrency` must be a positive integer and `retries` (default 0) a non-negative integer, otherwise throw RangeError. "
      + "`add(job, { priority? })` returns `{ id, result, cancel }`: ids are 1, 2, 3... in the order jobs were added. Jobs start "
      + "by priority (default 0, higher first), and equal priorities in the order added. Never more than `concurrency` jobs "
      + "run at once. Each job is called with an AbortSignal; a job that throws "
      + "(synchronously or by rejecting) is retried up to `retries` more times, and before retry n (n = 1, 2, 3...) the queue "
      + "awaits `sleep(min(10 * 2 ** (n - 1), 100), signal)`, so 10, 20, 40, 80, 100, 100 ms; the default sleep is a real "
      + "timer, tests inject their own. "
      + "A job waiting for its retry keeps its concurrency slot. `result` never rejects: it resolves to `{ status: \"fulfilled\", "
      + "value }`, `{ status: \"rejected\", error }` with the last attempt's error, or `{ status: \"cancelled\" }`. `cancel()` on a "
      + "queued job means it never runs; on a running job (or one waiting to retry) it aborts the job's signal, the result is "
      + "`cancelled` at once whatever the job does afterwards, no further attempt is made, and the job keeps its slot until its "
      + "own promise settles; after a job settled, `cancel()` changes nothing. `onIdle()` resolves once nothing is queued or "
      + "running, with every job's result in the order the jobs were added (not the order they finished); on a queue with no "
      + "jobs it resolves with []. `pause()` starts no new jobs (running ones go on, and `onIdle()` keeps waiting while jobs "
      + "are queued) until `resume()`, which starts jobs up to the limit again. The `size` getter counts jobs waiting to "
      + "start and `pending` the jobs holding a slot (running, waiting to retry, or cancelled but not yet settled)." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("queue-in-place", { changed: ["src/queue.ts"] })],
  }),
  task({
    id: "hard-config-merge", pack: "hard", fixture: "config-loader", setup: "add-config-loader",
    prompt: "Implement `loadConfig(defaults, { file?, env? })` in src/config.ts (the types there are the API). The defaults "
      + "object is the schema: its keys are the only allowed keys, and each default's type (string, number, boolean, list of "
      + "strings, or nested object) is the only allowed type. Precedence is env over file over defaults, merged key by key "
      + "through nested objects; a list from a higher source replaces the lower list entirely, and every list from the file "
      + "or the environment keeps only the first occurrence of each item. `file` is already-parsed JSON "
      + "and must be an object. Environment variables count only when their name starts with `APP_`: the rest is lowercased "
      + "and `__` separates nesting levels (`APP_DB__PORT` is `db.port`), while a single `_` stays part of the key "
      + "(`APP_LOG_LEVEL` is `log_level`); undefined values are ignored. Env strings are converted to the default's type: a "
      + "number must be a finite number and not empty, a boolean is exactly `true` or `false`, a list is comma-separated with "
      + "each item trimmed and empty items dropped (an empty string is an empty list; `\\,` is a comma inside an item); an env "
      + "variable naming an object is an `expected object` error, and one nesting below a key that is not an object "
      + "(`APP_NAME__FIRST` when `name` is a string) is an unknown key. Problems are collected, never stopping at the first, "
      + "and thrown as one `ConfigError` whose `issues` are "
      + "`{ path, source, message }`: `path` is the dotted key path (`\"\"` when the file is not an object), `source` is `file` "
      + "or `env`, and `message` is `unknown key` or `expected <string|number|boolean|list|object>` (the default's type; null "
      + "never matches). File issues come first in the file's key order, then env issues sorted by variable name. A key such "
      + "as `__proto__` is an unknown key like any other. Inputs are never mutated and the returned object shares no object "
      + "or list with them." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("loader-in-place", { changed: ["src/config.ts"] })],
  }),
  task({
    id: "hard-money-allocation", pack: "hard", fixture: "allocation", setup: "add-allocation",
    prompt: "Implement `allocate(amount, currency, ratios)` in src/allocate.ts. `amount` is a decimal string: an optional `-`, "
      + "then `0` or digits not starting with `0`, and optionally `.` followed by digits, with at most as many decimal places "
      + "as the currency has minor-unit digits in src/currencies.ts (USD 2, JPY 0, KWD 3; do not change that table). Anything "
      + "else (including leading zeros such as `007.00` and any whitespace), a currency code that is not exactly a key of that "
      + "table (`usd` is unknown), an "
      + "empty ratio list or a ratio that is not a positive integer throws RangeError. Split the amount's exact integer minor "
      + "units, with no floating point (amounts beyond 2^53 minor units must stay exact): each part first gets the floor of "
      + "its share, then the leftover units go one each to the parts with the largest remainders, ties to the earlier ratio, "
      + "so the parts always add up to the amount. A negative amount is split like its absolute value and every part negated; "
      + "a zero part is never printed negative. Every part is printed with exactly the currency's number of decimal places "
      + "(`\"5.50\"`, `\"34\"` for JPY, `\"0.500\"` for KWD)." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("currency-table-untouched", { unchanged: ["src/currencies.ts"] })],
  }),
  task({
    id: "hard-dependency-scheduler", pack: "hard", fixture: "task-graph", setup: "add-scheduler",
    prompt: "Implement `schedule(graph)` and `batches(graph, { limit? })` in src/schedule.ts; a graph maps each task name to the "
      + "names it depends on, and a dependency listed twice counts once. A dependency written `name?` is optional: ignored "
      + "when there is no task `name`, an ordinary dependency on `name` otherwise. `schedule` returns one order in which every "
      + "task comes after its dependencies, and whenever several tasks are ready the smallest name goes first. `batches` "
      + "returns groups that can run in parallel: each task sits in the first batch after all of its dependencies, and each "
      + "batch is sorted. With `limit` (a positive integer, RangeError otherwise) a batch holds at most `limit` tasks: when "
      + "more are ready, the smallest names go in and the rest wait for a later batch. "
      + "Names compare by plain string order (`<`), never locale order. Both check for unknown (non-optional) dependencies before anything "
      + "else: throw `MissingDependencyError` for the first one, taking tasks in sorted name order and each task's "
      + "dependencies in listed order. Otherwise a cycle throws `CycleError` whose `cycle` starts and ends with the same "
      + "task and follows dependencies (`[\"a\", \"b\", \"a\"]`: a needs b needs a). Report the cycle through the smallest task "
      + "name that lies on any cycle (a task that only depends on a cycle is not on it), taking the shortest cycle back to "
      + "that task; a task depending on itself is the cycle `[\"t\", \"t\"]`. The error classes and their messages are already "
      + "in the file." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("scheduler-in-place", { changed: ["src/schedule.ts"] })],
  }),
  task({
    id: "hard-conditional-http", pack: "hard", fixture: "docs-api", setup: "add-conditional-requests",
    prompt: "Add conditional requests to this document service's `GET`, `HEAD` and `PUT /docs/:id`. Every 200 response "
      + "carries a strong `ETag` (a quoted string, never `W/`) derived from the JSON representation: the same document "
      + "content always has the same tag, in any `createApp()`, and changed content has a different one. GET with "
      + "`If-None-Match` answers 304 with an empty body and the `ETag` header when any listed tag matches the current one by "
      + "weak comparison (`W/\"x\"` matches `\"x\"`) or the header is `*`; otherwise a normal 200. GET and HEAD answers with "
      + "status 200 or 304 carry `Cache-Control: no-cache`. HEAD answers exactly what GET would (status and headers, 304 and "
      + "404 included) with no body. PUT requires `If-Match`: "
      + "without it the answer is 428 `precondition_required`; when no listed tag matches by strong comparison (a weak "
      + "tag never matches) and the header is not `*`, 412 `precondition_failed`. Headers may list several comma-separated "
      + "tags. The exception is `PUT` with `If-None-Match: *`, which only creates: on a missing document it creates it and "
      + "answers 201 with the document, `Location: /docs/<id>` and its ETag; on an existing one it is 412 "
      + "`precondition_failed`. Any other request for an unknown document is 404 `not_found` before any precondition. A "
      + "rejected PUT writes nothing. The successful update answers 200 with the updated document and its new ETag." + RULES,
    conventions: [
      onlyEdits("src/", "tests/"),
      convention("errors-through-jsonError", { contains: [{ path: "src/handlers.ts", text: "precondition_failed" }], noMatch: [{ text: "new Response(JSON", under: "src/handlers.ts" }] }),
    ],
  }),
  task({
    id: "hard-rate-limiter", pack: "hard", fixture: "rate-limiter", setup: "add-rate-limiter",
    prompt: "Implement `RateLimiter` in src/limiter.ts (the types there are the API): a token bucket per key. `capacity` "
      + "and `refillPerSecond` must be positive integers, otherwise throw RangeError; time comes only from the injected "
      + "`now()` (default `Date.now`), read on every call. A new key starts with a full bucket. Tokens refill continuously, "
      + "fractions included, at `refillPerSecond` per second, and a bucket never holds more than `capacity`. If the clock "
      + "goes backwards, no tokens are added and none are lost. `take(key, cost = 1)`: `cost` must be a non-negative integer "
      + "no larger than `capacity` (RangeError otherwise); cost 0 is a probe that is always allowed and uses nothing. When the "
      + "bucket holds at least `cost` tokens they are used and the "
      + "answer is `{ allowed: true, remaining, retryAfterMs: 0 }`; otherwise nothing is used and the answer is `{ allowed: "
      + "false, remaining, retryAfterMs }`, where `retryAfterMs` is the exact number of milliseconds, rounded up, until this "
      + "cost would be allowed. `remaining` is the whole tokens left after the call. `reset(key)` forgets a key, so its next "
      + "take starts full; the `size` getter counts keys whose bucket is not full now, and a bucket that refilled to full is "
      + "forgotten." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("limiter-in-place", { changed: ["src/limiter.ts"] })],
  }),
];

/** Tasks for confirming the request checklist against Pi (docs/superpowers/specs/2026-09-27-harder-pack-design.md):
 * 30-35 cases per task, all stated in the prompt as prose, several deliberate departures from a well-known
 * convention, one hidden test per case. Calibrated on Pi only. */
export const HARDER_PACK: readonly EvalTask[] = [
  task({
    id: "harder-csv-reader", pack: "harder", fixture: "csv-reader", setup: "add-csv-reader",
    prompt: "Implement `readCsv(text, options?)` in src/csv.ts (the types there are the API), returning "
      + "`{ rows, problems }`. Rows end at `\\n` or `\\r\\n`; a lone `\\r` is ordinary data (`\"a\\rb,c\"` reads as one "
      + "row `[\"a\\rb\", \"c\"]`). Fields split on `delimiter`, default `,`. `quote` (default `\"`) must be one "
      + "character other than `\\n` or `\\r`, otherwise throw RangeError `invalid quote`. `delimiter` must be one "
      + "character other than the quote, `\\n` or `\\r`, otherwise throw RangeError `invalid delimiter`; a delimiter "
      + "equal to the quote is always `invalid delimiter`, never `invalid quote`. A quoted "
      + "field may contain the delimiter and newlines. A doubled quote inside a quoted field is one quote character. "
      + "Inside a quoted field, a backslash before the quote character is a literal quote and a doubled backslash is "
      + "one backslash; everywhere else a backslash is literal, including inside an unquoted field and a lone "
      + "backslash inside quotes. A quote character inside an unquoted field is literal (`ab\"c` stays `ab\"c`). Text "
      + "between a closing quote and the next delimiter or row end is a problem `text after closing quote` at that "
      + "text's column, and the field keeps the quoted content. A quote still open at the end of input is a problem "
      + "`unterminated quote` at the opening quote's line and column, and that row is dropped. Empty input gives no "
      + "rows and no problems. A newline at the very end of the input does not add a row. Lines that are empty or "
      + "contain only spaces and tabs are skipped wherever they occur, but a row of one or more empty fields (such as "
      + "a line that is just the delimiter) is kept. With a `comment` option, a line whose first character matches it "
      + "is skipped; a line with spaces before the comment character is an ordinary row. A comment character inside a "
      + "quoted multi-line field is data, never a comment marker. `trim` (default false): when true, spaces and tabs "
      + "around an unquoted field are removed; whitespace outside a quoted field is ignored and whitespace inside it "
      + "is kept. With `trim: false`, whitespace before an opening quote makes the whole field unquoted and literal (a "
      + "leading space turns `\"a\"` into ` \"a\"`, quotes and all). A leading byte-order mark (U+FEFF) is ignored. "
      + "With `header: true`, the first row after any skipped lines names the columns, and every later row is an "
      + "object instead of an array. Header names are always trimmed, even with `trim: false`. A header name that "
      + "repeats gets `_2`, `_3`, and so on, in order (`a,a,a` becomes `a`, `a_2`, `a_3`); an empty header name "
      + "becomes `column<N>`, where N is its 1-based position. With a header, a row with fewer fields than the header "
      + "sets the missing columns to `null`, with no problem; a row with more fields is a problem `too many fields` at "
      + "the first extra field's column, and the extra fields are dropped while the row is kept. Without a header, "
      + "rows may differ in length with no problem. `line` on a problem is the 1-based physical line where it occurs, "
      + "counting newlines inside quoted fields even though they don't end the row; `column` is the 1-based character "
      + "position within that physical line. `columns` (a map of column name to `\"number\"`, `\"boolean\"` or "
      + "`\"date\"`) requires `header: true`, otherwise throw RangeError `columns requires header`; a `columns` key "
      + "that is not one of the header names is a problem `unknown column <name>` at the header row's line, column 1. "
      + "A `number`, `boolean` or `date` conversion problem is reported at the value's line and the column where its "
      + "field starts, the opening quote's column when the field is quoted. `number` accepts, after trimming, an "
      + "optional `-` then digits with an optional `.` and more digits, where `_` "
      + "may separate digit groups (`1_000` reads as 1000); forms like `1e3`, `0x10`, `.5` or `5.` are a problem "
      + "`not a number in column <name>`. `boolean` accepts `true`, `false`, `yes`, `no`, `1` or `0`, "
      + "case-insensitively; anything else is a problem `not a boolean in column <name>`. `date` accepts a real "
      + "calendar date `YYYY-MM-DD` and keeps it as the same string (never a Date object); an impossible date such as "
      + "`2023-02-29` is a problem `not a date in column <name>`. For a typed column, an empty value is `null`; a "
      + "value that fails its conversion stays as the original string in the row (still a problem). Problems are "
      + "always returned ordered by line, then column." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("csv-reader-in-place", { changed: ["src/csv.ts"] })],
  }),
  task({
    id: "harder-cron-next", pack: "harder", fixture: "cron-next", setup: "add-cron-next",
    prompt: "Implement `nextRun(expression, after)` and `nextRuns(expression, after, count)` in src/cron.ts (the "
      + "`CronError` class there is the API), finding when a cron expression next matches, in UTC. Fields are "
      + "separated by one or more spaces or tabs; whitespace at the ends of the expression is ignored. An "
      + "expression has five fields: minute (0-59), hour (0-23), day of month (1-31), month (1-12) and weekday "
      + "(0-7, where 0 and 7 are both Sunday); an optional sixth field is the year (1970-2199), with the same "
      + "syntax as the rest. Any other number of fields is `CronError` `expected 5 or 6 fields, got <n>`, with "
      + "`field` null. `*` matches every value. A field may be a comma-separated list such as `1,5,10`; a value "
      + "may repeat. A field may be a range `1-5`. A range whose start is above its end wraps around the field's "
      + "own values (`22-2` in the hour field is 22, 23, 0, 1, 2; `FRI-MON` in the weekday field is Friday through "
      + "Monday). A field may carry a step, `*/15` or `10-50/20`. A single value followed by a step, such as "
      + "`5/15` in the minute field, means from that value up to the field's maximum in steps of that size (5, "
      + "20, 35, 50). A step of 0, or a step that is not a number, is `CronError` `<field>: invalid step`. The "
      + "month field also accepts the names `JAN`-`DEC` and the weekday field the names `SUN`-`SAT`, in any case; "
      + "a name may be used as a range end, as a list item, or as the value before a step's slash — the step "
      + "itself must always be a plain number. A value outside its field's range is `CronError` `<field>: <value> "
      + "out of range <min>-<max>`. Any other token is `CronError` `<field>: invalid token \"<token>\"`; when more "
      + "than one field is invalid, the error names the leftmost one. `?` means the same as `*`, but only in the "
      + "day-of-month and weekday fields — elsewhere it is an invalid token. When both the day-of-month field and "
      + "the weekday field are restricted (neither is `*` nor `?`), a day must match both of them, not either; "
      + "when only one of the two is restricted, only that one applies. `L` in the day-of-month field means the "
      + "month's last day. A weekday name or number (0-7) followed by `L`, such as `5L` or `FRIL`, means the "
      + "month's last such weekday. `L` combines with nothing else in its field: `L,15` in the day-of-month field "
      + "is an invalid token, as a whole. `L` used any other way is an invalid token."
      + " The returned time is always strictly after `after`; a time equal to `after` never counts. Seconds and "
      + "milliseconds of `after` are ignored when matching, and the result's own seconds and milliseconds are "
      + "always 0 — `after` at 10:00:30 with `* * * * *` gives 10:01:00, not 10:00:00. Everything is computed in "
      + "UTC, whatever time zone the process runs in. The search crosses month and year ends as needed; `0 0 29 2 "
      + "*` finds the next 29 February, even when that is four years away. When there is no match at or before "
      + "the same instant 8 calendar years after `after`, `nextRun` throws `CronError` `never runs` with `field` "
      + "null; with a year field, it throws that same error as soon as every year the field allows is already "
      + "before `after`'s year, without waiting for the 8-year window. An `after` that is an Invalid Date throws "
      + "`RangeError`. `nextRuns(expression, after, count)` returns `count` successive results; `count` must be an "
      + "integer from 1 to 1000, or it throws `RangeError` — and in `nextRuns`, an invalid `count` or an invalid "
      + "`after` is reported before the expression is even looked at."
      + " An expression may instead be one of the macros `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly` or "
      + "`@annually` — lowercase, and nothing else in the expression. `@hourly` is `0 * * * *`; `@daily` is `0 0 * "
      + "* *`; `@weekly` is `0 0 * * 0` (Sunday at 00:00); `@monthly` is `0 0 1 * *`; `@yearly` and `@annually` are "
      + "both `0 0 1 1 *`. Anything else that starts with `@` is `CronError` `unknown macro <expression>`, using "
      + "the whole trimmed expression, with `field` null. On a field error, `CronError`'s `field` names the field "
      + "responsible: `minute`, `hour`, `day`, `month`, `weekday` or `year`; it is null for an error about the "
      + "whole expression (a wrong field count, an unknown macro, or never running)." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("cron-in-place", { changed: ["src/cron.ts"] })],
  }),
  task({
    id: "harder-semver-range", pack: "harder", fixture: "semver-range", setup: "add-semver-range",
    prompt: "Implement `parse`, `compare`, `satisfies`, `maxSatisfying`, `minSatisfying` and `sort` in "
      + "src/semver.ts (the `SemverError` class and the `ParsedVersion` type there are the API). A version is "
      + "`MAJOR.MINOR.PATCH`, each a non-negative integer with no leading zeros (`01.2.3` is invalid). A leading "
      + "`v` or `=` and surrounding whitespace are accepted and ignored (`\" v1.2.3 \"` parses the same as "
      + "`\"1.2.3\"`); this leading `v` or `=` is also accepted on every version written inside a range, such as "
      + "`>=v1.2.3`. A prerelease is a `-` followed by dot-separated identifiers of letters, digits and `-`; a "
      + "purely numeric identifier has no leading zeros (`1.0.0-01` is invalid) and is compared and returned as a "
      + "number, never a string. Build metadata is a `+` followed by dot-separated identifiers of the same "
      + "characters, and build identifiers may have leading zeros (`1.2.3+007` is valid). Build metadata is "
      + "parsed into `build` as an array of strings and is ignored everywhere, including inside ranges — "
      + "`1.2.3+b` satisfies the range `1.2.3`, and `compare(\"1.0.0+a\", \"1.0.0+b\")` is `0`. An "
      + "invalid version, given to `parse` or `compare`, is a `SemverError` whose message is `invalid version "
      + "\"<text>\"`, quoting the text exactly as passed in, without trimming. `compare` orders two versions by "
      + "major, then minor, then patch, numerically. A version with a prerelease is lower than the same "
      + "major.minor.patch without one. Prerelease identifiers are compared one at a time in order: two numeric "
      + "identifiers compare numerically, two non-numeric identifiers compare by ASCII, a numeric identifier is "
      + "always lower than a non-numeric one, and when every shared identifier is equal, the prerelease with "
      + "fewer identifiers is lower — so `1.0.0-alpha` is lower than `1.0.0-alpha.1`, which is lower than "
      + "`1.0.0-alpha.beta`, which is lower than `1.0.0-beta`, which is lower than `1.0.0-beta.2`, which is lower "
      + "than `1.0.0-beta.11`, which is lower than `1.0.0-rc.1`, which is lower than `1.0.0`."
      + " `satisfies(version, range, options?)` checks a version against a range. A range is one or more "
      + "comparators: `<`, `<=`, `>`, `>=`, `=`, or a bare version (no operator) all mean what they say, `=` and "
      + "bare meaning exactly that version. `!=` excludes exactly that version and nothing else. Whitespace "
      + "between an operator and its version is allowed (`>= 1.2.3`). Comparators separated by whitespace must "
      + "all hold at once; `||` separates independent alternatives and only one alternative needs to hold; "
      + "whitespace around each side of `||` is ignored. `*`, `x`, `X`, and an empty range (after trimming "
      + "whitespace) match every release. `1.x`, `1.2.*`, a bare `1`, and a bare `1.2` are x-ranges: any missing "
      + "or wildcarded (`x`, `X`, `*`) part after the major (or after major.minor) leaves that whole tail free, so "
      + "`1.2` means `>=1.2.0 <1.3.0`. After an operator, a partial version (missing minor and/or patch) expands "
      + "the same way: `>1.2` means `>=1.3.0`, `>=1.2` means `>=1.2.0`, `<1.2` means `<1.2.0`, and `<=1.2` means "
      + "`<1.3.0`. A hyphen range `A - B` (whitespace required on both sides of the hyphen) includes both ends. In "
      + "a hyphen range, a partial right end is an x-range bound taken from its upper edge (`1.2 - 2.3` means "
      + "`>=1.2.0 <2.4.0`), while a partial left end is zero-filled to its lower edge. A tilde range `~1.2.3` "
      + "means `>=1.2.3 <1.3.0`; `~1.2` means `>=1.2.0 <1.3.0`; `~1` means `>=1.0.0 <2.0.0`. A caret range "
      + "`^1.2.3` means `>=1.2.3 <2.0.0`. A caret range never pins the minor or patch below `1.0.0`: `^0.2.3` "
      + "means `>=0.2.3 <1.0.0`, and `^0.0.3` also means `>=0.0.3 <1.0.0` — the caret's upper bound is `1.0.0` "
      + "when the major version is `0`, and otherwise the next major version above it."
      + " A version with a prerelease satisfies a range only when at least one comparator written in that same "
      + "alternative — after `~`, `^`, a hyphen range or an x-range are expanded to their lower and upper bounds — "
      + "carries a prerelease whose major, minor and patch match the tested version's; an expanded upper bound "
      + "never carries a prerelease, only a range's written lower bound can (so `1.2.4-beta` does not satisfy "
      + "`>=1.2.3`, but `1.2.3-beta.2` does satisfy `>=1.2.3-beta.1`, because that comparator's own version, "
      + "`1.2.3-beta.1`, is a prerelease of the same major.minor.patch). A `!=` comparator never counts toward "
      + "this rule. Passing `{ includePrerelease: true }` to `satisfies` drops this rule entirely, so any version "
      + "that fits the plain numeric bounds satisfies the range regardless of prerelease. An invalid range is a "
      + "`SemverError` `invalid range \"<range>\"`, quoting it exactly as given; an empty side of `||` (such as "
      + "`\"1.2.3 || \"`) is invalid the same way, even though a wholly empty range matches everything. "
      + "`satisfies` never throws for an invalid version — it returns `false` instead (an invalid range still "
      + "throws)."
      + " `maxSatisfying(versions, range)` returns whichever string in `versions` satisfies `range` and is the "
      + "highest by `compare`, exactly as it was given in the list (never renormalized); `minSatisfying` returns "
      + "the lowest the same way; both return `null` when nothing in the list satisfies. Both skip any version in "
      + "the list that fails to parse, rather than throwing."
      + " `sort(versions)` returns a new array in ascending order by `compare`, leaving the array passed in "
      + "untouched; versions that compare equal keep their relative order from the input. Any version that fails "
      + "to parse is placed after every valid one, in the order those invalid versions appeared in the input." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("semver-in-place", { changed: ["src/semver.ts"] })],
  }),
  task({
    id: "harder-url-router", pack: "harder", fixture: "url-router", setup: "add-url-router",
    prompt: "Implement `Router` and `RouteError` in src/router.ts (the `Match` type there is the API). `add(method, "
      + "pattern, name)` registers a route; `match(method, path)` finds the best one for a request. A pattern's "
      + "segments are its parts between `/`; a segment that isn't one of the forms below is static, and is compared "
      + "as literal text against the request's own segment at that position, case-sensitively. A segment written "
      + "`:name` is a param: it matches exactly one non-empty segment of the request path and captures it into "
      + "`params.name`. A param name — used by `:name`, `:name?` and `:name<type>` alike — must match "
      + "`[A-Za-z_][A-Za-z0-9_]*`; any other name is RouteError `invalid param name`. `:name<int>` matches only ASCII "
      + "digits and `:name<slug>` matches only lowercase letters, digits and `-`; either way the value captured into "
      + "`params` stays a string, never converted to a number. A type other than `int` or `slug` is RouteError "
      + "`unknown param type <type>`. `:name?` is optional: it is allowed only as a pattern's last segment, otherwise "
      + "RouteError `optional param must be last`. A request whose path ends one segment short of the pattern still "
      + "matches, and the optional's key is then missing from `params` altogether, never present with an empty "
      + "string. `*` or `*name` as a pattern's last segment is a wildcard: it matches the rest of the request path — "
      + "zero or more remaining segments, rejoined with `/` — into `params[\"*\"]` or `params.name`, without a leading "
      + "slash; used anywhere but last it is RouteError `wildcard must be last`. A wildcard's own name, when given, "
      + "is simply whatever text follows the `*`, with no character restriction of its own. Segments are checked left "
      + "to right as a pattern is registered, and within one segment a bad name is reported before a bad type, which "
      + "is reported before a bad position (an optional or wildcard that isn't last). A pattern must start with `/`, "
      + "else RouteError `pattern must start with /`. A trailing slash on a pattern is ignored too, except the "
      + "pattern `/` itself. Precedence between two routes is decided by comparing their patterns segment by segment "
      + "from the left: at the first segment where their kinds differ, the better kind wins, in this order — static, "
      + "then a typed param, then a plain param, then an optional param, then a wildcard; `<int>` and `<slug>` rank "
      + "equally as typed params. When every compared segment ties and one pattern simply runs out of segments before "
      + "the other, the pattern with fewer segments is the more specific one and ranks higher. Registration order "
      + "plays no part in any of this. Among routes still tied on precedence after that comparison, `list()` (below) "
      + "always orders them by which was added first. For matching, that same first-added rule decides only between "
      + "routes tied on precedence that would each serve the request's method the same way — for instance, two routes "
      + "both registered for that exact method, or two both registered `ANY`; it does not decide between routes tied "
      + "on precedence that serve the method differently (a route for the exact method always wins there, as "
      + "described below, whichever was added first). Registering the same method and the same pattern shape twice is "
      + "RouteError `duplicate route`; two patterns have the same shape when they have the same segments in order, "
      + "comparing a static segment by its literal text and any other segment only by its kind (and, for a typed "
      + "param, its type), always ignoring param and wildcard names — so `/a/:x` and `/a/:y` collide, but "
      + "`/a/:x<int>` and `/a/:y` do not, and neither do `/a/:x<int>` and `/a/:y<slug>`. The same pattern registered "
      + "under two different methods, such as `ANY` and `GET`, is never a duplicate of itself. Before any matching "
      + "happens, a request path is normalized: its query string and fragment — everything from the first `?` or `#` "
      + "onward — are dropped; repeated `/` characters count as one; and a trailing `/` is then ignored the same way "
      + "as on a pattern, except the root `/` itself. What is left is split on its remaining `/` characters into "
      + "segments, and each segment is percent-decoded on its own: a param's captured value is this decoded text "
      + "(`%20` decodes to a space), and an encoded slash `%2F` stays inside its own segment, decoding to a literal "
      + "`/` inside that value rather than starting a new segment. A static segment is compared against a request "
      + "segment's decoded form too, so a pattern written `/café` matches a request written `/caf%C3%A9`. Invalid "
      + "percent-encoding, such as `%zz`, or an escaped byte sequence that is not valid UTF-8, makes the match `{ "
      + "status: 400 }` right away, before any route is considered — and so does a request path that does not start "
      + "with `/` to begin with. A route's method, and the method passed to `match`, are both case-insensitive, "
      + "compared and stored upper-case; `list()` prints them upper-case too. To find a match, Router first keeps "
      + "only the routes whose pattern structurally matches the request path — a typed param that fails its "
      + "constraint takes its route out of contention entirely, as above — and groups what's left by how specific "
      + "their pattern is (the same precedence `list()` uses, below). From most specific group to least, it looks for "
      + "a route that serves the request's method: one registered for that exact method, or else one registered `ANY` "
      + "(so an `ANY` route matches every method, including `OPTIONS` — a path an `ANY` route matches never produces "
      + "a 405 — and when a route for the request's exact method is also in that same group, the exact one wins over "
      + "`ANY`, whichever was added first), or else, only when the request's method is `HEAD` and that group has "
      + "neither an exact `HEAD` route nor an `ANY` route, one registered `GET`. The first group with such a route "
      + "gives the match, `{ status: 200, route, name, params }`. When every such group lacks a usable route this "
      + "way, the result is `{ status: 405, allow }`, unless the request's method is `OPTIONS`, which instead gives "
      + "`{ status: 204, allow }`; `allow` is the sorted union of the methods of every route whose pattern matched "
      + "the path, plus `HEAD` whenever `GET` is among them, plus `OPTIONS` always, sorted as plain strings. When no "
      + "route's pattern matches the path at all, the result is `{ status: 404 }`. A successful match's `route` is "
      + "exactly the pattern string passed to `add`, and its `name` is exactly the string given as `name`, neither "
      + "one normalized in any way. `params` holds only these named values — one entry per param, typed param, "
      + "optional param (when present) and wildcard (under `\"*\"` when unnamed) — and nothing at all for a static "
      + "segment. `list()` returns one string per registered route, `\"<METHOD> <pattern>\"` using its stored "
      + "upper-case method and its pattern exactly as registered, in the same precedence order `match` tries routes "
      + "in, ties broken by the order routes were added. This precedence applies across patterns of different lengths "
      + "too: `/a/:x` beats `/a/*` when matching `/a/b`, while `/a/*` alone still matches the longer `/a/b/c`. A "
      + "typed param that fails its constraint is simply not a candidate for that request rather than an error, so "
      + "`/n/:id<int>` registered alongside `/n/:name` lets `/n/abc` fall through to match `/n/:name`, while `/n/42` "
      + "still prefers `/n/:id<int>`." + RULES,
    conventions: [onlyEdits("src/", "tests/"), convention("router-in-place", { changed: ["src/router.ts"] })],
  }),
];
