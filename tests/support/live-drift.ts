import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Scrubber } from "../../src/secrets/netconan";
import { KEY_BODY_LINE, LINE_PREFIX } from "../../src/secrets/patterns";
import { mayBeAboveKeyEnd, shouldScrubCommandOutput, waitsForNextLine } from "../../src/secrets/scrub";
import { liveOutputHoldsSecret, scrubToolOutput, type ToolOutputScrubOptions } from "../../src/secrets/tool-output";
import { forgetTypedSecrets, rememberTypedSecret } from "../../src/secrets/typed";
import { CASES_FILE, type ScrubCases } from "./scrub-cases";
import { removeTempDir } from "./temp-dir";

// What tests/secrets-live-drift.test.ts and its parts (tests/secrets-live-drift-states-*.test.ts) share: the collected
// table, the settings it runs under, the final scrub, and the windows a running command can show (decision 98).

export const cases = JSON.parse(await readFile(CASES_FILE, "utf8")) as ScrubCases;

export const scrubber = new Scrubber({ env: { CASPER_NETCONAN: "off" } });
const dir = await mkdtemp(path.join(os.tmpdir(), "casper-live-drift-"));
/** Each test file that imports this calls it after its tests. */
export async function cleanUpLiveDrift(): Promise<void> { forgetTypedSecrets(); await removeTempDir(dir); }
// The tests' logins, as Casper's network login file; Casper's own login file is one that isn't there.
const networkLoginFile = path.join(dir, "network-logins.json");
await writeFile(networkLoginFile, JSON.stringify({ fixture: Object.fromEntries(cases.values.map((value, index) => [`VALUE_${index}_TOKEN`, value])) }));
const loginFile = path.join(dir, "no-such-auth.json");
/** No environment or logins (so no exact value hides what a rule should find), and then the tests' own. */
export const settings: ToolOutputScrubOptions[] = [{ env: {}, loginFile }, { env: cases.env, loginFile, networkLoginFile },
  { env: cases.env, loginFile, networkLoginFile, configs: false }];

/** The secrets the tests typed into Casper's box are hidden with their logins, and with no logins not at all. */
export function typedFor(options: ToolOutputScrubOptions): void {
  forgetTypedSecrets();
  if (options.networkLoginFile) for (const value of cases.typed) rememberTypedSecret(value);
}

export async function finalScrub(text: string, options: ToolOutputScrubOptions, tool = "bash"): Promise<string> {
  return (await scrubToolOutput(scrubber, tool, { command: "./run.sh" }, [text], undefined, options))?.texts[0] ?? text;
}

/**
 * The lines of `before` (an output's) whose text the final scrub (`after`) changed. Line by line when it kept the line
 * count; otherwise (a JSON output written out again, a secret of several lines hidden whole) every line outside the
 * longest run of lines the two share in order, read without their indentation. A blank line is never changed.
 */
export function changedLines(before: string[], after: string[]): Set<number> {
  const changed = new Set<number>();
  if (before.length === after.length) {
    before.forEach((line, index) => { if (line !== after[index]) changed.add(index); });
    return changed;
  }
  const [a, b] = [before.map((line) => line.trim()), after.map((line) => line.trim())];
  const longest = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) longest[i]![j] = a[i] === b[j] ? longest[i + 1]![j + 1]! + 1 : Math.max(longest[i + 1]![j]!, longest[i]![j + 1]!);
  for (let i = 0, j = 0; i < a.length;) {
    if (j < b.length && a[i] === b[j]) { i++; j++; } else if (j < b.length && longest[i]![j + 1]! >= longest[i + 1]![j]!) j++;
    else { if (a[i]) changed.add(i); i++; }
  }
  return changed;
}

// The final scrub reads every line as a key file's when any line of the whole output names one (`grep -rn x .`
// printing certs/key.pem:1:...). That line may have scrolled away or not be out yet, so live lines are read that way
// always.
// The lines here name a key file without starting a key, so what they change is the key-file reading alone.
export const KEY_FILE_LINES = ["certs/key.pem:1:# fixture", "id_rsa:3:# fixture", "./certs/key.pem-2-# fixture"];

// Made-up values: `grep -rn "" config certs` printing 64 hex characters before certs/key.pem's line, and a 40+
// character lowercase-and-digit line next to an id_rsa line. The final scrub hides each only for the key file's line.
export const KEY_FILE_TEXTS = [`config/token.txt:1:${"0123456789abcdef".repeat(4)}\n`, "fixture0lowercase0and0digits0only0line0fortytwo\n"];

