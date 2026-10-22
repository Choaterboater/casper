import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { configEntries } from "../task/config-files";
import type { ReceiptItem, ReceiptSection, ReceiptView } from "../task/result";
import { lineText, terminalText, tint } from "./format";
import type { ThemeRole } from "./theme";

/**
 * The receipt card: on a session's rich terminal a task's receipt is laid out in labelled rows under its coloured edge,
 *
 *   ▌ ✗ Failed: test failed
 *   ▌   Checks   ✓ lint 2.1s · ✗ test 4s (exit 1), after 2 repairs · Ctrl+T shows the log
 *   ▌   Changed  15 files
 *   ▌   Config   .casper/project.yaml, package.json
 *   ▌   Devices  build-server: installed a service (/etc/systemd/system/app.service)
 *   ▌            from the commands Casper saw, not checked there
 *   ▌   Next     /verify repair test
 *
 * in this order: what needs you (⚠ first), the checks (one per check, with its time), what changed, config files and
 * risky config lines, other machines, the proof when it is weak or missing, notes (grey, at most three), undo, and
 * what to type next. Green says Verified or Checks passed, red only a failed result, amber everything between (not
 * verified, not checked, incomplete, stopped). A clean pass stays one line. Values wrap under their column; below
 * CARD_MIN_COLUMNS the receipt's own lines are shown instead. The card is drawn from the items the text receipt is
 * printed from (receiptView), so the two never disagree; the plain terminal, --json, one-shot runs and saved receipts
 * keep the text.
 */

/** Below this width the label column leaves too little room: the receipt's own lines are shown instead. */
export const CARD_MIN_COLUMNS = 50;
/** Two columns in, then the label column: "Changed" and "Devices" and two spaces. */
const INDENT = 2;
const LABEL = 9;
/** Under changes on other machines: where Casper read them. */
const DEVICES_READ = "from the commands Casper saw, not checked there";
/** Notes past these are counted ("+2 more · /receipt"); /receipt has every one. */
const NOTES_SHOWN = 3;

export type CardTone = "success" | "warning" | "error";

export interface ReceiptCard {
  tone: CardTone;
  /** Line 1, styled: the verdict and why, or the whole one-line receipt when all is well. */
  title?: string;
  /** Labelled rows, each value styled and on a line of its own. */
  rows: CardRow[];
}

export interface CardRow { label: string; values: string[] }

/** Green for Verified or Checks passed, red only for a failed result, amber for everything between. */
export function receiptTone(view: ReceiptView): CardTone {
  const status = view.verdict?.status;
  return status === "Verified" || status === "Checks passed" ? "success" : status === "Failed" ? "error" : "warning";
}

const MARK: Record<CardTone, string> = { success: "✓", warning: "⚠", error: "✗" };
const ROLE: Record<string, ThemeRole> = { "✓": "success", "✗": "error", "⚠": "warning" };
/** A line without its mark: the row's label and the colour say what the mark said. */
const words = (line: string) => line.replace(/^[✓✗⚠–↻] /, "");

