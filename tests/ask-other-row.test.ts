import { afterAll, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { NO, YES_ONCE } from "../src/app/safe-choices";
import { OTHER_CHOICE } from "../src/tui/choices";
import { InteractiveTerminal } from "../src/tui/terminal";
import { Screen } from "./support/conpty";
import { interactiveTerminal } from "./support/tty";

/**
 * A box that takes a typed answer (the AI's questions, Casper's typed pickers) ends with one more numbered row,
 * "Other — type your own answer". Picking it opens the answer line; Enter sends, Esc goes back to the list.
 * Approvals and key-only pickers never have it.
 */

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const QUESTION = "How far should I take this now?";
const OPTIONS = [
  { label: "Just the fix", description: "the smallest change that works" },
  { label: "Fix and tests" },
  { label: "Fix, tests and docs" },
  { label: "Stop here" },
];

/** The screen as a terminal shows it now, not the raw stream of redraws. */
function screenText(raw: string, cols = 100, rows = 30): string {
  const screen = new Screen(cols, rows);
  screen.feed(raw);
  return screen.text();
}

/** The open box: from "The AI asks:" (or the question) to the hint under the rows. */
function box(raw: string, first = "The AI asks:"): string {
  const lines = screenText(raw).split("\n").map((line) => line.trimEnd());
  const start = lines.lastIndexOf(`  ${first}`);
  const end = lines.findIndex((line, index) => index > start && /Esc /.test(line));
  return lines.slice(start, end + 1).join("\n");
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

test("the AI's question ends with an Other row; its number opens the answer line and Enter sends it", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask(QUESTION, OPTIONS, false, undefined, "ai");
    await session.screen.until((output) => output.includes(OTHER_CHOICE));
    expect(box(session.screen.output)).toBe([
      "The AI asks:",
      QUESTION,
      "❯ 1. Just the fix".padEnd(35) + "the smallest change that works",
      "  2. Fix and tests",
      "  3. Fix, tests and docs",
      "  4. Stop here",
      "  5. Other — type your own answer",
      "Enter to choose · Esc to skip",
    ].map(line => `  ${line}`).join("\n"));
    session.input.write("5");
    await waitFor(() => box(session.screen.output).includes("❯ 5. Other — type your own answer —"));
    expect(box(session.screen.output)).toBe([
      "The AI asks:",
      QUESTION,
      "  1. Just the fix".padEnd(35) + "the smallest change that works",
      "  2. Fix and tests",
      "  3. Fix, tests and docs",
      "  4. Stop here",
      "❯ 5. Other — type your own answer —",
      "Enter to send · Esc to go back",
    ].map(line => `  ${line}`).join("\n"));
    // Numbers on the answer line are the answer, not rows.
    session.input.write("2 files, then stop");
    await waitFor(() => screenText(session.screen.output).includes("Other — type your own answer — 2 files, then stop"));
    session.input.write("\r");
    expect(await answer).toEqual(["2 files, then stop"]);
    await waitFor(() => screenText(session.screen.output).includes(`The AI asks: ${QUESTION} → 2 files, then stop`));
    expect(screenText(session.screen.output)).not.toContain(OTHER_CHOICE);
  } finally { session.close(); }
});

test("Up/Down and Enter reach the Other row; Esc goes back to the list, and Esc there skips", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask(QUESTION, OPTIONS, false, undefined, "ai");
    await session.screen.until((output) => output.includes(OTHER_CHOICE));
    session.input.write("\x1b[A");
    await waitFor(() => box(session.screen.output).includes("❯ 5. Other"));
    session.input.write("\r");
    await waitFor(() => box(session.screen.output).includes("❯ 5. Other — type your own answer —"));
    session.input.write("half");
    await waitFor(() => screenText(session.screen.output).includes("Other — type your own answer — half"));
    session.input.write("\x1b");
    await waitFor(() => !screenText(session.screen.output).includes("— half") && box(session.screen.output).endsWith("Enter to choose · Esc to skip"));
    expect(screenText(session.screen.output)).not.toContain("— half");
    // Back at the list, keys pick again.
    session.input.write("2");
    expect(await answer).toEqual(["Fix and tests"]);
    const skipped = session.terminal.ask(QUESTION, OPTIONS, false, undefined, "ai");
    await waitFor(() => box(session.screen.output).endsWith("Esc to skip"));
    session.input.write("5");
    await waitFor(() => box(session.screen.output).includes("❯ 5. Other — type your own answer —"));
    session.input.write("\x1b");
    await waitFor(() => !box(session.screen.output).includes("Other — type your own answer —"));
    session.input.write("\x1b");
    expect(await skipped).toBeUndefined();
    await waitFor(() => screenText(session.screen.output).includes(`The AI asks: ${QUESTION} — skipped`));
  } finally { session.close(); }
});

test("letters typed on the list go nowhere and name the keys; the answer is typed after picking Other", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask(QUESTION, OPTIONS, false, undefined, "ai");
    await session.screen.until((output) => output.includes(OTHER_CHOICE));
    session.input.write("only the parser");
    await waitFor(() => screenText(session.screen.output).includes("Pick with 1-5 or ↑↓ Enter · 5 to type your own answer"));
    // Nothing was typed into the box, and the highlight stayed on the first choice.
    expect(box(session.screen.output)).toContain("❯ 1. Just the fix");
    expect(box(session.screen.output)).not.toContain("only the parser");
    session.input.write("5");
    await waitFor(() => box(session.screen.output).includes("❯ 5. Other — type your own answer —"));
    session.input.write("only the parser\r");
    expect(await answer).toEqual(["only the parser"]);
  } finally { session.close(); }
});

