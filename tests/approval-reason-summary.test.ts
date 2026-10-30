import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { visibleWidth } from "@earendil-works/pi-tui";
import { shellQuestion } from "../src/app/sandbox";
import { tint } from "../src/tui/format";
import { modelReasonLine } from "../src/tui/model-reason";
import { renderPanel } from "../src/tui/presentation";
import { TerminalSurface } from "../src/tui/surface";
import { InteractiveTerminal } from "../src/tui/terminal";

const paragraph = "Earlier context is not the reason. Another sentence explains the setup.\n\nCheck the generated\noutput before continuing.";
const finalSentence = "Check the generated output before continuing.";
const longFinal = "Validate " + "the generated output carefully ".repeat(10) + "before continuing.";

test("command reasons use only the last sentence of a paragraph, including a sentence split across lines", () => {
  expect(shellQuestion("custom-tool --check", paragraph)).toBe(`Run this command?\nThe model says: ${finalSentence}\ncustom-tool --check`);
});

test("a long final sentence is capped at 100 characters then an ellipsis", () => {
  const reason = shellQuestion("custom-tool --check", `Discard this earlier sentence. ${longFinal}`).split("\n")[1]!;
  expect(reason).toBe(`The model says: ${longFinal.slice(0, 100)}…`);
  expect(reason).not.toContain("Discard");
});

test.each([24, 40, 80, 160])("the rich approval keeps the last sentence dim and on one row at %i columns", async width => {
  const input = new PassThrough();
  const surface = new TerminalSurface({ input, output: { columns: width, rows: 30, write() {} }, color: true, onEOF() {} }, () => {}, () => {});
  surface.start();
  try {
    // Also exercise raw attributed reasons, not just already summarized shellQuestion output.
    const question = `Run this command?\nThe model says: Earlier context. ${longFinal}\ncustom-tool --check`;
    const answer = surface.approve("", question, [{ label: "No" }, { label: "Yes, this once" }]);
    const rows = (surface as unknown as { renderAsk(w: number, h: number): string[] }).renderAsk(width, 27);
    const summary = modelReasonLine(`Earlier context. ${longFinal}`, width);
    const reasonRows = rows.filter(row => Bun.stripANSI(row).startsWith("The model says:"));
    expect(reasonRows).toHaveLength(1);
    expect(reasonRows[0]).toBe(tint(summary, "muted", true));
    expect(reasonRows[0]).not.toBe(tint(summary, "accent", true));
    expect(visibleWidth(reasonRows[0]!)).toBeLessThanOrEqual(width);
    expect(rows[0]).toBe(tint("Run this command?", "accent", true));
    expect(rows.join("\n")).not.toContain("Earlier context");
    const commandRows = renderPanel("Command", ["custom-tool --check"], width, false, "muted");
    expect(rows.slice(2, 2 + commandRows.length)).toEqual(commandRows.map(row => tint(row, "muted", true)));
    // Enter on No opens its note line; an empty Enter there is a plain No.
    input.write("\r"); input.write("\r"); expect(await answer).toBe("No");
  } finally { surface.close(); input.destroy(); }
});

test("the plain terminal's summarized reason stays dim when colour is enabled", async () => {
  const term = process.env.TERM, noColor = process.env.NO_COLOR;
  process.env.TERM = "xterm-256color";
  delete process.env.NO_COLOR;
  const input = new PassThrough();
  let output = "";
  const terminal = new InteractiveTerminal(input, { columns: 40, isTTY: true, write(text: string) { output += text; } } as never, () => {}, () => {});
  try {
    terminal.start();
    const answer = terminal.pick(`Run this command?\nThe model says: Earlier context. ${longFinal}\ncustom-tool --check`, [{ label: "No" }, { label: "Yes" }]);
    const summary = modelReasonLine(longFinal, 40);
    expect(output).toContain(tint(summary, "muted", true));
    expect(output).not.toContain(tint(summary, "accent", true));
    input.write("\n"); expect(await answer).toBe("No");
  } finally {
    terminal.close(); input.destroy();
    if (term === undefined) delete process.env.TERM; else process.env.TERM = term;
    if (noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = noColor;
  }
});

test.each([24, 80, 160])("the plain terminal summarizes paragraph and long reasons without wrapping at %i columns", async width => {
  const input = new PassThrough();
  let output = "";
  const terminal = new InteractiveTerminal(input, { columns: width, isTTY: false, write(text: string) { output += text; } } as never, () => {}, () => {});
  terminal.start();
  try {
    for (const reason of ["Earlier context. " + finalSentence, "Earlier context. " + longFinal]) {
      output = "";
      const answer = terminal.pick(`Run this command?\nThe model says: ${reason}\ncustom-tool --check`, [{ label: "No" }, { label: "Yes, this once" }]);
      const lines = output.split("\n");
      const summary = modelReasonLine(reason, width);
      expect(lines.slice(0, 3)).toEqual(["Run this command?", summary, "custom-tool --check"]);
      expect(visibleWidth(summary)).toBeLessThanOrEqual(width);
      expect(output).not.toContain("Earlier context");
      expect(output).not.toContain("\x1b");
      input.write("\n"); expect(await answer).toBe("No");
    }
  } finally { terminal.close(); input.destroy(); }
});
