import { scrubNote, type Scrubber } from "./netconan";
import { KIND_ORDER, TRUNCATED_MARK, type SecretKind } from "./patterns";
import path from "node:path";
import { exactSecretValues, isKeyFile, isPgpassFile, isSecretFile, livePlainScrubs, loginFileValues, networkLoginValues, scrubPlainSecrets } from "./files";
import { casperAgentDir } from "../runtime/agent-store";
import { terminalText } from "../tui/format";
import { scrubText, shouldScrubCommandOutput, shouldScrubRead, type ScrubTextResult } from "./scrub";

/**
 * Pi keeps the whole output of a long command in <tmp>/pi-bash-<id>.log (or pi-powershell-) and tells
 * the AI that path. Reading it back is command output, so it gets the same config check.
 */
export function isSavedCommandOutput(filePath: string): boolean {
  return /(?:^|[\\/])pi-(?:bash|powershell)-[0-9a-f]+\.log$/i.test(filePath);
}

export interface ToolOutputScrubOptions {
  /** Device-config scrubbing (config files, config-looking output); /secrets files off turns it off. */
  configs?: boolean;
  /** Environment whose secret-named values are hidden; defaults to Casper's own. */
  env?: NodeJS.ProcessEnv;
  /** Casper's login file, whose keys are hidden wherever they show up; defaults to <agent dir>/auth.json. */
  loginFile?: string;
  /** Casper's network login file (~/.casper/network-logins.json), whose tokens are hidden too. */
  networkLoginFile?: string;
}

/**
 * Native tool output the model is about to read. Two passes:
 * - Device configs (while /secrets files is on): config files (.cfg, .conf, .set, or under
 *   configs/backups/oxidized) and command or grep output that looks like a device config.
 * - Always: .env, INI and credential files, secret-named KEY=VALUE lines in command and grep output,
 *   and exact copies of Casper's own secret-named environment values.
 * Source code is never changed by the device pass. Undefined means "leave the result as it is".
 */
export async function scrubToolOutput(scrubber: Pick<Scrubber, "scrubText">, toolName: string, input: Record<string, unknown>,
  texts: string[], signal?: AbortSignal, options: ToolOutputScrubOptions = {}): Promise<{ texts: string[]; note?: string } | undefined> {
  const configs = options.configs ?? true;
  let device: boolean;
  let secretFile = false;
  let keyFile = false;
  let pgpass = false;
  if (toolName === "read") {
    if (typeof input.path !== "string") return undefined;
    secretFile = isSecretFile(input.path);
    keyFile = isKeyFile(input.path);
    pgpass = isPgpassFile(input.path);
    device = configs && (shouldScrubRead(input.path) || (isSavedCommandOutput(input.path) && shouldScrubCommandOutput(texts.join("\n"))));
  } else if (["bash", "powershell", "grep", "service", "browser"].includes(toolName)) {
    // service: a dev server's logs, crash tails and HTTP replies are command output too; browser: a page's text.
    device = configs && shouldScrubCommandOutput(texts.join("\n"));
    // A search that holds lines of a key file (Pi's grep on certs/key.pem, `grep -rn x .`): a key's body goes even without BEGIN or END.
    if (["bash", "powershell", "grep"].includes(toolName)) {
      keyFile = (toolName === "grep" && typeof input.path === "string" && isKeyFile(input.path)) || texts.some(namesKeyFile);
    }
  } else if (toolName === "lsp") {
    // A language server's messages quote source (TypeScript puts literal types in them): the always-on pass only.
    device = false;
  } else return undefined;
  let hidden = 0;
  let failed = false;
  const kinds = new Set<SecretKind>();
  const out: string[] = [];
  const values = [...loginFileValues(options.loginFile ?? path.join(casperAgentDir(), "auth.json")),
    ...options.networkLoginFile ? networkLoginValues(options.networkLoginFile) : []];
  for (const text of texts) {
    let next = text;
    if (device) {
      // A netconan problem (or an abort while it runs) falls back to Casper's own rules.
      const result = await scrubber.scrubText(text, signal).catch(() => ({ ...scrubText(text), netconan: "failed" as const }));
      hidden += result.hidden;
      failed ||= result.netconan === "failed";
      for (const kind of result.kinds) kinds.add(kind);
      next = result.text;
    }
    const plainOptions = { secretFile, keyFile, pgpass, values, ...(options.env ? { env: options.env } : {}) };
    // The service, browser and lsp tools answer in JSON: check each string as it reads, not with its \n escapes.
    const plain = ["service", "browser", "lsp"].includes(toolName) ? scrubJsonStrings(next, (value) => scrubPlainSecrets(value, plainOptions)) : scrubPlainSecrets(next, plainOptions);
    hidden += plain.hidden;
    for (const kind of plain.kinds) kinds.add(kind);
    out.push(plain.text);
  }
  if (!hidden && !failed) return undefined;
  const note = scrubNote({ hidden, kinds: KIND_ORDER.filter((kind) => kinds.has(kind)), ...(failed ? { netconan: "failed" } : {}) });
  return { texts: out, ...(note ? { note } : {}) };
}

