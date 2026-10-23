import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { NO, YES_ONCE } from "../src/app/safe-choices";
import { OTHER_CHOICE } from "../src/tui/choices";
import { Screen } from "./support/conpty";
import { withEnv } from "./support/env";
import { interactiveTerminal } from "./support/tty";

/**
 * Words typed in a box (an answer on the Other row, a comment on an approval) stay in view while they are typed: in
 * full as they wrap, and when the box can't hold them all, the part where the cursor is, with … for the rest. They
 * were cut at 100 characters, so whatever came after never showed.
 */

const QUESTION = "How far should I take this now?";
const OPTIONS = [
  { label: "Just the fix", description: "the smallest change that works" },
  { label: "Fix and tests" },
  { label: "Fix, tests and docs" },
  { label: "Stop here" },
];
/** 40 numbered words, 279 characters: each word shows where it is. */
const WORDS = Array.from({ length: 40 }, (_, index) => `step${String(index + 1).padStart(2, "0")}`);
const LONG = WORDS.join(" ");

type Session = ReturnType<typeof interactiveTerminal>;

/** A rich terminal this size, started. */
function sized(cols: number, rows: number): Session {
  const session = interactiveTerminal();
  session.screen.writer.columns = cols; session.screen.writer.rows = rows;
  session.terminal.setStatus("fixture"); session.terminal.start();
  return session;
}

/** The rows on screen now, as the terminal shows them (not what scrolled away). */
function visible(session: Session): string {
  const screen = new Screen(session.screen.writer.columns, session.screen.writer.rows);
  screen.feed(session.screen.output);
  return screen.visible();
}

/** The words shown on a box's row after its label ("Other — type your own answer —", "No —"), its wrapped rows joined. */
function typedRow(screen: string, label: string): string {
  const lines = screen.split("\n");
  const start = lines.findIndex(line => line.includes(`${label} —`));
  if (start < 0) return "";
  const first = lines[start]!;
  const rows = [first.slice(first.indexOf(`${label} —`) + label.length + 2)];
  // A wrapped row goes on under its label, past the box's indent, the cursor and the number.
  const indent = first.indexOf(label);
  for (let at = start + 1; at < lines.length && lines[at]!.length > indent && /^ +$/.test(lines[at]!.slice(0, indent)) && lines[at]![indent] !== " "; at++) {
    rows.push(lines[at]!);
  }
  return rows.map(row => row.trim()).join(" ").trim();
}

async function waitFor(check: () => boolean, what: () => string): Promise<void> {
  for (let tries = 0; tries < 400 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!check()) throw new Error(`not shown; the screen:\n${what()}`);
}

/** Types the words a few at a time, as a person would, waiting each time for the last one to show on the row. */
async function typeWords(session: Session, label: string, words: readonly string[]): Promise<void> {
  for (let at = 0; at < words.length; at += 3) {
    const some = words.slice(at, at + 3);
    session.input.write(`${at ? " " : ""}${some.join(" ")}`);
    await waitFor(() => typedRow(visible(session), label).endsWith(some.at(-1)!), () => visible(session));
  }
}

test("an answer on the Other row past 100 characters and past the edge shows in full as it wraps; Enter sends all of it", async () => {
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const session = sized(60, 30);
    try {
      const answer = session.terminal.ask(QUESTION, OPTIONS, false, undefined, "ai");
      await waitFor(() => visible(session).includes(OTHER_CHOICE), () => visible(session));
      session.input.write("5");
      await waitFor(() => visible(session).includes(`❯ 5. ${OTHER_CHOICE} —`), () => visible(session));
      await typeWords(session, OTHER_CHOICE, WORDS);
      const screen = visible(session);
      // Every word, in order, on rows no wider than the terminal, and nothing cut.
      expect(typedRow(screen, OTHER_CHOICE)).toBe(LONG);
      expect(screen).not.toContain("…");
      expect(screen).toContain(`  ${QUESTION}`);
      for (const line of screen.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
      session.input.write("\r");
      expect(await answer).toEqual([LONG]);
    } finally { session.close(); }
  });
});

