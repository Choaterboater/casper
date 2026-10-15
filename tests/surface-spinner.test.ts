import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { GLYPHS } from "../src/tui/glyphs";
import { TerminalSurface } from "../src/tui/surface";
import { withEnv } from "./support/env";
import { waitUntil } from "./support/wait";

const SPINNER = GLYPHS.spinner;
const spinning = (text: string) => Bun.stripANSI(text).split(/\r?\n|\r/).some(line => SPINNER.some(frame => line.startsWith(`${frame} `)));
const rich = (body: () => Promise<void>) => withEnv({ TERM: "xterm-256color", NO_COLOR: undefined }, body);

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

test("the footer spinner and the status row's spinner animate while work is present", () => rich(async () => {
  const { surface, chunks } = makeSurface();
  const footerFrames = () => SPINNER.filter(frame => chunks.some(text => Bun.stripANSI(text).split(/\r?\n|\r/).some(line => line.startsWith(`${frame} `))));
  const rowFrames = () => new Set(chunks.filter(text => text.includes("Running find · Esc stops"))
    .map(text => SPINNER.find(frame => text.includes(`${frame} Running find`))).filter(frame => frame !== undefined));
  try {
    surface.start();
    chunks.length = 0;
    surface.setWork({ rows: [], status: "Running find" });
    // Fake timers do not flush Pi's nextTick/render chain. Poll actual written frames on the platform clock.
    expect(await waitUntil(() => footerFrames().length > 1 && rowFrames().size > 1)).toBe(true);
    expect(footerFrames().length).toBeGreaterThan(1);
    expect(rowFrames().size).toBeGreaterThan(1);
    expect(chunks.some(text => SPINNER.some(frame => text.includes(`${frame} working `)) && /working \d+s/.test(text))).toBe(true);
  } finally { surface.close(); }
}));

test("the footer drops the spinner and the time after the work clears", () => rich(async () => {
  const { surface, chunks } = makeSurface();
  try {
    surface.start();
    surface.setWork({ rows: [], status: "Running find" });
    expect(await waitUntil(() => chunks.some(spinning))).toBe(true);
    chunks.length = 0;
    surface.setWork(undefined);
    const idle = () => chunks.filter(text => text.includes("Casper · / for commands"));
    expect(await waitUntil(() => idle().length > 0)).toBe(true);
    expect(spinning(idle().at(-1)!)).toBe(false);
    expect(Bun.stripANSI(surface.footerLine(80))).toStartWith("Casper · / for commands");
  } finally { surface.close(); }
}));

test("a picker open during work (the model picker, sign-in) shows waiting for you, not a spinner", () => rich(async () => {
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
    expect(seen).toStartWith("? waiting for you");
    expect(spinning(seen)).toBe(false);
    expect(surface.footerLine(80)).not.toContain("waiting for you");
  } finally { surface.close(); }
}));
