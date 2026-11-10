// What a tool step shows an ACP client (decision 79): the model's arguments, the step's output, an edit's or a write's
// diff, and the files it works on, built from the runtime's own events. Pure: the session's UpdateMapper
// (src/acp/updates.ts) keeps the steps and hides every string these return before it leaves.
//
// The rules every step keeps:
// - text is cut at whole lines, before hiding, so a secret is hidden whole;
// - a file's text (a write's old and new text, an edit's sides, a read's preview, file text in the arguments) is never
//   shown when it holds a secret by the rules a read of that file gets (fileTextHoldsSecret), when the write adds one,
//   or when only netconan could check it (a device config while netconan is in use): a note says so instead;
// - a failed step always carries its error text.

import path from "node:path";
import { delegateEndFields, delegateFields, toolTarget, type DelegateEventFields } from "../app/json-events";
import { nativeEditPath, type ToolObservationInput } from "../runtime/observation";
import type { ToolDisplay } from "../runtime/types";
import { hideCommandSecrets } from "../secrets/files";
import { LINE_MARKER, mayBeAboveKeyEnd, SECRET_MARKER, waitsForNextLine } from "../secrets/scrub";
import type { Json } from "./rpc";

/** A string in the arguments is cut at a line past this. */
export const MAX_ARGUMENT_BYTES = 64 * 1024;
/** A diff side (old or new text) past this is a note instead. */
export const MAX_DIFF_SIDE_BYTES = 256 * 1024;
/** pi's edit patch is kept to this many characters (editPatch): one that long may be cut, so it is not shown. */
const PATCH_KEPT = 65_536;
const TRUNCATED = "\n[...output truncated...]\n";

/** ACP's tool kinds, for the client's icons. */
export function toolKind(tool: string): string {
  if (tool === "read") return "read";
  if (["grep", "find", "ls", "web_search"].includes(tool)) return "search";
  if (["edit", "write"].includes(tool)) return "edit";
  if (["bash", "powershell", "casper_check", "service"].includes(tool)) return "execute";
  if (["web_fetch", "fetch"].includes(tool)) return "fetch";
  if (tool === "delegate") return "think";
  return "other";
}

/** What the session knows about a step from its start. */
export interface StepFacts {
  tool: string;
  /** The model's own arguments. */
  args: Record<string, unknown>;
  /** The runtime's identity fields: the command with its secrets hidden, a write's added secret. */
  input: ToolObservationInput;
  /** The AI's title for a shell step. */
  description?: string;
  /** The file an edit, a write or a read works on, absolute. */
  file?: string;
  /** The MCP server and tool the call reaches. */
  mcp?: { server: string; tool: string };
  delegate?: DelegateEventFields;
}

export interface ShowRules {
  /** Whether a file's text holds a secret (fileTextHoldsSecret): such text is never shown. */
  holdsSecret(file: string, text: string): boolean;
  /** Whether a file's text is one only netconan can check, which runs on what the AI reads but can't run here (a
   * device config while netconan is in use, onlyNetconanChecks): such text is never shown either. */
  unchecked?(file: string): boolean;
}

/** A step's facts from its tool_start: `cwd` is the folder the runtime resolves a relative path from. */
export function stepFacts(event: { toolName: string; input?: ToolObservationInput; description?: string; args?: Record<string, unknown> }, cwd: string,
  mcp?: { server: string; tool: string }): StepFacts {
  const input = event.input ?? {};
  const given = ["edit", "write", "read"].includes(event.toolName) && typeof input.path === "string" ? nativeEditPath(input.path) : undefined;
  return { tool: event.toolName, args: event.args ?? {}, input, ...(event.description ? { description: event.description } : {}),
    ...(given !== undefined ? { file: path.resolve(cwd, given) } : {}), ...(mcp ? { mcp } : {}),
    ...(event.toolName === "delegate" ? { delegate: delegateFields(input) } : {}) };
}

