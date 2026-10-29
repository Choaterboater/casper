import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { HelperRun } from "../src/agents/manager";
import { CREW_EXPIRE_MS, CREW_FADE_MS, CREW_STEP_CAP, CrewPanel, crewTranscriptLine } from "../src/tui/crew-panel";
import { TerminalSurface } from "../src/tui/surface";
import { InteractiveTerminal } from "../src/tui/terminal";

const run = (id: number, role: HelperRun["role"] = "builder"): HelperRun => ({ id, role, goal: "Improve the selected files", startedAt: 0,
  ...(role === "builder" ? { label: `Builder ${id}` } : {}) });

test("crew rows start, show tool activity and tokens, finish, fade, then expire", () => {
  let now = 0;
  const panel = new CrewPanel(() => now);
  const helper = run(1);
  panel.update({ kind: "start", run: helper });
  expect(panel.render(100, 8).join("\n")).toContain("Builder 1 · Starting · 0s · — tokens");
  expect(panel.render(100, 8).join("\n")).toContain("Improve the selected files");
  now = 2000;
  helper.spent = { tokens: 1500, estimatedCost: 0.02 };
  panel.update({ kind: "tool", run: helper, event: { type: "tool_start", toolName: "read", toolCallId: "read-1", input: { path: "src/a.ts" } } });
  expect(panel.render(100, 8).join("\n")).toContain("read · src/a.ts · 2s · 1.5k tokens");
  panel.update({ kind: "tool", run: helper, event: { type: "tool_end", toolName: "read", toolCallId: "read-1", isError: false } });
  expect(panel.render(100, 8).join("\n")).toContain("Thinking");
  panel.update({ kind: "end", run: helper, status: "completed" });
  expect(panel.render(100, 8)[0]).toStartWith("✓ Builder 1 · Done");
  const fresh = panel.render(100, 8, { color: true })[0];
  now += CREW_FADE_MS;
  expect(panel.render(100, 8, { color: true })[0]).not.toBe(fresh);
  now = 2000 + CREW_EXPIRE_MS;
  expect(panel.render(100, 8)).toEqual([]);
  panel.update({ kind: "usage", run: helper });
  expect(panel.size).toBe(0);
});

test("a completed reviewer row shows its result rather than only Done", () => {
  const panel = new CrewPanel(() => 0);
  const reviewer = run(1, "reviewer");
  panel.update({ kind: "start", run: reviewer });
  panel.update({ kind: "end", run: reviewer, status: "completed", response: "2 problems found → Builder 3\nFull detail" });
  expect(panel.render(120, 8)[0]).toContain("Reviewer 1 · 2 problems found → Builder 3");
  expect(panel.render(120, 8)[0]).not.toContain("Full detail");
});

test("four crew helpers plus +N more; running rows precede completions; full list pages", () => {
  const panel = new CrewPanel(() => 0);
  for (let id = 1; id <= 6; id++) panel.update({ kind: "start", run: run(id, id === 6 ? "reviewer" : "builder") });
  panel.update({ kind: "end", run: run(1), status: "cancelled" });
  const rows = panel.render(100, 10);
  expect(rows).toHaveLength(5);
  expect(rows[0]).toContain("Builder 2");
  expect(rows[4]).toContain("+2 more");
  const all = panel.render(100, 12, { details: true });
  expect(all).toHaveLength(7);
  expect(all.join("\n")).toContain("Reviewer 6");
  expect(panel.render(100, 3, { details: true, offset: 4 }).join("\n")).toContain("Builder 1");
});

test("crew rows bound narrow widths and heights and sanitize untrusted labels, goals and step targets", () => {
  const panel = new CrewPanel(() => 0);
  panel.update({ kind: "start", run: { ...run(1), label: "Builder 1\n\u001b[2J\u202e", goal: "API_KEY=hidden-value" } });
  panel.update({ kind: "start", run: run(2, "explorer") });
  panel.update({ kind: "tool", run: run(2, "explorer"), event: { type: "tool_start", toolName: "bash", toolCallId: "b", input: { command: "echo TOKEN=hidden-value\u001b[2J" } } });
  expect(panel.size).toBe(2);
  for (const width of [0, 1, 2, 5, 12, 24, 40, 80]) for (const height of [0, 1, 2, 4, 8]) {
    const rows = panel.render(width, height, { details: true });
    expect(rows.length).toBeLessThanOrEqual(height);
    for (const row of rows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      expect(row).not.toMatch(/[\n\r\u001b\u202e]/);
      expect(row).not.toContain("hidden-value");
    }
  }
});

