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
