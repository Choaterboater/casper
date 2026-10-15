import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PROMPT_GLYPH, tint } from "../src/tui/format";
import { TerminalSurface } from "../src/tui/surface";

const INSTALLED = "✔ Update installed · restart to use it";
const SHORT = "✔ restart to update";
const STATUS = "demo-project │ provider/model · high │ ctx 27%~ │ idle";

/** Render the real surface synchronously through its existing picker host, without timing terminal writes. */
async function fixture(color = false) {
  const input = new PassThrough();
  const output = { write() {}, columns: 80, rows: 24 };
  const surface = new TerminalSurface({ input, output, color, onEOF() {} }, () => {}, () => {});
  surface.start();
  surface.setStatus(STATUS, process.cwd());
  let frame!: () => string[];
  await surface.exclusiveHost()!.mount(async ({ tui }) => { frame = () => tui.render(output.columns); });
  return { surface, input, output, frame, plain: () => frame().map(line => Bun.stripANSI(line)), close() { surface.close(); input.destroy(); } };
}

test("the installed notice is one right-aligned row immediately above the idle and working prompt, never in the footer", async () => {
  const f = await fixture();
  try {
    for (const working of [false, true]) {
      f.surface.setWork(working ? { rows: ["• read · src/app.ts"], status: "Reading src/app.ts" } : undefined);
      f.surface.setUpdate(undefined);
      const footer = f.surface.footerLine(80);
      f.surface.setUpdate(INSTALLED);
      const lines = f.plain();
      const row = lines.findIndex(line => line.includes(INSTALLED));
      expect(row).toBeGreaterThanOrEqual(0);
      expect(lines.filter(line => line.includes(INSTALLED))).toHaveLength(1);
      expect(lines[row]).toBe(" ".repeat(80 - visibleWidth(INSTALLED)) + INSTALLED);
      expect(lines[row + 1]).toMatch(/^─+$/);
      if (working) expect(lines[row - 1]).toContain("Reading src/app.ts · Esc stops");
      expect(f.surface.footerLine(80)).toBe(footer);
      expect(lines.at(-1)).toBe(footer);
      f.surface.flashNote("draft kept");
      expect(f.plain().some(line => line.includes(INSTALLED))).toBe(true);
    }
  } finally { f.close(); }
});

test("the update row uses the success colour; NO_COLOR keeps exactly the same text and alignment", async () => {
  for (const color of [true, false]) {
    const f = await fixture(color);
    try {
      f.surface.setUpdate(INSTALLED);
      const row = f.frame().find(line => line.includes(INSTALLED))!;
      const padding = " ".repeat(80 - visibleWidth(INSTALLED));
      expect(row).toBe(padding + tint(INSTALLED, "success", color));
      expect(Bun.stripANSI(row)).toBe(padding + INSTALLED);
      if (!color) expect(row).not.toContain("\x1b");
    } finally { f.close(); }
  }
});

test("narrow notices shorten to the restart action, then hide instead of truncating or wrapping", async () => {
  const f = await fixture();
  try {
    f.surface.setUpdate(INSTALLED);
    for (const width of [80, visibleWidth(INSTALLED), visibleWidth(INSTALLED) - 1, visibleWidth(SHORT), visibleWidth(SHORT) - 1, 10]) {
      f.output.columns = width;
      const lines = f.plain();
      const notes = lines.filter(line => line.includes("✔"));
      if (width >= visibleWidth(INSTALLED)) expect(notes).toEqual([" ".repeat(width - visibleWidth(INSTALLED)) + INSTALLED]);
      else if (width >= visibleWidth(SHORT)) expect(notes).toEqual([" ".repeat(width - visibleWidth(SHORT)) + SHORT]);
      else expect(notes).toEqual([]);
      for (const line of f.frame()) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(lines.at(-1)).toBe(Bun.stripANSI(f.surface.footerLine(width)));
    }
    // Widening brings the full row back, without losing the stored notice.
    f.output.columns = 80;
    expect(f.plain().some(line => line.includes(INSTALLED))).toBe(true);
  } finally { f.close(); }
});

