import { expect, test, vi } from "bun:test";
import { PassThrough } from "node:stream";
import { TerminalSurface } from "../src/tui/surface";

/** The footer spinner is the visible-motion contract: while a prompt runs or tool activity is
 * on screen the state glyph cycles through braille frames, and it returns to the static ○ when
 * idle. Rendered output is the observable surface; private timer fields are not asserted. */

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function makeSurface() {
  const chunks: string[] = [];
  const surface = new TerminalSurface({
    input: new PassThrough(),
    output: { write: (text: string) => { chunks.push(text); }, columns: 80, rows: 24 },
    color: false,
    onEOF: () => {},
  }, () => {}, () => {});
  return { surface, chunks };
}

test("the footer spinner animates while activity is present and rests when idle", async () => {
  vi.useFakeTimers();
  try {
    const { surface, chunks } = makeSurface();
    surface.start();
    chunks.length = 0;
    surface.setActivity("• bash · find — running");
    vi.advanceTimersByTime(SPINNER.length * 120 + 120);
    await Promise.resolve(); // requestRender schedules on process.nextTick; drain it.
    await Promise.resolve();
    const moving = SPINNER.filter(frame => chunks.some(text => text.includes(` ${frame} `)));
    expect(moving.length).toBeGreaterThan(1);
    const panelFrames = chunks
      .filter(text => text.includes("Working"))
      .map(text => SPINNER.find(frame => text.includes(`${frame} Working`)))
      .filter(frame => frame !== undefined);
    expect(new Set(panelFrames).size).toBeGreaterThan(1);
    surface.setActivity(undefined);
    vi.advanceTimersByTime(600);
    await Promise.resolve();
    await Promise.resolve();
    const idle = chunks.filter(text => text.includes("○"));
    expect(idle.length).toBeGreaterThan(0);
    expect(SPINNER.some(frame => idle.at(-1)!.includes(frame))).toBe(false);
    surface.close();
  } finally { vi.useRealTimers(); }
});