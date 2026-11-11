import { afterAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { LONG_LINE } from "../src/secrets/patterns";
import { liveOutputHoldsSecret } from "../src/secrets/tool-output";
import { forgetTypedSecrets, rememberTypedSecret } from "../src/secrets/typed";
import { ARMOR_LINES, LIVE_LEAKS, LIVE_LEAKS_2, TYPED_TWO_LINES } from "./fixtures/live-leaks";
import { literalSums, scrubCallers } from "./support/scrub-cases";
import { barlessRowsAfterCut, cases, changedLines, cleanUpLiveDrift, finalScrub, KEY_FILE_LINES, KEY_FILE_TEXTS, missedWindows, OUT_OF_VIEW, settings,
  STATE_PARTS, stateContexts, typedFor } from "./support/live-drift";

// A running command's latest lines reach an ACP app only when liveOutputHoldsSecret says they hold nothing the
// command's final output scrub (scrubToolOutput) would hide (decision 98). The live check runs the same rules in their
// strictest states, at once, without netconan, so this test keeps the two from drifting apart over a collected table,
// fixtures/scrub-cases.json: every input the test files it lists ("from") sent through scrubToolOutput, with the
// environment values, logins and typed secrets they used. It is a copy, so a listed file whose strings changed since
// (a new input), or a test file that calls scrubToolOutput, or names a helper under fixtures or support that does, and
// is not listed, fails here: collect the table again with `bun tests/support/scrub-cases.ts`. Each input runs as a
// command's output, whole and as every window of its whole lines a running command can show (decision 98). Each input
// above and below every input that sets a state runs in tests/secrets-live-drift-states-*.test.ts, split so they run at
// once; the shared parts are in tests/support/live-drift.ts.


// The long-line inputs of secrets-long-lines.test.ts, made the same way instead of stored.
afterAll(cleanUpLiveDrift);

const KB = 100 * 1024;
const fill = (unit: string) => unit.repeat(Math.ceil(KB / unit.length)).slice(0, KB);
const LONG = [
  ...["token", "password ", "a=", "a:", "root / ", "https://a:", "a-", "x", "curl -u ", "mysql ", "x!", "hash $", "secret ",
    "radius-server ", "\"password\":\"b\",", "password=a ", "│ x ", "username a b "].map(fill),
  `${"x".repeat(5000)};const password="Hunter22x";${"y".repeat(5000)};snmp-server community Xyz9comm;${"z".repeat(3000)}`,
  `${"x".repeat(LONG_LINE - "password=Hun".length - 1)} password=Hunter22x and more text ${"q".repeat(6000)}`,
  `SERVICE_ACCOUNT_KEY=${"A".repeat(LONG_LINE * 2)}`,
  "password=a1b2c3x ".repeat(5_000),
  `${"a-".repeat(50_000)}https://u:Pa55word@h`,
];

test("the table is the secrets tests' inputs, and most of them have something the final scrub hides", async () => {
  expect(cases.texts.length).toBeGreaterThan(490);
  typedFor(settings[1]!);
  let changed = 0;
  for (const text of cases.texts) if (await finalScrub(text, settings[1]!) !== text) changed++;
  expect(changed).toBeGreaterThan(170);
});

test("every test file that calls scrubToolOutput, or names a helper under fixtures or support that does, is one the table was collected from, unchanged since", async () => {
  const { callers, helpers } = await scrubCallers(true);
  expect(helpers).toContain("fixtures/pi-scrub");
  expect(callers).toContain("tests/secrets-pi.integration.test.ts");
  expect(callers.length).toBeGreaterThan(5);
  expect(callers.filter((name) => !cases.from.includes(name))).toEqual([]);
  // A new or changed input in a listed file (or its helper) changes the sum of its strings: collect the table again
  // with `bun tests/support/scrub-cases.ts`, which adds that file's new inputs.
  const sums = await literalSums(callers, helpers);
  expect(Object.keys(sums).filter((file) => sums[file] !== cases.sums[file])).toEqual([]);
});

test("wherever a command's final output scrub hides something, its live lines are held back, cut or not", async () => {
  const missed: string[] = [];
  for (const options of settings) {
    typedFor(options);
    for (const tool of ["bash", "powershell"]) {
      for (const text of cases.texts) {
        if (await finalScrub(text, options, tool) === text) continue;
        for (const cut of [false, true]) {
          if (!liveOutputHoldsSecret(text, { ...options, cut })) missed.push(`${tool} cut=${cut} configs=${options.configs ?? true}: ${JSON.stringify(text)}`);
        }
      }
    }
  }
  expect(missed).toEqual([]);
}, 60_000);

test("long lines: where the final scrub hides something, the live lines are held back too", async () => {
  const missed: string[] = [];
  typedFor(settings[0]!);
  for (const text of LONG) {
    if (await finalScrub(text, settings[0]!) === text) continue;
    for (const cut of [false, true]) if (!liveOutputHoldsSecret(text, { ...settings[0]!, cut })) missed.push(`cut=${cut}: ${text.slice(0, 60)}…`);
  }
  expect(missed).toEqual([]);
}, 60_000);

test("every window of whole lines a running command can show is held back where the final scrub hides part of it", async () => {
  // Live output is what the command printed so far, its unfinished last line left out: the output's first lines while
  // it is short (not cut), and once it is long only its latest lines (cut: the lines before them are gone). So each
  // run of whole lines, from the start or from inside, that the final scrub changes must be held back on its own.
  const missed: string[] = [];
  let windows = 0;
  let limited = 0;
  for (const options of settings.slice(0, 2)) {
    typedFor(options);
    for (const text of cases.texts) {
      const scrubbed = await finalScrub(text, options);
      if (scrubbed === text) continue;
      const before = text.split("\n");
      const changed = changedLines(before, scrubbed.split("\n"));
      for (let start = 0; start < before.length; start++) {
        for (let end = start + 1; end <= before.length; end++) {
          if (start === 0 && end === before.length) continue;
          const window = before.slice(start, end).join("\n");
          const hit = before.slice(start, end).flatMap((_, at) => changed.has(start + at) ? [start + at] : []);
          if (!window.trim() || !hit.length) continue;
          // Decision 102's limit: a bar-less table's rows whose header a cut left out.
          if (barlessRowsAfterCut(before, start, hit)) { limited++; continue; }
          windows++;
          if (!liveOutputHoldsSecret(window, { ...options, cut: start > 0 })) missed.push(`cut=${start > 0}: ${JSON.stringify(window)}`);
        }
      }
    }
  }
  expect(windows).toBeGreaterThan(500);
  // The limit is met by the bar-less tables of tests/secrets-files.test.ts, and by nothing else.
  expect(limited).toBeGreaterThan(20);
  expect(missed).toEqual([]);
}, 60_000);

test("a line the final scrub hides because another line names a key file is held without that line, cut or not", async () => {
  for (const [index, text] of KEY_FILE_TEXTS.entries()) {
    const line = text.trimEnd();
    const keyLine = KEY_FILE_LINES[index]!;
    expect(await finalScrub(text, settings[0]!)).toBe(text);
    const scrubbed = await finalScrub(`${line}\n${keyLine}\n`, settings[0]!);
    expect(scrubbed.split("\n")[0]).not.toBe(line);
    for (const cut of [false, true]) expect([line, cut, liveOutputHoldsSecret(text, { ...settings[0]!, cut })]).toEqual([line, cut, true]);
  }
});

test("every window is held back where a key file named elsewhere in the output makes the final scrub hide part of it", async () => {
  const missed: string[] = [];
  let windows = 0;
  for (const options of settings.slice(0, 2)) {
    typedFor(options);
    for (const text of [...cases.texts, ...KEY_FILE_TEXTS]) {
      const plain = await finalScrub(text, options);
      const before = text.split("\n");
      for (const keyLine of KEY_FILE_LINES) {
        for (const first of [true, false]) {
          // The key file's line before the text (scrolled away) or after it (not out yet).
          const lines = (await finalScrub((first ? [keyLine, ...before] : [...before, keyLine]).join("\n"), options)).split("\n");
          if (lines.length !== before.length + 1) continue;
          const after = first ? lines.slice(1) : lines.slice(0, -1);
          if (after.join("\n") === plain) continue;
          for (let start = 0; start < before.length; start++) {
            for (let end = start + 1; end <= before.length; end++) {
              const window = before.slice(start, end).join("\n");
              if (!window.trim() || window === after.slice(start, end).join("\n")) continue;
              windows++;
              // Not cut only when the window starts where the output does, so not after a key file's first line.
              const cut = start > 0 || first;
              if (!liveOutputHoldsSecret(window, { ...options, cut })) missed.push(`cut=${cut} ${keyLine}: ${JSON.stringify(window)}`);
            }
          }
        }
      }
    }
  }
  expect(windows).toBeGreaterThan(KEY_FILE_TEXTS.length);
  expect(missed).toEqual([]);
}, 60_000);

test("every window the final scrub changes by a line out of view is held: the cases review found", async () => {
  const missed: string[] = [];
  typedFor(settings[0]!);
  for (const entry of OUT_OF_VIEW) {
    const options = { ...settings[0]!, ...(entry.configs === false ? { configs: false } : {}) };
    expect([entry.case, await finalScrub(entry.text, options) !== entry.text]).toEqual([entry.case, true]);
    missed.push(...await missedWindows(entry.text, options, entry.case));
  }
  expect(missed).toEqual([]);
});

test("the state pairs (every input above and below every input that sets a state) are all checked, split over their part files", async () => {
  const contexts = stateContexts();
  expect(contexts.length).toBeGreaterThan(50);
  expect(new Set(cases.texts.map((text) => text.replace(/\n$/, ""))).size * contexts.length).toBeGreaterThan(40_000);
  // Each part checks every STATE_PARTS-th input, so together they check every one.
  const parts = (await readdir(import.meta.dir)).filter((name) => /^secrets-live-drift-states-\d+\.test\.ts$/.test(name)).sort();
  expect(parts).toEqual(Array.from({ length: STATE_PARTS }, (_, at) => `secrets-live-drift-states-${at + 1}.test.ts`).sort());
});

test("the last review's leaks: the final scrub hides each value, and every window of each output is held", async () => {
  const missed: string[] = [];
  forgetTypedSecrets();
  for (const leak of [...LIVE_LEAKS, ...LIVE_LEAKS_2]) {
    const options = { ...settings[0]!, ...(leak.env ? { env: leak.env } : {}) };
    const final = await finalScrub(leak.full, options);
    for (const secret of leak.secrets) expect([leak.case, secret, final.includes(secret)]).toEqual([leak.case, secret, false]);
    missed.push(...await missedWindows(leak.full, options, leak.case));
  }
  for (const [full, secret] of ARMOR_LINES) {
    expect([full, (await finalScrub(full, settings[0]!)).includes(secret)]).toEqual([full, false]);
    missed.push(...await missedWindows(full, settings[0]!, "armor"));
  }
  rememberTypedSecret(TYPED_TWO_LINES.value);
  try {
    expect(await finalScrub(TYPED_TWO_LINES.full, settings[0]!)).toBe("a\n<secret hidden>\nb\n");
    missed.push(...await missedWindows(TYPED_TWO_LINES.full, settings[0]!, "typed"));
  } finally { forgetTypedSecrets(); }
  expect(missed).toEqual([]);
});