test("approval waits freeze only that builder's work time and are shown separately", () => {
  let now = 1000;
  const panel = new CrewPanel(() => now);
  panel.update({ kind: "start", run: run(1) });
  panel.update({ kind: "start", run: run(2) });
  panel.setWaiting("Builder 1", true);
  now = 61_000;
  let rows = panel.render(120, 8);
  expect(rows[0]).toContain("waiting for you · 0s");
  expect(rows[0]).toContain("waited 1m");
  expect(rows[1]).toContain("1m");
  panel.setWaiting("Builder 1", false);
  now = 63_000;
  panel.update({ kind: "end", run: run(1), status: "completed" });
  rows = panel.render(120, 8);
  expect(rows.find(row => row.includes("Builder 1"))).toContain("Done · 2s");
});

test("plain terminal has no crew panel and its crew transcript is unchanged", () => {
  const output: string[] = [];
  const terminal = new InteractiveTerminal(new PassThrough(), { write: text => { output.push(text); } }, () => {}, () => {});
  terminal.updateCrew({ kind: "start", run: run(1) });
  terminal.setCrewWaiting("Builder 1", true);
  expect(terminal.crewRows(80, 20)).toEqual([]);
  terminal.writeCrew("Builder 1 is working in its own copy");
  expect(output).toEqual(["[crew] Builder 1 is working in its own copy\n"]);
  expect(crewTranscriptLine("Checking part 1", true)).toBeUndefined();
  expect(crewTranscriptLine("A builder's change was applied to your folder, uncommitted: src/a.ts.", true)).toStartWith("[crew]");
  terminal.close();
});

for (const why of ["patch conflicts with your folder", "its changes can't be read: permission denied", "the builder was stopped", "the builder did not finish (timed out)"]) {
  test(`rich transcript preserves actionable retained-copy outcomes: ${why}`, () => {
    const line = `Builder 2's work was not applied (${why}). It stays in its copy; /crew lists it.`;
    expect(crewTranscriptLine(line, true)).toBe(`[crew] ${line}\n`);
    expect(crewTranscriptLine(line, false)).toBe(`[crew] ${line}\n`);
  });
}

test("rich application outcomes stay sanitized and on one line without retaining crew chatter", () => {
  const line = "Builder 2's work was not applied (patch failed:\n\u001b[31mconflict\u001b[0m). It stays in its copy; /crew lists it.";
  expect(crewTranscriptLine(line, true)).toBe("[crew] Builder 2's work was not applied (patch failed: conflict). It stays in its copy; /crew lists it.\n");
  expect(crewTranscriptLine("Applied to your folder: src/a.ts", true)).toBe("[crew] Applied to your folder: src/a.ts\n");
  expect(crewTranscriptLine("A builder's change was applied to your folder, uncommitted: src/a.ts.", true))
    .toBe("[crew] A builder's change was applied to your folder, uncommitted: src/a.ts.\n");
  expect(crewTranscriptLine("Builder 2 is working in its own copy: Fix the selected files", true)).toBeUndefined();
  expect(crewTranscriptLine("Checking part 2", true)).toBeUndefined();
});