// The final scrub reads each line in a state other lines may set, out of view of a running command's latest lines: a
// line naming a key file, a key's BEGIN (which turns the device rules on even with /secrets files off), a device config,
// "tokenid", a key's header lines, a server or snmp block line, a table header. The live check reads its lines in the
// strictest state each could set, after the lines above them that Pi still keeps. Pi keeps an output's last 50 KB or
// 2,000 lines, and the final output is that same keep at the end, so it never holds a line the live check lost. Each
// window of whole lines the final scrub changes is held: read after all the lines above it (Pi kept them all), and read
// alone, cut when it starts inside, against the final scrub of the whole output (`whole`) or of the output from the
// window on (Pi's keep starts there).
/**
 * Results already worked out for one setting: a scrub of the same text, and a cut window read alone, come out the same
 * whichever input sits beside them, so a test that pairs every input with many others checks each once.
 */
export interface Seen {
  scrubs: Map<string, Promise<string>>;
  alone: Map<string, boolean>;
  /** For an input with another below it only: a window read after the lines above it, all of them the input's own. */
  afterLines?: Map<string, boolean>;
}

export async function missedWindows(text: string, options: ToolOutputScrubOptions, label: string,
  range?: { from: number; to: number }, alone: "whole" | "kept" = "whole", seen?: Seen): Promise<string[]> {
  const scrub = (part: string) => {
    if (!seen) return finalScrub(part, options);
    let found = seen.scrubs.get(part);
    if (!found) seen.scrubs.set(part, found = finalScrub(part, options));
    return found;
  };
  const holdsAfterLines = (start: number, end: number, window: string) => {
    const read = () => liveOutputHoldsSecret(window, { ...options, before: start ? `${before.slice(0, start).join("\n")}\n` : "" });
    if (!seen?.afterLines) return read();
    const key = `${start},${end}`;
    let found = seen.afterLines.get(key);
    if (found === undefined) seen.afterLines.set(key, found = read());
    return found;
  };
  const holdsAlone = (window: string, cut: boolean) => {
    if (!seen) return liveOutputHoldsSecret(window, { ...options, cut });
    const key = `${cut}\0${window}`;
    let found = seen.alone.get(key);
    if (found === undefined) seen.alone.set(key, found = liveOutputHoldsSecret(window, { ...options, cut }));
    return found;
  };
  const allowed = plainWordsAboveEnd(text.split("\n"));
  const scrubbed = await finalScrub(text, options);
  if (scrubbed === text) return [];
  const before = text.split("\n");
  const after = changedLines(before, scrubbed.split("\n"));
  const { from, to } = range ?? { from: 0, to: before.length };
  const missed: string[] = [];
  // The final scrub of the output from a window on (Pi's keep starts there) matters only to a window the live check
  // does not hold alone, so it is worked out for such a window's start only, once.
  const kept = new Map<number, Set<number>>();
  const keptFrom = async (start: number) => {
    let found = kept.get(start);
    if (!found) kept.set(start, found = changedLines(before.slice(start), (await scrub(before.slice(start).join("\n"))).split("\n")));
    return found;
  };
  for (let start = from; start < to; start++) {
    for (let end = start + 1; end <= to; end++) {
      const window = before.slice(start, end).join("\n");
      if (!window.trim()) continue;
      // The card holds back a last run of key-body-shaped lines (liveLines' `pending`), but the check reads them too.
      let shownEnd = end === before.length && before[end - 1] === "" ? end - 1 : end;
      while (shownEnd > start && waitsForNextLine(before[shownEnd - 1]!, shownEnd - 2 >= 0 && mayBeAboveKeyEnd(before[shownEnd - 2]!))) shownEnd--;
      const changed = (lines: Set<number>, offset: number) => Array.from({ length: shownEnd - start }, (_, at) => start + at).filter((index) => lines.has(index - offset));
      const whole = changed(after, 0);
      if (whole.length && !allowed(whole) && !holdsAfterLines(start, end, window)) {
        missed.push(`${label} after its lines: ${JSON.stringify(window)} in ${JSON.stringify(text)}`);
      }
      if (holdsAlone(window, start > 0)) continue;
      const alonePart = alone === "whole" ? whole : changed(await keptFrom(start), start);
      if (alonePart.length && !allowed(alonePart)) {
        missed.push(`${label} alone, cut=${start > 0}: ${JSON.stringify(window)} in ${JSON.stringify(text)}`);
      }
    }
  }
  return missed;
}