/** The receipt as a card, or undefined when it has no verdict (a receipt of undo lines alone). */
export function receiptCard(view: ReceiptView, color: boolean): ReceiptCard | undefined {
  const verdict = view.verdict;
  if (!verdict) return undefined;
  const tone = receiptTone(view);
  // Every value is one line of untrusted-safe text before it is coloured.
  const plain = (text: string) => terminalText(lineText(text));
  const paint = (text: string, role: ThemeRole) => tint(plain(text), role, color);
  const grey = (text: string) => paint(text, "muted");
  // A line in its own words, its mark coloured: ✓ green, ✗ red, ⚠ amber; a note (–) all grey.
  const marked = (line: string): string => {
    const role = ROLE[line[0] ?? ""];
    return role ? `${paint(line[0]!, role)} ${plain(words(line))}` : line.startsWith("– ") || line.startsWith("↻ ") ? grey(words(line)) : plain(line);
  };
  // On a clean pass what went well is said on line 1; otherwise each goes in its row.
  const items = view.short === undefined ? view.items : view.items.filter((item) => item.fold === undefined);
  const of = (section: ReceiptSection) => items.filter((item) => item.section === section);
  const title = view.short !== undefined
    ? paint([view.short, ...view.items.flatMap((item) => item.fold ? [item.fold] : [])].join(" · "), "success")
    : `${tint(`${MARK[tone]} ${plain(verdict.status ?? "")}`, tone, color, "1")}${verdict.detail ? `: ${plain(verdict.detail)}` : ""}`;

  const open = of("open").sort((a, b) => Number(!a.line.startsWith("⚠ ")) - Number(!b.line.startsWith("⚠ ")));
  const checks = of("checks");
  const named = (item: ReceiptItem) => item.kind === "check" && item.name !== undefined;
  // One chip per check, and what else passed (the browser checks, the tests written from the request).
  const chips = checks.flatMap((item) => named(item) ? [chip(item, paint, plain)] : item.fold ? [`${paint("✓", "success")} ${plain(item.fold)}`] : []);
  const repairs = checks.find((item) => item.kind === "repairs")?.detail;
  // A failed check's log is one key away: Ctrl+T shows the last one in full.
  const failed = checks.some((item) => named(item) && (item.status === "failed" || item.status === "failed on the lab"));
  const chipLine = [`${chips.join(" · ")}${repairs ? `${chips.length ? ", after" : "after"} ${plain(repairs)}` : ""}`, ...failed ? [grey("Ctrl+T shows the log")] : []]
    .filter(Boolean).join(" · ");
  // Checks Casper did not run or count (a run through bash only, checks skipped) say why under the chips.
  const notCounted = of("why").filter((item) => item.kind === "not-verified").map((item) => plain(item.status && item.status !== "Not verified" ? `${item.status}: ${item.detail}` : item.detail ?? words(item.line)));
  const checkLines = [...checks.filter((item) => !named(item) && item.kind !== "repairs" && item.fold === undefined).map((item) => marked(item.line)), ...notCounted];

  const changed = of("changed").map((item) => plain(item.files ? item.files.length <= 3 ? item.files.join(", ") : `${item.files.length} files` : words(item.line)));
  const config = configEntries(view.config).map(plain);
  const risky = of("config").map((item) => `${paint("⚠", "warning")} ${plain(`risky line: ${item.detail ?? words(item.line)}`)}`);
  const devices = of("devices").map((item) => plain(item.name ? `${item.name}: ${item.detail ?? words(item.line)}` : words(item.line)));
  // Changes on another machine are read from the AI's commands: Casper never logs in to check.
  if (of("devices").some((item) => item.line.startsWith("– Changed on "))) devices.push(grey(DEVICES_READ));
  // The proof only when it is missing or weak, and never what line 1 already says.
  const proof = of("why").filter((item) => item.kind !== "not-verified" && item.status !== "Proven" && item.detail !== verdict.detail)
    .map((item) => item.kind === "proof" ? marked(`${item.line.slice(0, 2)}${(item.status ?? "").toLowerCase()}: ${item.detail}`) : plain(`${item.status}: ${item.detail}`));
  const notes = of("notes");
  const undo = of("undo").map((item) => plain(`${(item.status ?? "").replace(/^Undo /, "")}: ${item.detail}`));
  // What to type next, each once: line 1's first, then each row's in order.
  const ordered = [...open, ...checks, ...of("why"), ...of("changed"), ...of("config"), ...of("devices"), ...notes, ...of("undo"), ...of("next")];
  const actions = [...new Set([...verdict.actions ?? [], ...ordered.flatMap((item) => item.actions ?? [])])];
  const next = [...actions.length ? [plain(actions.join(" · "))] : [], ...of("next").filter((item) => !item.actions?.length).map((item) => plain(item.detail ?? words(item.line)))];

  const rows: CardRow[] = [
    { label: "Open", values: open.map((item) => item.line.startsWith("⚠ ") ? marked(item.line) : plain(words(item.line))) },
    { label: "Checks", values: [...chipLine ? [chipLine] : [], ...checkLines] },
    { label: "Changed", values: changed },
    { label: "Config", values: [...config.length ? [config.join(", ")] : [], ...risky] },
    { label: "Devices", values: devices },
    { label: "Proof", values: proof },
    { label: "Notes", values: [...notes.slice(0, NOTES_SHOWN).map((item) => grey(words(item.line))),
      ...notes.length > NOTES_SHOWN ? [grey(`+${notes.length - NOTES_SHOWN} more · /receipt`)] : []] },
    { label: "Undo", values: undo },
    { label: "Next", values: next },
  ];
  return { tone, title, rows: rows.filter((row) => row.values.length) };
}

