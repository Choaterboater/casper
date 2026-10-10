import { expect, test } from "bun:test";
import type { Component } from "@earendil-works/pi-tui";
import { PassThrough } from "node:stream";
import { promptEcho, TerminalSurface } from "../src/tui/surface";
import { useTheme } from "../src/tui/theme";
import { gapBefore, Transcript } from "../src/tui/transcript";

const block = (...rows: string[]): Component => ({ render: () => rows, invalidate() {} });

test("one blank row between blocks, never two; plain lines pack together", () => {
  expect(gapBefore(undefined, "group")).toBe(false);
  expect(gapBefore("line", "line")).toBe(false);
  expect(gapBefore("line", "group")).toBe(true);
  expect(gapBefore("group", "line")).toBe(true);
  expect(gapBefore("narration", "attached")).toBe(false);
  const transcript = new Transcript();
  transcript.append("[model] fixture/demo\n");
  transcript.append("[config] a note\n");
  transcript.commit(block("❯ fix it"), "group");
  // A block's own blank edges are trimmed: the transcript sets the gap.
  transcript.commit(block("", "● I'll look.", ""), "narration");
  transcript.commitAttachable(attached => block(attached ? "  └ read a.ts" : "● read a.ts"));
  // A blank row written by hand after a gap is not a second one.
  transcript.append("\n");
  transcript.append("[context] compacted\n");
  expect(transcript.render(40)).toEqual([
    "[model] fixture/demo", "[config] a note", "", "❯ fix it", "", "● I'll look.", "  └ read a.ts", "", "[context] compacted",
  ]);
});

test("the lines of one write are one block: a receipt's lines stay together after one gap", () => {
  const transcript = new Transcript();
  transcript.commit(block("● Done."), "narration");
  transcript.append("▌ ✓ Verified · test passed\n▌ – Same as before: not sandboxed (/receipt)\n", "group");
  transcript.append("Next: 1 Show diff · 2 Undo\n", "attached");
  transcript.append("[model] next\n");
  expect(transcript.render(60)).toEqual(["● Done.", "", "▌ ✓ Verified · test passed", "▌ – Same as before: not sandboxed (/receipt)",
    "Next: 1 Show diff · 2 Undo", "", "[model] next"]);
});

test("steps with no words above them stand on their own, after a gap; what follows hangs under them", () => {
  const transcript = new Transcript();
  transcript.commit(block("❯ go"), "group");
  transcript.commitAttachable(attached => block(attached ? "  └ ran ls" : "● ran ls"));
  transcript.commitAttachable(attached => block(attached ? "  ╭─ box" : "╭─ box"));
  expect(transcript.render(40)).toEqual(["❯ go", "", "● ran ls", "  ╭─ box"]);
});

test("the streaming words and the live rows sit where they will commit, so no row above them moves", () => {
  const transcript = new Transcript();
  transcript.commit(block("❯ go"), "group");
  const words = block("● Looking at it.");
  transcript.preview = words;
  const live = block("  • read · a.ts");
  transcript.live = live;
  const streaming = transcript.render(40);
  expect(streaming).toEqual(["❯ go", "", "● Looking at it.", "  • read · a.ts"]);
  transcript.preview = undefined;
  transcript.commit(words, "narration");
  // The words commit with the same gap; the live rows stay under them.
  expect(transcript.render(40)).toEqual(streaming);
  transcript.live = undefined;
  transcript.commitAttachable(attached => block(attached ? "  └ read a.ts" : "● read a.ts"));
  const folded = transcript.render(40);
  expect(folded.slice(0, 3)).toEqual(streaming.slice(0, 3));
  expect(folded[3]).toBe("  └ read a.ts");
  // Live rows past the cap show the newest only.
  transcript.live = block("  ✓ one", "  ✓ two", "  • three");
  transcript.liveCap = 2;
  expect(transcript.render(40).slice(-2)).toEqual(["  ✓ two", "  • three"]);
});

test("your request shows bold on the theme's bar across the row; without colour or a bar it is plain", () => {
  useTheme("default");
  const [row] = promptEcho("fix the bug", true).render(20);
  expect(row).toStartWith("\x1b[100m");
  expect(Bun.stripANSI(row!)).toBe("❯ fix the bug       ");
  // Every reset inside the row starts the bar again, out to the edge.
  expect(row!.split("\x1b[0m").slice(0, -1).every((part, index) => index === 0 || part.startsWith("\x1b[100m"))).toBe(true);
  expect(promptEcho("first\nsecond line", false).render(20)).toEqual(["❯ first", "  second line"]);
  useTheme("high-contrast");
  expect(Bun.stripANSI(promptEcho("fix", true).render(20)[0]!)).toBe("❯ fix");
  expect(promptEcho("fix", true).render(20)[0]).not.toContain("\x1b[100m");
  useTheme("default");
});

test("while work runs one status row above the prompt says what happens and that Esc stops it; a question hides it", async () => {
  const chunks: string[] = [];
  const surface = new TerminalSurface({ input: new PassThrough(), output: { write: (text: string) => { chunks.push(text); }, columns: 60, rows: 20 },
    color: false, onEOF: () => {} }, () => {}, () => {});
  try {
    surface.start();
    surface.setWork({ rows: ["✓ read · a.ts", "• bash · bun test", "↳ 12 pass"], status: "Running bun test · 4s" });
    await Bun.sleep(30);
    const screen = Bun.stripANSI(chunks.join(""));
    expect(screen).toMatch(/ {2}✓ read · a\.ts/);
    expect(screen).toMatch(/ {2}\S bash · bun test/);
    expect(screen).toContain("    ↳ 12 pass");
    expect(screen).toMatch(/\S Running bun test · 4s · Esc stops/);
    expect(surface.workView).toEqual({ rows: ["✓ read · a.ts", "• bash · bun test", "↳ 12 pass"], status: "Running bun test · 4s" });
    // A narrow window cuts the words, never the key.
    const before = chunks.length;
    surface.setWork({ rows: [], status: `Running ${"x".repeat(80)}` });
    await Bun.sleep(30);
    expect(Bun.stripANSI(chunks.slice(before).join(""))).toContain("… · Esc stops");
    chunks.length = 0;
    const answered = surface.ask("Which one?", [{ label: "A" }, { label: "B" }], false);
    await Bun.sleep(30);
    expect(Bun.stripANSI(chunks.join(""))).not.toContain("Esc stops");
    surface.interrupt();
    await answered;
  } finally { surface.close(); }
});