test("a typed Casper picker has the row; approvals and key-only pickers never do", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const typed = session.terminal.pick("Name the project?", [{ label: "mist-aps" }, { label: "Use this folder" }], undefined, { typed: true });
    await waitFor(() => box(session.screen.output, "Name the project?").includes("  3. Other — type your own answer"));
    expect(box(session.screen.output, "Name the project?")).toContain("Enter to choose · Esc to skip");
    session.input.write("3");
    await waitFor(() => box(session.screen.output, "Name the project?").includes("❯ 3. Other"));
    session.input.write("lab-tools\r");
    expect(await typed).toBe("lab-tools");

    const picker = session.terminal.pick("Pick a server", [{ label: "lab" }, { label: "Done" }]);
    await waitFor(() => box(session.screen.output, "Pick a server").endsWith("Enter to choose · Esc to skip"));
    expect(box(session.screen.output, "Pick a server")).not.toContain("Other");
    session.input.write("3");
    session.input.write("1");
    expect(await picker).toBe("lab");

    const approval = session.terminal.approve("", "Make this change?", [NO, YES_ONCE]);
    // An approval has no hint under its rows and no extra row: 1 (No) opens its note line, and an empty Enter is a plain No.
    const shown = () => { const text = screenText(session.screen.output); return text.slice(text.lastIndexOf("Make this change?")); };
    await waitFor(() => shown().includes("2. Yes, this once"));
    expect(shown()).not.toContain("Other");
    expect(shown()).not.toContain("3.");
    expect(shown()).not.toContain("Esc to skip");
    session.input.write("1"); session.input.write("\r");
    expect(await approval).toBe(NO);
  } finally { session.close(); }
});

test("the plain terminal shows Other as the last number and asks \"Your answer: \"", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: false });
  let output = "";
  const writer = { isTTY: false, write: (text: string) => { output += text; } };
  const terminal = new InteractiveTerminal(input, writer as never, () => {}, () => {});
  terminal.start();
  try {
    const typed = terminal.pick(QUESTION, OPTIONS, undefined, { typed: true });
    expect(output).toContain(`${QUESTION}\n  1 Just the fix · the smallest change that works\n  2 Fix and tests\n  3 Fix, tests and docs\n  4 Stop here\n  5 Other — type your own answer\nType 1, 2, 3, 4 or 5: `);
    input.write("5\n");
    await waitFor(() => output.endsWith("Your answer: "));
    // An empty answer asks again; a number here is the answer.
    input.write("\n");
    await waitFor(() => output.endsWith("Your answer: Your answer: "));
    input.write("3 steps only\n");
    expect(await typed).toBe("3 steps only");
    expect(output).toContain(`${QUESTION} → 3 steps only\n`);

    const picker = terminal.pick("Pick a server", [{ label: "lab" }, { label: "Done" }]);
    expect(output).toContain("Pick a server\n  1 lab\n  2 Done\nType 1 or 2: ");
    input.write("2\n");
    expect(await picker).toBe("Done");
    expect(output.split("Pick a server")[1]).not.toContain("Other");
  } finally { terminal.close(); input.destroy(); }
});

// A kitty-protocol terminal (Ghostty, kitty, WezTerm) also sends each key's release: Down once moved two rows, so the
// second choice became the Other row and the answer had to be typed.
test("a key's release does not move or choose again: Down once and Enter pick the second choice", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask(QUESTION, OPTIONS, false, undefined, "ai");
    await session.screen.until((output) => output.includes(OTHER_CHOICE));
    session.input.write("\x1b[B\x1b[1;1:3B");
    await waitFor(() => box(session.screen.output).includes("❯ 2. Fix and tests"));
    session.input.write("\r\x1b[13;1:3u");
    expect(await answer).toEqual(["Fix and tests"]);
  } finally { session.close(); }
});

test("a paste on the list starts no answer and waits as the draft; after picking Other it goes on the answer line", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const first = session.terminal.ask(QUESTION, OPTIONS, false, undefined, "ai");
    await session.screen.until((output) => output.includes(OTHER_CHOICE));
    session.input.write("\x1b[200~pasted on the list\x1b[201~");
    // Had the paste opened an answer, 1 would be typed after it; it picks the first choice instead.
    session.input.write("1");
    expect(await first).toEqual(["Just the fix"]);
    // The paste is back in the prompt once the box closes.
    void session.terminal.readCommand();
    await waitFor(() => screenText(session.screen.output).includes("pasted on the list"));

    const second = session.terminal.ask(QUESTION, OPTIONS, false, undefined, "ai");
    await waitFor(() => box(session.screen.output).includes("❯ 1. Just the fix"));
    session.input.write("5");
    await waitFor(() => box(session.screen.output).includes("❯ 5. Other — type your own answer —"));
    session.input.write("\x1b[200~only the parser\x1b[201~");
    await waitFor(() => box(session.screen.output).includes("Other — type your own answer — only the parser"));
    session.input.write("\r");
    expect(await second).toEqual(["only the parser"]);
  } finally { session.close(); }
});
