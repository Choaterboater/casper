import { expect, test } from "bun:test";
import { scrubAssignments, scrubPlainSecrets, scrubUrlPasswords } from "../src/secrets/files";
import { LONG_LINE, WINDOW_OVERLAP, windowedSpans } from "../src/secrets/patterns";
import { scrubProseSecrets } from "../src/secrets/prose";
import { SECRET_MARKER, scrubText } from "../src/secrets/scrub";

const KB = 100 * 1024;
const fill = (unit: string) => unit.repeat(Math.ceil(KB / unit.length)).slice(0, KB);

test("one very long line is checked in about linear time, whatever it holds", () => {
  // Each of these took seconds on a 100 KB line before (about 5 s for "tokentoken…"); now each takes a few hundred
  // milliseconds even at 200 KB.
  const shapes = ["token", "password ", "a=", "a:", "root / ", "https://a:", "a-", "x", "curl -u ", "mysql ", "x!", "hash $",
    "secret ", "radius-server ", "\"password\":\"b\",", "password=a ", "│ x ", "username a b "];
  const passes: Array<[string, (text: string) => unknown]> = [
    ["device", scrubText], ["addresses", scrubUrlPasswords], ["assignments", (text) => scrubAssignments(text, false)],
    ["secret file", (text) => scrubAssignments(text, true)], ["prose", scrubProseSecrets],
  ];
  const slow: string[] = [];
  for (const shape of shapes) {
    const line = fill(shape);
    for (const [name, pass] of passes) {
      const started = performance.now();
      pass(line);
      const took = performance.now() - started;
      if (took > 500) slow.push(`${JSON.stringify(shape)} ${name}: ${Math.round(took)} ms`);
    }
  }
  expect(slow).toEqual([]);
});

test("a secret inside a long minified line is hidden like one on a short line", () => {
  const line = `${"x".repeat(5000)};const password="Hunter22x";${"y".repeat(5000)};snmp-server community Xyz9comm;${"z".repeat(3000)}`;
  const assigned = scrubAssignments(line, false).text;
  expect(assigned).not.toContain("Hunter22x");
  expect(assigned).toContain(`password="${SECRET_MARKER}"`);
  expect(assigned.startsWith("x".repeat(5000))).toBe(true);
  expect(scrubText(line).text).not.toContain("Xyz9comm");
});

test("a secret across a window edge is hidden, and so is the rest of the line after it", () => {
  // The first window ends at LONG_LINE: "password=Hun" is in it, "ter22x" is not.
  const before = "x".repeat(LONG_LINE - "password=Hun".length - 1);
  const line = `${before} password=Hunter22x and more text ${"q".repeat(6000)}`;
  const result = scrubAssignments(line, false);
  expect(result.text).not.toContain("Hunter22x");
  expect(result.text.startsWith(`${before} password=`)).toBe(true);
});

test("a secret-file value longer than a window is hidden whole", () => {
  const key = "A".repeat(LONG_LINE * 2);
  const result = scrubAssignments(`SERVICE_ACCOUNT_KEY=${key}`, true);
  expect(result.text).toBe(`SERVICE_ACCOUNT_KEY=${SECRET_MARKER}`);
});

test("many secrets on one long line are all hidden", () => {
  const line = "password=a1b2c3x ".repeat(5_000);
  const started = performance.now();
  const result = scrubAssignments(line, false);
  expect(performance.now() - started).toBeLessThan(500);
  expect(result.hidden).toBe(5_000);
  expect(result.text).toBe(`password=${SECRET_MARKER} `.repeat(5_000));
});

test("windows: short lines are checked whole; long ones in overlapping windows that cover every short match", () => {
  const seen: string[] = [];
  windowedSpans("short line", (text) => { seen.push(text); return []; });
  expect(seen).toEqual(["short line"]);
  const long = Array.from({ length: LONG_LINE * 3 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  const windows: string[] = [];
  windowedSpans(long, (text) => { windows.push(text); return []; });
  expect(windows.every((text) => text.length <= LONG_LINE)).toBe(true);
  // Every stretch of WINDOW_OVERLAP characters lies wholly inside some window.
  for (let at = 0; at + WINDOW_OVERLAP <= long.length; at += 97) {
    const piece = long.slice(at, at + WINDOW_OVERLAP);
    expect(windows.some((text) => text.includes(piece))).toBe(true);
  }
});

test("token=<uuid> after a token id: the rewritten rule hides what the old one did", () => {
  const uuid = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
  const other = "3f1c2a4e-9b7d-4e21-8c55-0a1b2c3d4e5f";
  for (const [text, want] of [
    [`api_token=${uuid}`, `api_token=${SECRET_MARKER}`],
    [`tokenid-api_token=${uuid}`, `tokenid-api_token=${SECRET_MARKER}`],
    [`token_id=${uuid}`, `token_id=${uuid}`],
    [`token_id=${uuid}-xtoken=${other}`, `token_id=${uuid}-xtoken=${SECRET_MARKER}`],
    [`client-secret: "${uuid}"`, `client-secret: "${SECRET_MARKER}"`],
  ] as const) expect(scrubProseSecrets(text).text).toBe(want);
});

test("addresses: the rewritten password rule still finds the scheme anywhere in a run", () => {
  expect(scrubUrlPasswords("-https://bot:Pa55word@git.example.com").text).toBe(`-https://bot:${SECRET_MARKER}@git.example.com`);
  expect(scrubUrlPasswords("mongodb+srv://app:Pa55word@db").text).toBe(`mongodb+srv://app:${SECRET_MARKER}@db`);
  expect(scrubUrlPasswords(`${"a-".repeat(50_000)}https://u:Pa55word@h`).text.endsWith(`https://u:${SECRET_MARKER}@h`)).toBe(true);
  expect(scrubPlainSecrets("ssh://git@github.com/o/r.git", { env: {} }).text).toBe("ssh://git@github.com/o/r.git");
});