test("surface keeps Ctrl+O crew details and approval keys; Alt+O toggles raw steps throughout", async () => {
  const input = new PassThrough();
  const chunks: string[] = [];
  const surface = new TerminalSurface({ input, output: { write: text => { chunks.push(text); }, columns: 80, rows: 24 }, color: false, onEOF() {} }, () => {}, () => {});
  surface.start();
  try {
    input.write("\x0f");
    expect(surface.rawStepsShown).toBe(true);
    input.write("\x1bo"); // Alt+O also works without helpers.
    expect(surface.rawStepsShown).toBe(false);
    for (let id = 1; id <= 6; id++) surface.updateCrew({ kind: "start", run: { ...run(id), startedAt: Date.now() } });
    expect(surface.crewRows(80, 12).join("\n")).toContain("+2 more");
    expect(surface.crewRows(80, 12).join("\n")).toContain("Alt+O raw steps");
    input.write("\x1bo"); // Raw toggle does not open details.
    expect(surface.rawStepsShown).toBe(true);
    expect(surface.crewRows(80, 12).join("\n")).toContain("+2 more");
    input.write("\x0f");
    expect(surface.crewRows(80, 12).join("\n")).toContain("Builder 6");
    expect(surface.rawStepsShown).toBe(true);
    input.write("\x1bo"); // Nor does it close details.
    expect(surface.rawStepsShown).toBe(false);
    expect(surface.crewRows(80, 12).join("\n")).toContain("Builder 6");
    const answer = surface.approve("", "Builder 1 wants to run: example", [{ label: "No" }, { label: "Yes" }]);
    // Details never steals the approval's key or turns Enter into consent.
    input.write("\x0f");
    input.write("\x1b");
    expect(await answer).toBeUndefined();
    expect(surface.rawStepsShown).toBe(false);
    input.write("\x0f"); // Close the details view, restoring the compact panel.
    expect(surface.crewRows(80, 12).join("\n")).toContain("+2 more");
    for (let id = 1; id <= 6; id++) surface.updateCrew({ kind: "end", run: run(id), status: "completed" });
    input.write("\x1bo"); // The raw toggle stays accessible during completion retention too.
    expect(surface.rawStepsShown).toBe(true);
    expect(surface.crewRows(80, 12).join("\n")).toContain("+2 more");
    input.write("\x0f");
    expect(surface.crewRows(80, 12).join("\n")).toContain("Builder 6 · Done");
    expect(surface.rawStepsShown).toBe(true);
    input.write("\x1bo");
    expect(surface.rawStepsShown).toBe(false);
    expect(surface.crewRows(80, 12).join("\n")).toContain("Builder 6 · Done");
    await new Promise(resolve => setTimeout(resolve, 160));
    expect(chunks.join("")).toContain("Builder");
  } finally { surface.close(); }
});

test("explorers get rows too, and each row names what its helper is working on", () => {
  const panel = new CrewPanel(() => 0);
  const explorer = run(3, "explorer");
  panel.update({ kind: "start", run: explorer });
  panel.update({ kind: "tool", run: explorer, event: { type: "tool_start", toolName: "grep", toolCallId: "g", input: { pattern: "stale", path: "/work/cad" } } }, "/work");
  expect(panel.render(120, 8)[0]).toContain("Explorer 1 · grep · stale · cad ·");
  panel.update({ kind: "tool", run: explorer, event: { type: "tool_end", toolName: "grep", toolCallId: "g", isError: false } }, "/work");
  panel.update({ kind: "tool", run: explorer, event: { type: "tool_start", toolName: "read", toolCallId: "r", input: { path: "/work/cad/otto.js" } } }, "/work");
  expect(panel.render(120, 8)[0]).toContain("Explorer 1 · read · cad/otto.js ·");
  panel.update({ kind: "end", run: explorer, status: "completed" });
  expect(panel.render(120, 8)[0]).toStartWith("✓ Explorer 1 · Done");
});

test("crew details list each helper's recent steps under its row, newest last, and scroll by line", () => {
  const panel = new CrewPanel(() => 0);
  const builder = run(1);
  const reviewer = run(2, "reviewer");
  panel.update({ kind: "start", run: builder });
  panel.update({ kind: "start", run: reviewer });
  for (let index = 1; index <= 8; index++) {
    panel.update({ kind: "tool", run: builder, event: { type: "tool_start", toolName: "read", toolCallId: `r${index}`, input: { path: `/work/f${index}.ts` } } }, "/work");
    panel.update({ kind: "tool", run: builder, event: { type: "tool_end", toolName: "read", toolCallId: `r${index}`, isError: index === 8 } }, "/work");
  }
  panel.update({ kind: "tool", run: reviewer, event: { type: "tool_start", toolName: "bash", toolCallId: "t", input: { command: "bun test" } } }, "/work");
  // The compact panel stays one row a helper.
  expect(panel.render(120, 8)).toHaveLength(3);
  const all = panel.render(120, 30, { details: true });
  expect(CREW_STEP_CAP).toBe(5);
  expect(all[0]).toContain("Builder 1 · Thinking");
  expect(all.slice(1, 6)).toEqual(["    ✓ read · f4.ts", "    ✓ read · f5.ts", "    ✓ read · f6.ts", "    ✓ read · f7.ts", "    ✗ read · f8.ts"]);
  expect(all[6]).toContain("Reviewer 2 · bash · bun test");
  expect(all[7]).toBe("    • bash · bun test");
  expect(all[8]).toContain("Crew details · 2 helpers · ↑↓ scroll · Ctrl+O closes");
  expect(panel.detailSize).toBe(8);
  const scrolled = panel.render(120, 4, { details: true, offset: panel.detailSize - 3 });
  expect(scrolled.slice(0, 3).join("\n")).toContain("bash · bun test");
});