/** `text` in at most `max` bytes, cut at the end of a line, with a note saying so. */
export function cutAtLine(text: string, max: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text) <= max) return { text, cut: false };
  let kept = Buffer.from(text).subarray(0, max).toString("utf8");
  // A character cut in half decodes as U+FFFD at the end.
  kept = kept.replace(/�$/, "");
  const end = kept.lastIndexOf("\n");
  if (end >= 0) kept = kept.slice(0, end + 1);
  else kept = "";
  return { text: `${kept}[... ${Buffer.byteLength(text) - Buffer.byteLength(kept)} more bytes not shown]`, cut: true };
}

/** An output the runtime cut in the middle (head, mark, tail) with its head ending and its tail starting at a whole
 * line, so a secret split by the cut is not half shown. */
export function wholeTail(text: string): string {
  const at = text.indexOf(TRUNCATED);
  if (at < 0) return text;
  const head = text.slice(0, at);
  const tail = text.slice(at + TRUNCATED.length);
  const headEnd = head.lastIndexOf("\n");
  const tailStart = tail.indexOf("\n");
  return `${headEnd >= 0 ? head.slice(0, headEnd) : ""}${TRUNCATED}${tailStart >= 0 ? tail.slice(tailStart + 1) : ""}`;
}

/** `text` in a Markdown code block whose fence no line inside can close. */
export function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const marks = "`".repeat(Math.max(3, longest + 1));
  return `${marks}text\n${text.replace(/\n$/, "")}\n${marks}`;
}

const textBlock = (words: string) => ({ type: "content", content: { type: "text", text: words } });

/** How much of a running command's output its card shows (decision 98): its last 2,000 characters. */
export const LIVE_CHARS = 2000;

/** The whole lines a running command's card shows (decision 98), from its output so far (`cut`: Pi kept only its end),
 * `before`, the output above them as it is, and `pending`, whole lines below them that wait. Left out: a first line
 * that was cut, the lines down to a truncated mark in view and the line after it (which may be cut), and the last line
 * still being written, so a secret is never half shown. Waiting (`pending`): a last run of lines shaped like a key's
 * body (but a plain word at its top), since a key's END with no BEGIN, still to come, would hide them all; the line
 * after them lets them out (waitsForNextLine). */
export function liveLines(text: string, cut: boolean): { before: string; lines: string; pending: string } {
  const done = text.slice(0, text.lastIndexOf("\n") + 1);
  let from = Math.max(0, text.length - LIVE_CHARS);
  let partial = from > 0 ? text[from - 1] !== "\n" : cut;
  const mark = text.lastIndexOf(TRUNCATED);
  if (mark >= 0 && mark + TRUNCATED.length >= from) { from = mark + TRUNCATED.length; partial = true; }
  if (partial) {
    const end = text.indexOf("\n", from);
    from = end < 0 ? text.length : end + 1;
  }
  from = Math.min(from, done.length);
  const lines = done.slice(from).split("\n");
  // The line above the first one shown: one that was cut (or follows a mark) may have been anything.
  const above = done.slice(0, from).split("\n").at(-2);
  const topMayBeKey = partial || (above !== undefined && mayBeAboveKeyEnd(above));
  let keep = lines.length - 1;
  while (keep > 0 && waitsForNextLine(lines[keep - 1]!, keep > 1 ? mayBeAboveKeyEnd(lines[keep - 2]!) : topMayBeKey)) keep--;
  const shown = keep ? `${lines.slice(0, keep).join("\n")}\n` : "";
  return { before: done.slice(0, from), lines: shown, pending: done.slice(from + shown.length) };
}

/** A running shell step's latest lines (decision 98): a `tool_call_update` still `in_progress`, fenced, marked
 * `_meta.casper.live`. Its content is replaced by the next one and by the step's end. */