/**
 * Whether a file's text holds a secret by the rules a read of that file gets (scrubToolOutput above): the device-config
 * pass for a config file while `configs` is on, and the always-on pass with the file's own kind (.env, key, .pgpass).
 * For text Casper shows rather than hides in place (`casper acp`'s diffs, written text and read previews), so it runs
 * at once, with Casper's own rules for the device pass; while netconan is in use a device config is not shown at all
 * (onlyNetconanChecks below), since netconan may find more than these rules.
 */
export function fileTextHoldsSecret(filePath: string, text: string, options: ToolOutputScrubOptions = {}): boolean {
  if (!text) return false;
  if ((options.configs ?? true) && shouldScrubRead(filePath) && scrubText(text).hidden) return true;
  const values = [...loginFileValues(options.loginFile ?? path.join(casperAgentDir(), "auth.json")),
    ...options.networkLoginFile ? networkLoginValues(options.networkLoginFile) : []];
  return scrubPlainSecrets(text, { secretFile: isSecretFile(filePath), keyFile: isKeyFile(filePath), pgpass: isPgpassFile(filePath), values,
    ...(options.env ? { env: options.env } : {}) }).hidden > 0;
}

/**
 * Whether a running command's latest lines (`casper acp`'s live output, decision 98) may hold anything its final output's
 * scrub (scrubToolOutput above) hides there. When in doubt they do: the final output still comes, scrubbed.
 * - JSON, while /secrets files is on: the device pass reads an output that is JSON whole string by string, with its \n
 *   escapes read as line breaks, and hides everything under a secret-named key. Partial JSON can't be read that way,
 *   so an output that starts as JSON, or shown lines that are a JSON value's ("key": lines, quoted list items), hold.
 * - A secret value of more than one line is hidden only whole, and its last lines may not be out yet: a shown line
 *   that may be one of its lines, as far as the lines next to it show, holds (showsPartOfValue).
 * - The final scrub reads each line in a state other lines set: a line naming a key file anywhere, a key's BEGIN or a
 *   device config anywhere, "tokenid" anywhere, a server or snmp block line or a table header above. Those lines may be
 *   out of view, so the same always-on and device rules run here, at once, with Casper's own rules, in the strictest
 *   state each could set (scrubPlainSecrets' `live`), over the output this step has so far: `before`, the lines above
 *   the ones shown, then `text`, the ones shown (`cut`: `before` does not start where the output did), all in turn and
 *   each alone (livePlainScrubs). Any change to a shown line means they hold one. /secrets files does not matter here:
 *   a key's BEGIN out of view turns the device rules on even with it off.
 */
export function liveOutputHoldsSecret(text: string, options: ToolOutputScrubOptions & { cut?: boolean; before?: string } = {}): boolean {
  if (!text.trim()) return false;
  const before = options.before ?? "";
  return liveOutputReading(before + text, options)(text, before);
}

/**
 * liveOutputHoldsSecret for the windows of shown lines that end where `whole` (the output so far) ends: `text`, the
 * shown lines, after `before`, the ones above them, with `before` + `text` being `whole`. The live scrubs read `whole`
 * whichever lines are shown, so each runs once, when a window first needs it.
 */
export function liveOutputReading(whole: string, options: ToolOutputScrubOptions & { cut?: boolean } = {}): (text: string, before: string) => boolean {
  const cut = options.cut === true;
  const values = [...loginFileValues(options.loginFile ?? path.join(casperAgentDir(), "auth.json")),
    ...options.networkLoginFile ? networkLoginValues(options.networkLoginFile) : []];
  const env = options.env ? { env: options.env } : {};
  const exact = exactSecretValues({ values, ...env });
  const lines = whole.split("\n");
  const scrubs = livePlainScrubs(whole, { keyFile: true, values, live: { cut }, ...env });
  // Each scrub's lines once it has run; null when it changed nothing.
  const done: Array<string[] | null | undefined> = [];
  const scrubbed = (index: number) => {
    if (done[index] === undefined) { const after = scrubs[index]!(); done[index] = after === whole ? null : after.split("\n"); }
    return done[index];
  };
  return (text, before) => {
    if (!text.trim()) return false;
    if ((options.configs ?? true) && (JSON_START.test(whole) || text.split("\n").some((line) => JSON_START.test(line) || JSON_MEMBER.test(line)))) return true;
    if (showsPartOfSecret(text, { before, cut }, exact)) return true;
    const shown = text.split("\n").length;
    return scrubs.some((_, index) => {
      const after = scrubbed(index);
      return !!after && (lines.length !== after.length || lines.slice(-shown).join("\n") !== after.slice(-shown).join("\n"));
    });
  };
}

