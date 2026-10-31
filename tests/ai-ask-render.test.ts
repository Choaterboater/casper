import { expect, test } from "bun:test";
import { unescapeMarkdown } from "../src/tui/surface";
import { ansiCells, cellsFor } from "./support/ansi-cells";
import { withEnv } from "./support/env";
import { interactiveTerminal } from "./support/tty";

/**
 * A real session's AI question showed a literal "\`" before GET: the model escaped its Markdown inside the question.
 * The same report had option 2 drawn flush left; that did not reproduce (the shapes below keep every option indented).
 */

/** The AI's question box as the real terminal drew it: its rows at `width`, with their ANSI. */
async function drawn(question: string, options: Array<{ label: string; description?: string }>, width: number, noColor: boolean): Promise<string[]> {
  let rows: string[] = [];
  await withEnv({ TERM: "xterm-256color", NO_COLOR: noColor ? "1" : undefined }, async () => {
    const f = interactiveTerminal();
    f.screen.writer.columns = width; f.screen.writer.rows = 45;
    let answer: Promise<string[] | undefined> | undefined;
    try {
      f.terminal.start();
      answer = f.terminal.ask(question, options, false, undefined, "ai");
      await f.screen.until(text => text.includes("Enter to choose"));
      rows = (f.terminal as unknown as { surface: { tui: { render(width: number): string[] } } }).surface.tui.render(width);
      for (const row of rows.filter((row) => row.trim())) expect(f.screen.output).toContain(row);
    } finally { f.terminal.interrupt(); await answer; f.close(); }
  });
  return rows;
}

const QUESTION = "Should I check the \\`GET /api/config\\` answer before publishing ha.example.org?";
const OPTIONS = [
  { label: "Check it first", description: "one curl to the Home Assistant API, nothing changes" },
  { label: "Publish ha.example.org as a public hostname now and add the trusted\\_proxies entry to configuration.yaml after that" },
];

test("Markdown escapes come off: \\` is a backtick, \\' a quote; other backslashes stay", () => {
  expect(unescapeMarkdown("the \\`GET\\` call, I\\'ll do it, trusted\\_proxies")).toBe("the `GET` call, I'll do it, trusted_proxies");
  expect(unescapeMarkdown("C:\\Users\\me and \\n")).toBe("C:\\Users\\me and \\n");
});

test("the AI's question shows no escape backslash; its code is bold without backticks, or keeps them with NO_COLOR", async () => {
  const plain = (await drawn(QUESTION, OPTIONS, 100, true)).map((row) => Bun.stripANSI(row));
  expect(plain.join("\n")).toContain("Should I check the `GET /api/config` answer before publishing ha.example.org?");
  expect(plain.join("\n")).not.toContain("\\");
  expect(plain.join("\n")).toContain("trusted_proxies");
  const rows = await drawn(QUESTION, OPTIONS, 100, false);
  const text = rows.map((row) => Bun.stripANSI(row)).join("\n");
  expect(text).toContain("Should I check the GET /api/config answer");
  expect(cellsFor(ansiCells(rows), "GET /api/config").every((cell) => cell.bold)).toBe(true);
  expect(cellsFor(ansiCells(rows), "answer before").some((cell) => cell.bold)).toBe(false);
});

test("every option stays indented, a long one wrapped too, at any width", async () => {
  for (const width of [40, 60, 100, 140]) {
    const rows = (await drawn(QUESTION, OPTIONS, width, true)).map((row) => Bun.stripANSI(row));
    const first = rows.findIndex((row) => /\b1\. Check it first/.test(row));
    const second = rows.findIndex((row) => /\b2\. Publish/.test(row));
    expect([width, rows[first]!.indexOf("1."), rows[second]!.indexOf("2.")]).toEqual([width, rows[second]!.indexOf("2."), rows[first]!.indexOf("1.")]);
    expect([width, rows[second]!.indexOf("2.")]).toEqual([width, 2]);
    // Its wrapped rows hang under its words, not at the left edge.
    for (const row of rows.slice(second + 1).filter((row) => row.trim() && !/^\s*3\./.test(row) && !/Enter to choose|──|waiting/.test(row)).slice(0, 2)) {
      expect([width, row, row.search(/\S/)]).toEqual([width, row, 5]);
    }
  }
});
