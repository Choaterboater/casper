import { expect, test } from "bun:test";
import { planScreenRows } from "../src/flows/plan";
import { renderPanel } from "../src/tui/presentation";
import { renderChangeBox, renderEditBox, renderFailureBox } from "../src/tui/step-view";
import { renderFold } from "../src/tui/terminal";

/** What a mouse drag over a box's body puts on the clipboard: its rows between the title rule and the closing rule. */
const copied = (rows: string[]) => rows.slice(1, -1).map(row => Bun.stripANSI(row).trimEnd());
const BORDER = /[│┃║╭╮╰╯┌┐└┘]/;

test("a mouse copy of a box's body takes no border characters and no indent", () => {
  const boxes = {
    panel: renderPanel("Command", ["ssh admin@192.0.2.10 'show configuration | display set'"], 80, true, "muted"),
    edit: renderEditBox([{ path: "src/app.ts", added: 1, removed: 1, diff: "@@ -1 +1 @@\n-const port = 3000;\n+const port = 8080;\n" }], 80, { color: true }),
    failure: renderFailureBox({ title: "✗ bash · npm test — failed", output: "Error: expected 2, got 3\n1 failed" }, 80, true),
    change: renderChangeBox({ row: "Changed on sw1: sent 2 config lines", sent: ["set system host-name lab1", "commit"] }, 80, true),
  };
  for (const [name, rows] of Object.entries(boxes)) {
    expect(Bun.stripANSI(rows[0]!), name).toStartWith("── ");
    expect(Bun.stripANSI(rows.at(-1)!), name).toMatch(/^─+$/);
    for (const row of copied(rows)) expect(row, name).not.toMatch(BORDER);
  }
  expect(copied(boxes.panel)).toEqual(["ssh admin@192.0.2.10 'show configuration | display set'"]);
  expect(copied(boxes.change)).toEqual(["set system host-name lab1", "commit"]);
  expect(copied(boxes.failure)).toEqual(["Error: expected 2, got 3", "1 failed"]);
});

test("a folded group's boxes sit at the left edge, under step rows that keep their indent", () => {
  const rows = renderFold({ parts: [{ verb: "read", names: ["a.ts"], noun: ["file", "files"], paths: true }], lines: [], editLines: 12,
    edits: [{ path: "a.ts", added: 1, removed: 0, diff: "@@ -0,0 +1 @@\n+export const a = 1;\n" }], failures: [] }, 100, true, false);
  expect(rows[0]).toStartWith("  └");
  const box = rows.slice(rows.findIndex(row => row.startsWith("── Edited 1 file")));
  expect(box[0]).toStartWith("── Edited 1 file");
  for (const row of box) expect(row).not.toMatch(BORDER);
});

test("the plan's open box puts nothing beside the plan", () => {
  const rows = planScreenRows({ title: "Fix the port", steps: ["Read PORT — src/app.ts"], tests: ["bun test tests/port.test.ts"] }, 80, { framed: true });
  for (const row of copied(rows)) expect(row).not.toMatch(BORDER);
  expect(copied(rows)).toContain("  1. bun test tests/port.test.ts");
});