test("an answer too long for a short terminal keeps the words being typed in view, with … for the rest; the question stays", async () => {
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const session = sized(60, 12);
    try {
      const answer = session.terminal.ask(QUESTION, OPTIONS, false, undefined, "ai");
      await waitFor(() => visible(session).includes("Esc to skip"), () => visible(session));
      session.input.write("5");
      await waitFor(() => visible(session).includes(`❯ 5. ${OTHER_CHOICE} —`), () => visible(session));
      // The end, where the letters go, stays in view as the answer outgrows the box.
      await typeWords(session, OTHER_CHOICE, WORDS);
      let screen = visible(session);
      let shown = typedRow(screen, OTHER_CHOICE);
      expect(shown).toStartWith("…");
      expect(shown).toEndWith("step39 step40");
      expect(shown).not.toContain("step01");
      expect(LONG.endsWith(shown.slice(1).replace(/^\S*\s/, ""))).toBe(true);
      // The box still fits the screen: its question above, its keys below.
      expect(screen).toContain(`  ${QUESTION}`);
      expect(screen).toContain("Esc to skip");
      // Back at the start (Home), new words show there, and the rest is "…".
      session.input.write("\x01");
      session.input.write("first ");
      await waitFor(() => typedRow(visible(session), OTHER_CHOICE).startsWith("first step01"), () => visible(session));
      screen = visible(session);
      shown = typedRow(screen, OTHER_CHOICE);
      expect(shown).toEndWith("…");
      expect(shown).not.toContain("step40");
      expect(screen).toContain(`  ${QUESTION}`);
      session.input.write("\r");
      expect(await answer).toEqual([`first ${LONG}`]);
    } finally { session.close(); }
  });
});

test("a short answer shows as before: the words after the label, no …", async () => {
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const session = sized(60, 12);
    try {
      const answer = session.terminal.ask(QUESTION, OPTIONS, false, undefined, "ai");
      await waitFor(() => visible(session).includes("Esc to skip"), () => visible(session));
      session.input.write("5");
      session.input.write("only the parser");
      await waitFor(() => visible(session).includes(`  ❯ 5. ${OTHER_CHOICE} — only the parser\n`), () => visible(session));
      expect(visible(session)).not.toContain("…");
      session.input.write("\r");
      expect(await answer).toEqual(["only the parser"]);
    } finally { session.close(); }
  });
});

test("a long comment on an approval shows in full as it wraps, its end on a short terminal, and all of it goes to the task", async () => {
  await withEnv({ TERM: "xterm-256color" }, async () => {
    for (const rows of [30, 12]) {
      const session = sized(60, rows);
      const sent: string[] = [];
      session.terminal.setBusySubmit(line => { sent.push(line); return true; });
      try {
        const answer = session.terminal.approve("", "Make this change?", [NO, YES_ONCE]);
        await waitFor(() => visible(session).includes("Esc to skip"), () => visible(session));
        await typeWords(session, NO, WORDS);
        const screen = visible(session);
        const shown = typedRow(screen, NO);
        if (rows === 30) expect(shown).toBe(LONG);
        else {
          expect(shown).toStartWith("…");
          expect(shown).toEndWith("step39 step40");
        }
        expect(screen).toContain("Make this change?");
        expect(screen).toContain("Esc to skip");
        session.input.write("\r");
        // Typed words are a No, with the words as direction for the task.
        expect(await answer).toBe(NO);
        expect(sent).toEqual([LONG]);
      } finally { session.close(); }
    }
  });
});

test("the terminal guide says how a long typed answer and an approval's comment show", async () => {
  const doc = (await readFile(new URL("../docs/TERMINAL_UX.md", import.meta.url), "utf8")).replace(/\s+/g, " ");
  expect(doc).toContain("the answer appears inline beside Other, in full as it wraps. When the box can't hold all of it, the part where the "
    + "cursor is shows (the end, while you type on) with `…` for the rest, and a box too small for the words after the whole label keeps only "
    + "`Other —`. Enter sends all of it");
  expect(doc).toContain("Typing words selects No with an inline comment, shown like a typed answer (in full, or the part where the cursor is); "
    + "Enter declines and sends all of those words as direction for Casper");
});