test("short screens and a multiline draft yield the update row before prompt, footer or live steps", async () => {
  const f = await fixture();
  try {
    f.surface.setBadge("ASKING OFF · /permissions ask");
    // The notice uses the last spare row, but yields as soon as only the editor and footer fit.
    f.surface.setUpdate(INSTALLED);
    for (const rows of [5, 4]) {
      f.output.rows = rows;
      const lines = f.plain();
      expect(lines.length).toBeLessThanOrEqual(rows);
      expect(lines.some(line => line.includes(INSTALLED))).toBe(rows === 5);
      expect(lines.at(-1)).toBe(Bun.stripANSI(f.surface.footerLine(80)));
    }
    f.surface.setWork({ rows: Array.from({ length: 30 }, (_, i) => `• read · src/file-${i}.ts`), status: "Reading files" });
    for (const rows of [24, 8, 6]) {
      f.output.rows = rows;
      f.surface.setUpdate(undefined);
      const without = f.plain();
      f.surface.setUpdate(INSTALLED);
      const lines = f.plain();
      expect(lines.at(-1)).toBe(Bun.stripANSI(f.surface.footerLine(80)));
      expect(lines.at(-1)).toContain("asking off");
      expect(lines.length).toBeLessThanOrEqual(rows);
      expect(lines.at(-2)).toMatch(/^─+$/);
      if (rows === 6) expect(lines).toEqual(without);
      else expect(lines.some(line => line.includes(INSTALLED))).toBe(true);
    }
    f.surface.setWork(undefined);
    f.output.rows = 7;
    f.surface.restoreDraft("first\nsecond\nthird\nfourth");
    expect(f.plain().join("\n")).not.toContain(INSTALLED);
    expect(f.plain().join("\n")).toContain(PROMPT_GLYPH);
    expect(f.plain().at(-1)).toBe(Bun.stripANSI(f.surface.footerLine(80)));
  } finally { f.close(); }
});

test("update state changes and clearing replace the row; ready or failed notes never become restart advice", async () => {
  const f = await fixture();
  try {
    f.surface.setUpdate(INSTALLED);
    for (const note of ["Update ready · casper update", "Update failed · casper update"]) {
      f.surface.setUpdate(note);
      expect(f.plain().filter(line => line.includes(note))).toHaveLength(1);
      expect(f.plain().join("\n")).not.toContain(INSTALLED);
      f.output.columns = 18;
      expect(f.plain().join("\n")).toContain(note.split(" · ")[0]!);
      expect(f.plain().join("\n")).not.toContain("restart");
      f.output.columns = 80;
    }
    f.surface.setUpdate(undefined);
    expect(f.plain().join("\n")).not.toContain("Update");
    f.surface.setUpdate(" \n\t ");
    expect(f.plain().join("\n")).not.toContain("Update");
  } finally { f.close(); }
});

test("update notices coexist with live crew rows without displacing the prompt or an approval", async () => {
  const f = await fixture();
  try {
    f.surface.updateCrew({ kind: "start", run: { id: 1, role: "builder", label: "Builder 1", goal: "Improve the selected files", startedAt: Date.now() } });
    f.surface.setUpdate(INSTALLED);
    const lines = f.plain();
    const crew = lines.findIndex(line => line.includes("Builder 1"));
    const notice = lines.findIndex(line => line.includes(INSTALLED));
    expect(crew).toBeGreaterThanOrEqual(0);
    expect(notice).toBeGreaterThan(crew);
    expect(lines[notice + 1]).toMatch(/^─+$/);
    expect(lines[notice + 2]).toContain(PROMPT_GLYPH);
    expect(lines.length).toBeLessThanOrEqual(f.output.rows);
    const answer = f.surface.approve("", "Run the selected command?", [{ label: "No" }, { label: "Yes" }]);
    const asking = f.plain().join("\n");
    expect(asking).toContain("Builder 1");
    expect(asking).toContain("Run the selected command?");
    expect(asking).not.toContain(INSTALLED);
    f.input.write("\x1b");
    expect(await answer).toBeUndefined();
    expect(f.plain().join("\n")).toContain(INSTALLED);
  } finally { f.close(); }
});

test("questions and pickers hide the row without clearing it", async () => {
  const f = await fixture();
  try {
    f.surface.setUpdate(INSTALLED);
    const answer = f.surface.approve("Run it?\n", "Make this change?", [{ label: "No" }, { label: "Yes" }]);
    expect(f.plain().join("\n")).not.toContain(INSTALLED);
    f.input.write("\x1b");
    expect(await answer).toBeUndefined();
    expect(f.plain().join("\n")).toContain(INSTALLED);
    await f.surface.exclusiveHost()!.mount(async view => {
      view.show({ render: () => ["Pick a model"], invalidate() {} });
      expect(f.plain().join("\n")).not.toContain(INSTALLED);
    });
    expect(f.plain().join("\n")).toContain(INSTALLED);
  } finally { f.close(); }
});