/** Decision 98's one limit: a plain word (letters only, under 16 characters, waitsForNextLine) at the top of a run of
 * key-body lines, which the final scrub hides only because a key's END with no BEGIN ends that run. It shows at once. */
function plainWordsAboveEnd(lines: string[]): (changed: number[]) => boolean {
  const body = (line: string) => KEY_BODY_LINE.test(line.replace(/\r$/, "").replace(LINE_PREFIX, "").trim());
  return (changed) => changed.every((index) => {
    if (!body(lines[index]!) || waitsForNextLine(lines[index]!, index > 0 && mayBeAboveKeyEnd(lines[index - 1]!))) return false;
    let at = index;
    while (at < lines.length && body(lines[at]!)) at++;
    return at < lines.length && /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.test(lines[at]!);
  });
}

// Made-up values.
const HEX64 = "0123456789abcdef".repeat(4);
const KEY_LINE = "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun";
const key = (...body: string[]) => ["-----BEGIN RSA PRIVATE KEY-----", ...body, "-----END RSA PRIVATE KEY-----"].join("\n");
/** Cases review found, each a window the final scrub hid by a line outside it. */
export const OUT_OF_VIEW: Array<{ case: string; text: string; configs?: false }> = [
  { case: "a 32-hex token after a 64-hex line, key.pem named after", text: `config/a.txt:1:${HEX64}\nconfig/b.txt:1:${HEX64.slice(0, 32)}\ncerts/key.pem:1:# fixture\n` },
  { case: "the same, key.pem named before", text: `certs/key.pem:1:# fixture\nconfig/a.txt:1:${HEX64}\nconfig/b.txt:1:${HEX64.slice(0, 32)}\n` },
  { case: "id_rsa named after", text: `${HEX64}\n${HEX64.slice(0, 32)}\nid_rsa:3:# fixture\n` },
  { case: "a 30-character lowercase line in a key's body", text: key(KEY_LINE, KEY_LINE, "abcdefghijklmnopqrstuvwxyz0123") },
  { case: "a 30-character uppercase line in a key's body", text: key(KEY_LINE, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123") },
  { case: "/secrets files off, a Cisco user line, a key elsewhere", text: `username admin password 0 FixturePw99\n${key(KEY_LINE)}\n`, configs: false },
  { case: "/secrets files off, an SNMP community, a key elsewhere", text: `${key(KEY_LINE)}\nsnmp-server community FixComm1 RO\n`, configs: false },
  { case: "Proc-Type and DEK-Info under a key's BEGIN", text: key("Proc-Type: 4,ENCRYPTED", "DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF", "", KEY_LINE, KEY_LINE) },
  { case: "a PGP key's armor header and checksum", text: `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\n${KEY_LINE}\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----\n` },
  { case: "a RADIUS key below its server line", text: "hostname sw1\naaa new-model\nradius server ISE\n address ipv4 192.0.2.10 auth-port 1812\n key FixtureRadKey99\n!\n" },
  { case: "a Junos community below snmp {", text: "version 21.4R3;\nsystem {\n    host-name r1;\n}\nsnmp {\n    community FixtureComm {\n        authorization read-only;\n    }\n}\n" },
  { case: "a table row below its header", text: "| user | password |\n|---|---|\n| alice | Fixture-Pw-1 |\n" },
  { case: "a token's value row, tokenid after", text: "│ value │ 0b5c7d1e-2f3a-4b6c-8d9e-0f1a2b3c4d5e │\n│ tokenid │ root@pam!ci │\n" },
];

/** The table's inputs that set a state other lines are read in. */
export const SETS_STATE = /-----(?:BEGIN|END) |tokenid|^\s*(?:radius|tacacs)[ -]server\b|^\s*aaa\s+authentication-server|^\s*wlan\s+auth-server|^\s*snmp\s*\{|^\s*[|│┃][^\n]*\b(?:passwords?|secrets?|tokens?|keys?|community|psk|creds)\b|^[^\s:]*(?:\.(?:pem|key|p8)|id_(?:rsa|dsa|ecdsa|ed25519))[:-]\d+[:-]/im;

/** How many test files the state pairs are split into: tests/secrets-live-drift-states-1.test.ts and on. */
export const STATE_PARTS = 6;

/** SETS_STATE without its table header: the inputs that set a state some other way. */
const SETS_OTHER_STATE = new RegExp(SETS_STATE.source.replace(String.raw`|^\s*[|│┃][^\n]*\b(?:passwords?|secrets?|tokens?|keys?|community|psk|creds)\b`, ""), "im");

/** A line drawn only with rule characters: a table's rule, edge or header line. */
const RULE_LINE = /^[\s|│┃║+\-=─━═┼╋╬╪┿╇╈┡┩┣┫╞╡╟╢├┤┌┐└┘┏┓┗┛╔╗╚╝╭╮╰╯╒╕╘╛:]+$/;

/**
 * A table's shape: the characters its rules and its rows' ends are drawn with, whether its rows start with a bar, and its
 * line ends. Tables of one shape set the same state for the lines after them, whatever their words.
 */
function tableShape(text: string): string {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.trim());
  const rules = lines.filter((line) => RULE_LINE.test(line)).join("");
  const edges = lines.filter((line) => !RULE_LINE.test(line)).map((line) => `${line.trim()[0] ?? ""}${line.trim().at(-1) ?? ""}`).join("");
  const frame = [...new Set((rules + edges).replace(/[^|│┃║+\-=─━═┼╋╬╪┿╇╈┡┩┣┫╞╡╟╢├┤┌┐└┘┏┓┗┛╔╗╚╝╭╮╰╯╒╕╘╛:]/g, ""))].sort().join("");
  const bars = lines.filter((line) => !RULE_LINE.test(line)).map((line) => /^\s*[|│┃║]/.test(line) ? "b" : "t").join("");
  return `${frame} ${bars.includes("t") ? (bars.includes("b") ? "mixed" : "no bar") : "bars"} ${text.includes("\r") ? "crlf" : "lf"}`;
}

/**
 * The inputs that set a state, each put above and below every input of the table: every one that sets a state some other
 * way than a table header, and one table per shape. #632's table tests hold about two hundred tables of a few dozen
 * shapes, and every input with every one of them would be most of the suite's time. `all` puts every table in:
 * `bun tests/support/live-drift-all.ts` runs every part so, for a change to src/secrets or the live check (decision 98).
 */
export function stateContexts(all = false): string[] {
  const shapes = new Set<string>();
  const chosen = cases.texts.filter((text) => {
    if (SETS_OTHER_STATE.test(text) || shouldScrubCommandOutput(text)) return true;
    if (!SETS_STATE.test(text)) return false;
    if (all) return true;
    const shape = tableShape(text);
    if (shapes.has(shape)) return false;
    shapes.add(shape);
    return true;
  });
  return [...chosen, ...KEY_FILE_LINES, ...OUT_OF_VIEW.map((entry) => entry.text)].map((text) => text.replace(/\n$/, ""));
}

/**
 * Every window of each input is held where an input that sets a state, above or below it, makes the final scrub change
 * it. Each input with every such input is many pairs, so the inputs are split into `parts` test files that run at once
 * (tests/secrets-live-drift-states-*.test.ts): this checks part `part`, every `parts`th input from the `part`th.
 */
export async function statePairs(part: number, parts: number, all = false): Promise<{ checked: number; missed: string[] }> {
  const contexts = stateContexts(all);
  const missed: string[] = [];
  let checked = 0;
  for (const options of [settings[0]!, { ...settings[0]!, configs: false }]) {
    typedFor(options);
    const seen: Seen = { scrubs: new Map(), alone: new Map() };
    for (const [index, text] of [...new Set(cases.texts.map((entry) => entry.replace(/\n$/, "")))].entries()) {
      if (index % parts !== part - 1) continue;
      const lines = text.split("\n");
      // Above another input, a window's lines above it are this input's own, so the reading after them is the same
      // whichever input sits below.
      const afterLines = new Map<string, boolean>();
      for (const context of contexts) {
        if (context === text) continue;
        checked++;
        const above = context.split("\n").length;
        missed.push(...await missedWindows(`${context}\n${text}\n`, options, "below a state line", { from: above, to: above + lines.length }, "kept", seen));
        missed.push(...await missedWindows(`${text}\n${context}\n`, options, "above a state line", { from: 0, to: lines.length }, "kept", { ...seen, afterLines }));
      }
    }
  }
  return { checked, missed };
}