/** One check: its mark and name, how long it ran, and what happened when it did not pass. Only a failure is red; a check
 * that did not run to the end (timed out, could not start, blocked) is amber, one Casper did not run grey. */
function chip(item: ReceiptItem, paint: (text: string, role: ThemeRole) => string, plain: (text: string) => string): string {
  const name = plain(item.name!);
  const time = item.time ? ` ${paint(item.time, "muted")}` : "";
  const detail = item.detail ? ` (${plain(item.detail)})` : "";
  const note = item.note ? ` (${plain(item.note)})` : "";
  switch (item.status) {
    case "passed": return `${paint("✓", "success")} ${name}${time}${note}`;
    case "passed earlier in this task, reused": return `${paint("✓", "success")} ${name} ${paint("earlier, reused", "muted")}${note}`;
    case "failed": return `${paint("✗", "error")} ${name}${time}${detail}`;
    case "failed on the lab": return `${paint("✗", "error")} ${name} on the lab${time}${detail}`;
    case "timed out": return `${paint("⚠", "warning")} ${name} timed out${item.detail ? ` ${plain(item.detail)}` : ""}`;
    case "could not start": return `${paint("⚠", "warning")} ${name} could not start${detail}`;
    case "blocked": return `${paint("⚠", "warning")} ${name} blocked${detail}`;
    case "stale": return `${paint("⚠", "warning")} ${name} stale ${paint("(files changed after it passed)", "muted")}`;
    case "report": return paint(`${item.name} (a diff, not a check)`, "muted");
    default: return paint(`${item.name} ${item.status ?? ""}${item.detail ? ` (${item.detail})` : ""}`.trim(), "muted");
  }
}

/** The card's rows at this width, each under the coloured edge: line 1 hangs two columns in when it wraps, and each
 * value hangs under the value column. */
export function cardRows(card: ReceiptCard, width: number, color: boolean): string[] {
  const edge = `${tint("▌", card.tone, color)} `;
  const room = Math.max(1, width - 2);
  const out: string[] = [];
  const hang = (text: string, first: string, rest: string) => {
    for (const [index, line] of wrapTextWithAnsi(text, Math.max(1, room - visibleWidth(rest))).entries()) {
      out.push(truncateToWidth(`${edge}${index ? rest : first}${line}`, width, ""));
    }
  };
  if (card.title !== undefined) hang(card.title, "", " ".repeat(INDENT));
  const under = " ".repeat(INDENT + LABEL);
  for (const row of card.rows) {
    const label = `${" ".repeat(INDENT)}${row.label ? tint(row.label.padEnd(LABEL), "muted", color) : " ".repeat(LABEL)}`;
    row.values.forEach((value, index) => hang(value, index ? under : label, under));
  }
  return out;
}

/** The next-step row printed under a card ("Next: 1 Show diff · 2 Undo" and a line for each step's reason) as the card's
 * last rows: its keys on the Next row, or under the card's own Next commands, and the reasons grey under them. */
export function cardNextRows(row: string, tone: CardTone, labelled: boolean, width: number, color: boolean): string[] {
  const [keys = "", ...why] = terminalText(row).split("\n");
  const values = [keys.replace(/^Next: /, ""), ...why.map((line) => tint(line.trim(), "muted", color))];
  return cardRows({ tone, rows: [{ label: labelled ? "Next" : "", values }] }, width, color);
}