/** Whether a running command's shown lines (`text`, after `before`) may be part of one of `values` of more than one
 * line, which the final output hides only whole (showsPartOfValue): Casper's own, or the ones the session hides. Read
 * as they are (the final scrub reads them so) and as the session's hiding reads them (terminalText: no colour codes, a
 * lone carriage return a line break), where a value split by colour codes or joined by a carriage return is whole. */
export function showsPartOfSecret(text: string, around: { before: string; cut: boolean }, values: readonly string[]): boolean {
  const several = values.filter((value) => value.includes("\n"));
  if (!several.length || !text.trim()) return false;
  const shown = terminalText(text);
  return [[around.before, text], [terminalText(around.before), shown]].some(([before, lines]) => {
    const all = (before! + lines!).split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
    const from = all.length - lines!.split("\n").length;
    return several.some((value) => showsPartOfValue(all, from, around.cut, value));
  });
}

/** A line that starts a JSON value: a lone brace or bracket, `{"`, `[{`, `["`, `[[`, or a list of numbers or words. */
const JSON_START = /^\s*(?:[{[]\s*$|\{\s*["}]|\[\s*(?:["{[\]]|(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\s*[,\]]))/;
/** A line inside a JSON value as `jq .`, `curl` or ConvertTo-Json prints one: a "key": member or a quoted list item. */
const JSON_MEMBER = /^\s*"(?:[^"\\]|\\.)*"\s*(?::|,?\s*$)/;

/**
 * Whether a shown line (`all` from `from` on: the output so far, its lines) may be one of the lines of `value`, a
 * secret of more than one line: its first line ends with the value's first, a middle line is one of the value's, its
 * last starts with the value's last. The lines next to it must fit the value's too, as far as they are in view: above
 * a cut start or a truncated mark, or below the last line out, they may.
 */
function showsPartOfValue(all: string[], from: number, cut: boolean, value: string): boolean {
  const parts = value.split("\n").map((part) => part.endsWith("\r") ? part.slice(0, -1) : part);
  const last = parts.length - 1;
  const fits = (line: string, at: number) => at === 0 ? line.endsWith(parts[0]!) : at === last ? line.startsWith(parts[last]!) : line === parts[at];
  // Lines above that may not be the output's own: a cut text's first line (maybe cut), a truncated mark and the line
  // after one (maybe cut). Above them the value's other lines may be gone; above the start of a cut text too.
  const gone = (line: number) => (cut && line === 0) || TRUNCATED_MARK.test(all[line]!) || (line > 0 && TRUNCATED_MARK.test(all[line - 1]!));
  for (let index = from; index < all.length; index++) {
    for (let at = 0; at <= last; at++) {
      if (!fits(all[index]!, at)) continue;
      let ok = true;
      for (let part = at - 1, line = index - 1; part >= 0; part--, line--) {
        if (line < 0 || gone(line)) { ok = line >= 0 || cut; break; }
        if (!(ok = fits(all[line]!, part))) break;
      }
      for (let part = at + 1, line = index + 1; ok && part <= last && line < all.length; part++, line++) {
        // The text's last element is the line still being written (empty once the shown lines end): it may yet fit.
        if (line === all.length - 1) break;
        ok = fits(all[line]!, part);
      }
      if (ok) return true;
    }
  }
  return false;
}

/**
 * Whether a file's text is one only netconan can check: a device config (shouldScrubRead) while the config pass is on
 * and netconan is in use. netconan runs on what the AI reads and may find more there than Casper's own rules, but it
 * can't run on text Casper shows at once, so such text is never shown (`casper acp`'s diffs and written text).
 */
export function onlyNetconanChecks(filePath: string, options: { configs?: boolean; netconan: boolean }): boolean {
  return options.netconan && (options.configs ?? true) && shouldScrubRead(filePath);
}

/** Whether any line starts with a key file's name and a line number: "certs/key.pem:2: ...", "./id_rsa-3-...". */
function namesKeyFile(text: string): boolean {
  for (const match of text.matchAll(/^([^\s:]+?)(?::\d+:|-\d+-)/gm)) if (isKeyFile(match[1]!)) return true;
  return false;
}

/** Scrub every string inside a JSON text; text that isn't JSON is scrubbed as it is. */
function scrubJsonStrings(text: string, scrub: (value: string) => ScrubTextResult): ScrubTextResult {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return scrub(text); }
  let hidden = 0;
  const kinds = new Set<SecretKind>();
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const result = scrub(value);
      hidden += result.hidden;
      for (const kind of result.kinds) kinds.add(kind);
      return result.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    return value;
  };
  const next = walk(data);
  return { text: hidden ? JSON.stringify(next) : text, hidden, kinds: KIND_ORDER.filter((kind) => kinds.has(kind)) };
}