export function liveUpdate(id: string, lines: string): Json {
  return { sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", content: [textBlock(fence(lines))], _meta: { casper: { live: true } } };
}
const counted = (lines?: { added: number; removed: number }) => lines ? ` (+${lines.added} −${lines.removed})` : "";
const tooLarge = (shown: string, lines?: { added: number; removed: number }) => `Changed ${shown}${counted(lines)}, too large to show here`;
const holdsOne = (shown: string, lines?: { added: number; removed: number }) => `Changed ${shown}${counted(lines)}: not shown, it holds a secret`;
const addsOne = (input: ToolObservationInput) => `Changed ${input.secretWritten}: not shown, it adds a secret${input.secretWhere ? ` at ${input.secretWhere}` : ""}`;
const NOT_SHOWN_ADDS = "<not shown: adds a secret>";
const NOT_SHOWN_HOLDS = "<not shown: holds a secret>";
const uncheckedOne = (shown: string, lines?: { added: number; removed: number }) => `Changed ${shown}${counted(lines)}: not shown, netconan checks this device config only as the AI reads it`;
const NOT_SHOWN_UNCHECKED = "<not shown: a device config netconan checks>";
const tooBig = (text: string) => Buffer.byteLength(text) > MAX_DIFF_SIDE_BYTES;

/** An edit's replacements as the model sent them: `edits` (a list, a JSON string or one object) or the old single pair. */
export function editPairs(args: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
  let edits: unknown = args.edits;
  if (typeof edits === "string") { try { edits = JSON.parse(edits); } catch { edits = undefined; } }
  if (edits && !Array.isArray(edits) && typeof edits === "object") edits = [edits];
  const pairs = Array.isArray(edits) ? edits : [];
  const legacy = typeof args.oldText === "string" && typeof args.newText === "string" ? [{ oldText: args.oldText, newText: args.newText }] : [];
  return [...pairs, ...legacy].flatMap((pair) => pair && typeof pair.oldText === "string" && typeof pair.newText === "string" ? [{ oldText: pair.oldText as string, newText: pair.newText as string }] : []);
}

/** A unified patch's hunks: each one's old and new text (context included) and its first line in the new file. A `-`
 * line inside a hunk is a removal even when it starts with `--`; `\ No newline at end of file` ends that side with no
 * line break. */
export function patchDiffs(patch: string): Array<{ oldText: string; newText: string; line: number }> {
  const hunks: Array<{ old: string[]; new: string[]; oldEnds: boolean; newEnds: boolean; line: number }> = [];
  let hunk: (typeof hunks)[number] | undefined;
  let last: "old" | "new" | "both" = "both";
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) { hunks.push(hunk = { old: [], new: [], oldEnds: true, newEnds: true, line: Math.max(1, Number(header[1])) }); continue; }
    if (!hunk) continue;
    if (line.startsWith("\\")) {
      if (last !== "new") hunk.oldEnds = false;
      if (last !== "old") hunk.newEnds = false;
    } else if (line.startsWith("+")) { hunk.new.push(line.slice(1)); last = "new"; }
    else if (line.startsWith("-")) { hunk.old.push(line.slice(1)); last = "old"; }
    else if (line.startsWith(" ")) { hunk.old.push(line.slice(1)); hunk.new.push(line.slice(1)); last = "both"; }
  }
  const join = (lines: string[], ends: boolean) => lines.length ? `${lines.join("\n")}${ends ? "\n" : ""}` : "";
  return hunks.map((each) => ({ oldText: join(each.old, each.oldEnds), newText: join(each.new, each.newEnds), line: each.line }));
}

/** A tool's text without the notice pi puts after a blank line ("[100 matches limit reached. …]"). */
function withoutNotice(text: string): { body: string; notice?: string } {
  const at = text.lastIndexOf("\n\n[");
  if (at >= 0 && text.trimEnd().endsWith("]")) return { body: text.slice(0, at), notice: text.slice(at + 2).trim() };
  return { body: text };
}

/** grep's matches by file, in the order it found them. Context lines (`path-12- …`) are not matches. */
export function grepShape(text: string, truncated: boolean): Json {
  const { body, notice } = withoutNotice(text);
  const files: Array<{ path: string; matches: Array<{ lineNumber: number; line: string }> }> = [];
  let total = 0;
  for (const line of body.split("\n")) {
    const match = /^(.+?):(\d+): ?(.*)$/.exec(line);
    if (!match) continue;
    const [, file, number, words] = match;
    let entry = files.at(-1);
    if (entry?.path !== file) files.push(entry = { path: file!, matches: [] });
    entry.matches.push({ lineNumber: Number(number), line: words! });
    total++;
  }
  return { shape: "matches", files, total, truncated: truncated || notice !== undefined };
}

