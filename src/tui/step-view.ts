import path from "node:path";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ToolObservationInput } from "../runtime/observation";
import { diffLines } from "./display";
import { commandLabel, displayPath, failureLines, formatDuration, redactPreview, terminalText, tint, type ToolLineFit } from "./format";
import { renderPanel } from "./presentation";
import { checkName, githubLabel } from "./tool-status";

/** A finished step as the folded row names it. `description`: a shell step's title from the AI. */
export interface NamedStep { toolName: string; input?: ToolObservationInput; elapsedMs?: number; description?: string }

/** One kind of step in a folded row: "read a.ts, b.ts", "ran git status, bun test (2m05s)". */
export interface StepPart {
  verb: string;
  names: string[];
  /** The word for one and for many, for "read 13 files". */
  noun: readonly [string, string];
  /** The names are paths: a narrow row shows their file names only. */
  paths: boolean;
}

/** A command that ran this long says so in the row. */
const SLOW_MS = 10_000;

/** One line of untrusted text, short enough for a row. */
function shown(text: string, max = 120): string {
  const line = redactPreview(text).replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : line;
}

/** Verbs a step title often starts with that do not just add -ed, as the fold row says them done. */
const IRREGULAR: Readonly<Record<string, string>> = { run: "ran", rerun: "reran", build: "built", rebuild: "rebuilt", find: "found",
  read: "read", write: "wrote", rewrite: "rewrote", make: "made", get: "got", set: "set", reset: "reset", put: "put", take: "took",
  see: "saw", do: "did", redo: "redid", undo: "undid", keep: "kept", split: "split", cut: "cut", send: "sent", shut: "shut", hold: "held" };
/** Verbs a step title often starts with that add -ed (-d, -ied, or a doubled last letter). */
const REGULAR = new Set(["add", "analyze", "append", "apply", "archive", "back", "block", "boot", "cancel", "change", "check", "clean", "clear",
  "clone", "close", "collect", "commit", "compare", "compile", "configure", "confirm", "convert", "copy", "count", "create", "debug", "delete",
  "deploy", "diff", "disable", "download", "drop", "edit", "enable", "export", "extract", "fetch", "filter", "fix", "follow", "format",
  "generate", "grep", "import", "initialize", "insert", "inspect", "install", "kill", "launch", "lint", "list", "load", "log", "look", "map",
  "mark", "measure", "merge", "monitor", "mount", "move", "open", "parse", "patch", "pause", "ping", "plan", "poll", "prepare", "preview",
  "print", "probe", "pull", "push", "query", "rebase", "reboot", "record", "reinstall", "reload", "remove", "rename", "render", "repair",
  "replace", "replay", "restart", "restore", "resume", "retry", "review", "revert", "save", "scan", "search", "serve", "show", "skip", "sort",
  "start", "stash", "stop", "submit", "summarize", "switch", "sync", "tag", "test", "time", "trace", "trim", "try", "uninstall", "unmount",
  "update", "upgrade", "upload", "validate", "verify", "view", "wait", "watch", "zip"]);
const DOUBLED = new Set(["commit", "debug", "drop", "format", "grep", "log", "map", "plan", "scan", "skip", "stop", "submit", "tag", "trim", "zip"]);

/** "Run the unit tests" → "Ran the unit tests", for the fold row, which says what was done. A title that does not start
 * with one of these verbs is kept as the AI wrote it. */
export function pastTense(title: string): string {
  const match = /^([A-Za-z]+)([\s\S]*)$/.exec(title);
  if (!match) return title;
  const verb = match[1]!, rest = match[2]!, lower = verb.toLowerCase();
  let past = IRREGULAR[lower];
  if (past === undefined && REGULAR.has(lower)) {
    past = DOUBLED.has(lower) ? `${lower}${lower.at(-1)}ed` : lower.endsWith("e") ? `${lower}d`
      : /[^aeiou]y$/.test(lower) ? `${lower.slice(0, -1)}ied` : `${lower}ed`;
  }
  if (past === undefined) return title;
  return `${/^[A-Z]/.test(verb) ? `${past[0]!.toUpperCase()}${past.slice(1)}` : past}${rest}`;
}

/** What a group of finished steps did, by kind, each kind once and in the order it first ran: reads, searches, folders
 * listed, commands run, edits, pages fetched, web searches, checks, and any other tool by its name. The same name is
 * said once. */
