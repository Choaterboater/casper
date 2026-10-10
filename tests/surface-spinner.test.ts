import { expect, test, vi } from "bun:test";
import { PassThrough } from "node:stream";
import { GLYPHS } from "../src/tui/glyphs";
import { TerminalSurface } from "../src/tui/surface";

/** The footer spinner is the visible-motion contract: while a prompt runs or tool activity is
 * on screen the state glyph cycles through braille frames (ASCII ones in the old Windows console), and it
 * leaves the footer when idle (no state mark then). Rendered output is the observable surface; private timer fields are not asserted. */

const SPINNER = GLYPHS.spinner;
/** A footer line that starts with a frame. The ASCII frames (| / - \) also turn up inside other text, such as "/ for commands". */
const spinning = (text: string) => Bun.stripANSI(text).split(/\r?\n|\r/).some(line => SPINNER.some(frame => line.startsWith(`${frame} `)));

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

test("the footer spinner and the status row's spinner animate while work is present", async () => {
  vi.useFakeTimers();
  try {
    const { surface, chunks } = makeSurface();
    surface.start();
    chunks.length = 0;
    surface.setWork({ rows: [], status: "Running find" });
    vi.advanceTimersByTime(SPINNER.length * 120 + 120);
    await Promise.resolve(); // requestRender schedules on process.nextTick; drain it.
    await Promise.resolve();
    const moving = SPINNER.filter(frame => chunks.some(text => Bun.stripANSI(text).split(/\r?\n|\r/).some(line => line.startsWith(`${frame} `))));
    expect(moving.length).toBeGreaterThan(1);
    // Elapsed time rides the same footer, right after the spinner. Bun's fake timers freeze Date, so it renders
    // as "0s" here; the assertion proves the wiring, not clock arithmetic.
    expect(chunks.some(text => SPINNER.some(frame => text.includes(`${frame} 0s │ `)))).toBe(true);
    // The status row above the prompt spins too, and says Esc stops the work.
    const rowFrames = chunks
      .filter(text => text.includes("Running find · Esc stops"))
      .map(text => SPINNER.find(frame => text.includes(`${frame} Running find`)))
      .filter(frame => frame !== undefined);
    expect(new Set(rowFrames).size).toBeGreaterThan(1);
    surface.close();
  } finally { vi.useRealTimers(); }
});

test("the footer drops the spinner and the time after the work clears", async () => {
  // Bun's fake timers do not flush the renderer's nextTick/setTimeout chain reliably, so the
  // idle transition is exercised against the platform clock; 300ms is bounded and rare.
  const { surface, chunks } = makeSurface();
  try {
    surface.start();
    surface.setWork({ rows: [], status: "Running find" });
    await new Promise(resolve => setTimeout(resolve, 200));
    chunks.length = 0;
    surface.setWork(undefined);
    await new Promise(resolve => setTimeout(resolve, 300));
    const idle = chunks.filter(text => text.includes("Casper · / for commands"));
    expect(idle.length).toBeGreaterThan(0);
    expect(spinning(idle.at(-1)!)).toBe(false);
    expect(Bun.stripANSI(surface.footerLine(80))).toStartWith("Casper · / for commands");
  } finally { surface.close(); }
});
test("a picker open during work (the model picker, sign-in) shows waiting for you, not a spinner", async () => {
  const { surface } = makeSurface();
  try {
    surface.start();
    surface.setStatus("project/main │ model │ idle", process.cwd());
    surface.setWork({ rows: [], status: "Starting the model" });
    expect(surface.footerLine(80)).not.toContain("waiting for you");
    const host = surface.exclusiveHost()!;
    let seen = "";
    await host.mount(async (view) => {
      view.show({ render: () => ["Pick a model"], invalidate() {} });
      seen = surface.footerLine(80) ?? "";
    });
    expect(seen).toContain("? waiting for you");
    expect(spinning(seen)).toBe(false);
    expect(surface.footerLine(80)).not.toContain("waiting for you");
  } finally { surface.close(); }
});