/** find's and ls's paths, one a line. */
export function pathsShape(text: string, truncated: boolean): Json {
  const { body, notice } = withoutNotice(text);
  const paths = body.split("\n").map((line) => line.trimEnd()).filter((line) => line && line !== "(empty directory)" && !/^No files found/.test(line));
  return { shape: "paths", paths, total: paths.length, truncated: truncated || notice !== undefined };
}

/** The line a read starts at (its `offset`, 1 when it gave none). */
const readOffset = (args: Record<string, unknown>) => Number.isSafeInteger(args.offset) && (args.offset as number) > 0 ? args.offset as number : 1;

/** What a read showed: where it started, how many lines, the file's length when pi said it, and a picture. */
export function readShape(text: string, args: Record<string, unknown>, file: string | undefined, truncated: boolean): Json {
  const offset = readOffset(args);
  const base = { path: file ?? null, offset };
  if (text.startsWith("Read image file [")) return { ...base, truncated, image: true };
  const { body, notice } = withoutNotice(text);
  const showing = notice ? /^\[Showing lines (\d+)-(\d+) of (\d+)/.exec(notice) : null;
  if (showing) return { ...base, lines: Number(showing[2]) - Number(showing[1]) + 1, totalLines: Number(showing[3]), truncated: true };
  const lines = body === "" ? 0 : body.replace(/\n$/, "").split("\n").length;
  const more = notice ? /^\[(\d+) more lines in file/.exec(notice) : null;
  if (more) return { ...base, lines, totalLines: offset - 1 + lines + Number(more[1]), truncated: true };
  return { ...base, lines, ...(offset === 1 && !truncated ? { totalLines: lines } : {}), truncated };
}

/** web_search's sources and web_fetch's page, from their JSON result; undefined when it is not one. */
export function webShape(tool: string, text: string): Json | undefined {
  let parsed: Record<string, any>;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  const data = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  if (tool === "web_search" && data?.source === "web_search") {
    const sources = (Array.isArray(data.results) ? data.results : []).flatMap((hit: Record<string, unknown>) => hit && typeof hit.url === "string"
      ? [{ url: hit.url, title: typeof hit.title === "string" ? hit.title : "", snippet: typeof hit.snippet === "string" ? hit.snippet : "" }] : []);
    return { query: String(data.query ?? ""), provider: String(data.provider ?? ""), sources, truncated: parsed.truncated === true };
  }
  if (tool === "web_fetch" && data?.source === "web_fetch") {
    return { url: String(data.finalUrl ?? data.url ?? ""), statusCode: Number.isSafeInteger(data.status) ? data.status : null,
      ...(typeof data.title === "string" && data.title ? { title: data.title } : {}), truncated: data.truncated === true || parsed.truncated === true,
      text: typeof data.text === "string" ? data.text : "" };
  }
  return undefined;
}

/** The model's arguments as the client sees them: each string cut at a line past 64 KB with its command-style secrets
 * hidden, a shell command as Casper keeps it, and file text that holds or adds a secret left out. */
export function shownArgs(facts: StepFacts, rules: ShowRules): Record<string, unknown> {
  const fileText = (text: unknown): unknown => {
    if (typeof text !== "string") return text;
    if (facts.input.secretWritten) return NOT_SHOWN_ADDS;
    if (facts.file !== undefined && rules.unchecked?.(facts.file)) return NOT_SHOWN_UNCHECKED;
    return facts.file !== undefined && rules.holdsSecret(facts.file, text) ? NOT_SHOWN_HOLDS : text;
  };
  const args: Record<string, unknown> = { ...facts.args };
  if (["bash", "powershell"].includes(facts.tool) && facts.input.command !== undefined) args.command = facts.input.command;
  if (facts.tool === "write") args.content = fileText(args.content);
  if (facts.tool === "edit") {
    if (Array.isArray(args.edits)) args.edits = args.edits.map((pair) => pair && typeof pair === "object" ? { ...pair, oldText: fileText(pair.oldText), newText: fileText(pair.newText) } : pair);
    else if (typeof args.edits === "string") args.edits = editPairs({ edits: args.edits }).map((pair) => ({ oldText: fileText(pair.oldText), newText: fileText(pair.newText) }));
    else if (args.edits && typeof args.edits === "object") args.edits = { ...args.edits, oldText: fileText(Reflect.get(args.edits, "oldText")), newText: fileText(Reflect.get(args.edits, "newText")) };
    if ("oldText" in args) args.oldText = fileText(args.oldText);
    if ("newText" in args) args.newText = fileText(args.newText);
  }
  const scrub = (text: string) => hideCommandSecrets(cutAtLine(text, MAX_ARGUMENT_BYTES).text).text;
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return scrub(value);
    if (depth > 8) return "[too deep to show]";
    if (Array.isArray(value)) return value.slice(0, 200).map((item) => walk(item, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) => [scrub(key), walk(item, depth + 1)]));
    return value;
  };
  return walk(args, 0) as Record<string, unknown>;
}