export function describeSteps(steps: readonly NamedStep[], fit: ToolLineFit = {}): StepPart[] {
  const parts = new Map<string, StepPart>();
  const add = (verb: string, noun: readonly [string, string], name: string, paths = false) => {
    let part = parts.get(verb);
    if (!part) { part = { verb, names: [], noun, paths }; parts.set(verb, part); }
    if (name && !part.names.includes(name)) part.names.push(name);
  };
  for (const step of steps) {
    const input = step.input ?? {};
    const where = typeof input.path === "string" && input.path ? shown(displayPath(input.path, fit)) : undefined;
    switch (step.toolName) {
      case "read": add("read", ["file", "files"], where ?? "a file", true); break;
      case "ls": add("listed", ["folder", "folders"], where ?? ".", true); break;
      case "grep": case "find": {
        const pattern = typeof input.pattern === "string" ? `"${shown(input.pattern, 60)}"` : "files";
        add("searched", ["search", "searches"], where ? `${pattern} in ${where}` : pattern);
        break;
      }
      case "bash": case "powershell": {
        // The row says the program; a label's "…" for cut words would only repeat the row's own ending.
        const github = githubLabel(input);
        if (github) {
          const [verb, ...target] = github.split(" ");
          add(verb!.toLowerCase(), ["PR", "PRs"], target.join(" "));
          break;
        }
        const slow = step.elapsedMs !== undefined && step.elapsedMs >= SLOW_MS ? ` (${formatDuration(step.elapsedMs)})` : "";
        // A titled step is named by its title, said done: "Ran the unit tests".
        if (step.description) { add(`${pastTense(shown(step.description, 80))}${slow}`, ["step", "steps"], ""); break; }
        const label = typeof input.command === "string" ? commandLabel(redactPreview(input.command), 60).replace(/ …$/, "") : step.toolName;
        add("ran", ["command", "commands"], `${shown(label)}${slow}`);
        break;
      }
      case "edit": case "write": add("edited", ["file", "files"], where ?? "a file", true); break;
      case "web_fetch": add("fetched", ["page", "pages"], typeof input.url === "string" ? shown(input.url.replace(/^https?:\/\//i, ""), 60) : "a page"); break;
      case "web_search": add("searched the web for", ["query", "queries"], typeof input.query === "string" ? `"${shown(input.query, 60)}"` : "something"); break;
      case "casper_check": add("checked", ["check", "checks"], typeof input.check === "string" ? shown(checkName(input.check), 40) : "a check"); break;
      default: add("used", ["tool", "tools"], shown(terminalText(step.toolName), 40));
    }
  }
  return [...parts.values()];
}

/** One part as words: every name, the first `count` and how many more, or only how many. `base`: paths by file name.
 * A part with no names (a titled step) is its words alone. */
function partText(part: StepPart, count: number, base: boolean): string {
  if (!part.names.length) return part.verb;
  const names = base && part.paths ? part.names.map(name => path.basename(name) || name) : part.names;
  const total = names.length;
  if (count >= total) return `${part.verb} ${names.join(", ")}`;
  const noun = part.noun[total === 1 ? 0 : 1];
  if (count <= 0) return `${part.verb} ${total} ${noun}`;
  return `${part.verb} ${total} ${noun}: ${names.slice(0, count).join(", ")} +${total - count} more`;
}

/** The most of one part that fits `room`: every name, then file names for paths, then fewer names with how many
 * more, then only how many. */
function fitPart(part: StepPart, room: number): string {
  for (let count = part.names.length; count > 0; count--) {
    for (const base of part.paths ? [false, true] : [false]) {
      const text = partText(part, count, base);
      if (visibleWidth(text) <= room) return text;
    }
  }
  return truncateToWidth(partText(part, 0, false), room, "…");
}

/**
 * The folded row for a group of steps, muted, after `lead` (└ under the AI's words, ● on its own): every part with all
 * its names on one row when that fits, file names standing in for paths if that is what makes it fit. Otherwise each
 * kind of step takes a row of its own, named as far as the row allows ("read 13 files: a.ts, b.ts +11 more"), so a row
 * names what was done rather than only counting it.
 */
export function stepRows(parts: readonly StepPart[], width: number, lead: string, color: boolean): string[] {
  if (!parts.length) return [];
  const room = Math.max(4, width - visibleWidth(lead) - 1);
  const muted = (line: string) => tint(line, "muted", color);
  for (const base of [false, true]) {
    const one = parts.map(part => partText(part, part.names.length, base)).join(" · ");
    if (visibleWidth(one) <= room) return [`${lead} ${muted(one)}`];
  }
  const pad = " ".repeat(visibleWidth(lead));
  return parts.map((part, index) => `${index ? pad : lead} ${muted(fitPart(part, room))}`);
}

/** An edited file for the edit box: its path as shown, its size, and its diff when the runtime gave one. */
export interface EditedFile { path: string; added?: number; removed?: number; diff?: string }

/** Past this many files the box names how many more instead. */
const BOX_FILES = 9;

/**
 * The files a group of edits changed, in one box: each file's path and `+N -M`, then its changed lines (red and green)
 * up to twelve diff lines per file (Infinity opts into the full diff). A box that could not show every line ends
 * with how many more and the key that shows them all. The same file edited twice is one entry. Changed lines are cut at the edge, never wrapped.
 */
export function renderEditBox(files: readonly EditedFile[], width: number, options: { color: boolean; maxLines?: number }): string[] {
  const { color } = options;
  width = Math.min(120, width);
  const merged = new Map<string, { added: number; removed: number; counted: boolean; lines: ReturnType<typeof diffLines> }>();
  for (const file of files) {
    const entry = merged.get(file.path) ?? { added: 0, removed: 0, counted: false, lines: [] };
    if (file.added !== undefined || file.removed !== undefined) { entry.added += file.added ?? 0; entry.removed += file.removed ?? 0; entry.counted = true; }
    if (file.diff) entry.lines.push(...diffLines(file.diff));
    merged.set(file.path, entry);
  }
  const entries = [...merged.entries()];
  const inner = Math.max(1, width - 4);
  // The normal fold's old group budget must not let the first file consume every preview.
  // Detailed display explicitly opts into the complete diff with Infinity.
  const perFile = options.maxLines === Infinity ? Infinity : 12;
  const named = entries.slice(0, BOX_FILES);
  const moreFiles = entries.length - named.length;
  const totalLines = entries.reduce((sum, [, entry]) => sum + entry.lines.length, 0);
  let shownLines = 0;
  const body: string[] = [];
  const counts = (entry: { added: number; removed: number; counted: boolean }) => entry.counted
    ? `  ${tint(`+${entry.added}`, "diffAdded", color)} ${tint(`-${entry.removed}`, "diffRemoved", color)}` : "";
  for (const [file, entry] of named) {
    const label = truncateToWidth(terminalText(file).replace(/\s+/g, " "), Math.max(1, inner - (entry.counted ? 12 : 0)), "…");
    body.push(`${label}${counts(entry)}`);
    for (const line of entry.lines.slice(0, perFile)) {
      const text = redactPreview(line.text).replace(/\t/g, "  ").replace(/\n/g, " ");
      body.push(tint(truncateToWidth(`  ${line.sign} ${text}`, inner, ""), line.sign === "+" ? "diffAdded" : "diffRemoved", color));
      shownLines++;
    }
  }
  if (moreFiles) body.push(tint(`… ${moreFiles} more ${moreFiles === 1 ? "file" : "files"}`, "muted", color));
  const hidden = totalLines - shownLines;
  if (hidden > 0) body.push(tint(`… ${hidden} more ${hidden === 1 ? "line" : "lines"} · Ctrl+T shows all`, "muted", color));
  const title = `Edited ${entries.length} ${entries.length === 1 ? "file" : "files"}`;
  return renderPanel(title, body, width, color, "accent");
}

/** The edits as plain lines, for a screen with no boxes: "edited a.ts +3 -1, b.ts". */
export function editsLine(files: readonly EditedFile[]): string {
  const seen = new Map<string, string>();
  for (const file of files) {
    const size = file.added !== undefined || file.removed !== undefined ? ` +${file.added ?? 0} -${file.removed ?? 0}` : "";
    seen.set(file.path, `${terminalText(file.path)}${size}`);
  }
  return `edited ${[...seen.values()].join(", ")}`;
}

/** A failed step for its box: the step's own line ("✗ bash · git push — failed") and what it printed. */
export interface FailedStep { title: string; output?: string; home?: string }

/** Rows a failure box shows at most, after wrapping. */
const FAILURE_ROWS = 8;

/**
 * A failed step in an amber box (the work goes on; only the receipt is red): its line as the title, then the last lines
 * it printed as they were (not run together), secrets redacted and the home folder as ~. When more came before, the
 * first row says how many and that Ctrl+T shows them all.
 */
export function renderFailureBox(failure: FailedStep, width: number, color: boolean): string[] {
  const inner = Math.max(1, width - 4);
  const { lines, earlier, focused } = failureLines(failure.output ?? "", { max: 6, ...(failure.home ? { home: failure.home } : {}) });
  const wrapped = lines.flatMap(line => wrapTextWithAnsi(line, inner));
  // Preserve the failure at the start and the counts at the end even when a diagnostic wraps.
  const cut = earlier > 0 || wrapped.length > FAILURE_ROWS;
  const rows = wrapped.length > FAILURE_ROWS - 1 && cut
    ? [...wrapped.slice(0, FAILURE_ROWS - 3), ...wrapped.slice(-2)] : wrapped;
  const above = earlier ? `${earlier} ${focused ? "other" : "earlier"} ${earlier === 1 ? "line" : "lines"}` : "more output";
  const body = [...(cut ? [tint(`… ${above} · Ctrl+T shows all`, "muted", color)] : []), ...rows];
  return renderPanel(failure.title, body, width, color, "warning");
}