/** The step's `tool_call`. */
export function startUpdate(id: string, facts: StepFacts, rules: ShowRules): Json {
  const target = toolTarget(facts.input);
  const update: Json = { sessionUpdate: "tool_call", toolCallId: id, title: target ? `${facts.tool} ${target}` : facts.tool, kind: toolKind(facts.tool),
    status: "in_progress", rawInput: shownArgs(facts, rules) };
  if (facts.file !== undefined) update.locations = [{ path: facts.file, ...(facts.tool === "read" ? { line: readOffset(facts.args) } : {}) }];
  if (facts.tool === "edit" && facts.file !== undefined && !facts.input.secretWritten && !rules.unchecked?.(facts.file)) {
    const pairs = editPairs(facts.args);
    if (pairs.every((pair) => !tooBig(pair.oldText) && !tooBig(pair.newText) && !rules.holdsSecret(facts.file!, pair.oldText) && !rules.holdsSecret(facts.file!, pair.newText))) {
      update.content = pairs.map((pair) => ({ type: "diff", path: facts.file, oldText: pair.oldText, newText: pair.newText }));
    }
  }
  update._meta = { casper: { tool: facts.tool, ...(target ? { target } : {}), ...(facts.description ? { description: facts.description } : {}),
    ...(facts.mcp ? { mcp: facts.mcp } : {}), ...facts.delegate } };
  return update;
}

/** The step's last `tool_call_update`, `completed` or `failed`. */
export function endUpdate(id: string, facts: StepFacts, end: { isError: boolean; display?: ToolDisplay; lines?: { added: number; removed: number }; diff?: string },
  rules: ShowRules): Json {
  const update: Json = { sessionUpdate: "tool_call_update", toolCallId: id, status: end.isError ? "failed" : "completed" };
  const display = end.display ?? { text: "", truncated: false };
  const text = wholeTail(display.text);
  const shell = ["bash", "powershell"].includes(facts.tool);
  if (shell) {
    update.rawOutput = { exitCode: display.exitCode ?? null, truncated: display.truncated };
    if (text.trim()) update.content = [textBlock(fence(text))];
    else if (end.isError) update.content = [textBlock("The command failed and printed nothing.")];
    return update;
  }
  if (end.isError) {
    update.content = [textBlock(text.trim() ? text : `${facts.tool} failed.`)];
    return update;
  }
  const file = facts.file;
  const shown = facts.input.path ?? file ?? facts.tool;
  if (facts.tool === "edit" && file !== undefined) {
    update.rawOutput = { path: file, added: end.lines?.added ?? null, removed: end.lines?.removed ?? null };
    if (facts.input.secretWritten) { update.content = [textBlock(addsOne(facts.input))]; return update; }
    if (rules.unchecked?.(file)) { update.content = [textBlock(uncheckedOne(shown, end.lines))]; return update; }
    const fromPatch = end.diff !== undefined && end.diff.length < PATCH_KEPT ? patchDiffs(end.diff) : undefined;
    if (end.diff !== undefined && fromPatch === undefined) { update.content = [textBlock(tooLarge(shown, end.lines))]; return update; }
    const hunks = fromPatch?.length ? fromPatch : editPairs(facts.args).map((pair) => ({ ...pair, line: undefined as number | undefined }));
    if (hunks.some((hunk) => tooBig(hunk.oldText) || tooBig(hunk.newText))) { update.content = [textBlock(tooLarge(shown, end.lines))]; return update; }
    if (hunks.some((hunk) => rules.holdsSecret(file, hunk.oldText) || rules.holdsSecret(file, hunk.newText))) { update.content = [textBlock(holdsOne(shown, end.lines))]; return update; }
    update.content = hunks.map((hunk) => ({ type: "diff", path: file, oldText: hunk.oldText, newText: hunk.newText }));
    const lines = hunks.flatMap((hunk) => hunk.line === undefined ? [] : [hunk.line]);
    update.locations = lines.length ? lines.map((line) => ({ path: file, line })) : [{ path: file, ...(display.line ? { line: display.line } : {}) }];
    return update;
  }
  if (facts.tool === "write" && file !== undefined) {
    const before = display.before;
    update.rawOutput = { path: file, added: end.lines?.added ?? null, removed: end.lines?.removed ?? null, created: before === null };
    const after = typeof facts.args.content === "string" ? facts.args.content : "";
    if (facts.input.secretWritten) update.content = [textBlock(addsOne(facts.input))];
    else if (rules.unchecked?.(file)) update.content = [textBlock(uncheckedOne(shown, end.lines))];
    else if (before === undefined || (before !== null && tooBig(before)) || tooBig(after)) update.content = [textBlock(tooLarge(shown, end.lines))];
    else if ((before !== null && rules.holdsSecret(file, before)) || rules.holdsSecret(file, after)) update.content = [textBlock(holdsOne(shown, end.lines))];
    else update.content = [{ type: "diff", path: file, oldText: before, newText: after }];
    return update;
  }
  if (facts.tool === "read") {
    update.rawOutput = readShape(text, facts.args, file, display.truncated);
    const { body } = withoutNotice(text);
    // What the model got was scrubbed already; a read whose text the scrubber changed, or that still holds one, is not shown.
    if ((file !== undefined && rules.holdsSecret(file, body)) || body.includes(SECRET_MARKER) || body.includes(LINE_MARKER)) update.content = [textBlock(`Read ${shown}: not shown, it holds a secret`)];
    else if (body.trim()) update.content = [textBlock(fence(body))];
    return update;
  }
  if (facts.tool === "grep") update.rawOutput = grepShape(text, display.truncated);
  else if (facts.tool === "find" || facts.tool === "ls") update.rawOutput = pathsShape(text, display.truncated);
  else if (facts.tool === "web_search" || facts.tool === "web_fetch") {
    const web = webShape(facts.tool, text);
    if (web) {
      const { text: page, ...rest } = web;
      update.rawOutput = rest;
      const words = facts.tool === "web_search"
        ? (rest.sources as Array<{ url: string; title: string }>).map((source) => `- ${source.title ? `${source.title} ` : ""}<${source.url}>`).join("\n")
        : String(page ?? "");
      if (words.trim()) update.content = [textBlock(facts.tool === "web_fetch" ? cutAtLine(words, MAX_ARGUMENT_BYTES).text : words)];
      return update;
    }
  } else if (facts.tool === "delegate") {
    const fields = delegateEndFields(facts.delegate, facts.input, display.text);
    if (fields.part !== undefined) update._meta = { casper: { tool: facts.tool, ...fields } };
  }
  if (text.trim()) update.content = [textBlock(text)];
  return update;
}
