import { expect, test } from "bun:test";
import { StepRail } from "../src/app/steps";
import { interactiveTerminal } from "./support/tty";

test("the step rail lists each stage once, in order, with a check mark once it ends", () => {
  const rail = new StepRail();
  expect(rail.text()).toBeUndefined();
  rail.update("checklist", "start");
  expect(rail.text()).toBe("checklist");
  rail.update("checklist", "end"); rail.update("task", "start");
  expect(rail.text()).toBe("checklist ✓ · building");
  rail.update("task", "end"); rail.update("checks", "start"); rail.update("smoke", "start");
  expect(rail.text()).toBe("checklist ✓ · building ✓ · checks · smoke");
  rail.update("smoke", "end"); rail.update("checks", "end"); rail.update("repair", "start");
  expect(rail.text()).toBe("checklist ✓ · building ✓ · checks ✓ · smoke ✓ · repair");
  // A stage that runs again is active again.
  rail.update("repair", "end"); rail.update("checks", "start");
  expect(rail.text()).toBe("checklist ✓ · building ✓ · checks · smoke ✓ · repair ✓");
  rail.clear();
  expect(rail.text()).toBeUndefined();
});

test("while work runs the footer leads with the steps; idle, it shows the plain status", async () => {
  process.env.TERM = "xterm-256color";
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("project │ fixture/demo │ idle"); session.terminal.start();
    session.terminal.setActivity("working");
    session.terminal.setSteps("checklist ✓ · building");
    await session.screen.until(output => Bun.stripANSI(output).includes("checklist ✓ · building"));
    const footer = Bun.stripANSI(session.screen.output).split(/\r?\n/).filter(line => line.includes("checklist ✓ · building")).at(-1)!;
    expect(footer.indexOf("checklist ✓ · building")).toBeLessThan(footer.indexOf("project"));
    session.terminal.setSteps(undefined); session.terminal.setActivity(undefined);
  } finally { session.close(); }
});

test("the footer timer pauses while a question waits for the user", async () => {
  process.env.TERM = "xterm-256color";
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("project │ fixture/demo │ idle"); session.terminal.start();
    // A submitted request makes the surface busy, as during a real task.
    const command = session.terminal.readCommand();
    session.input.write("go\r");
    await command;
    session.terminal.setSteps("checklist ✓ · building");
    const answered = session.terminal.ask("Which one?", [{ label: "A" }, { label: "B" }], false);
    await session.screen.until(output => Bun.stripANSI(output).includes("? waiting for you"));
    await Bun.sleep(2200);
    session.input.write("1");
    await answered;
    const from = session.screen.output.length;
    session.terminal.setSteps("checklist ✓ · building ✓");
    await session.screen.until(output => Bun.stripANSI(output.slice(from)).includes("building ✓ · "));
    // Over two seconds passed, all of it waiting: the timer still reads under two seconds.
    expect(Bun.stripANSI(session.screen.output.slice(from))).toMatch(/building ✓ · [01]s/);
    session.terminal.setSteps(undefined);
  } finally { session.close(); }
}, 15_000);

test("a stage that ended without doing its job reads skipped, never ✓", () => {
  const rail = new StepRail();
  rail.update("checklist", "start"); rail.update("checklist", "end"); rail.skip("checklist"); rail.update("task", "start");
  expect(rail.text()).toBe("checklist skipped · building");
});

test("in a narrow terminal the footer keeps the current stage and the time", async () => {
  process.env.TERM = "xterm-256color";
  const session = interactiveTerminal();
  try {
    session.screen.writer.columns = 40;
    session.terminal.setStatus("casper-uxtest │ openrouter/some-long-model │ idle"); session.terminal.start();
    const command = session.terminal.readCommand();
    session.input.write("go\r");
    await command;
    session.terminal.setSteps("checklist ✓ · building ✓ · checks");
    await session.screen.until(output => /checks · \ds │/.test(Bun.stripANSI(output)));
    session.terminal.setSteps(undefined);
  } finally { session.close(); }
}, 15_000);

test("Enter mid-task shows its note for a moment, then the steps and timer come back", async () => {
  process.env.TERM = "xterm-256color";
  const session = interactiveTerminal();
  session.terminal.setBusySubmit(line => `${line} waits until this task ends · draft kept`);
  try {
    session.terminal.setStatus("project │ fixture/demo │ working"); session.terminal.start();
    const command = session.terminal.readCommand();
    session.input.write("go\r");
    await command;
    session.terminal.setSteps("checklist ✓ · building");
    session.input.write("/undo\r");
    await session.screen.until(output => output.includes("/undo waits until this task ends"));
    expect(session.terminal.footerLine(100)).toContain("waits until this task ends");
    await Bun.sleep(2600);
    expect(Bun.stripANSI(session.terminal.footerLine(100)!)).toContain("checklist ✓ · building");
    session.terminal.setSteps(undefined);
  } finally { session.close(); }
}, 15_000);

test("while a picker is open the footer waits for you: no spinner, no running timer, no 'idle'", async () => {
  const { PassThrough } = await import("node:stream");
  const { TerminalSurface } = await import("../src/tui/surface");
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const surface = new TerminalSurface({ input, output: { write: () => {}, columns: 100, rows: 30 }, color: false, onEOF: () => {} }, () => {}, () => {});
  try {
    surface.start();
    surface.setStatus("project │ fixture/demo │ idle", process.cwd());
    const command = surface.readCommand();
    input.write("/effort\r");
    await command;
    const done = Promise.withResolvers<void>();
    const picking = surface.exclusiveHost()!.mount(async view => { view.show({ render: () => ["PICKER"], invalidate() {} }); await done.promise; });
    await Bun.sleep(20);
    expect(surface.footerLine(100)).toStartWith("? waiting for you");
    done.resolve(); await picking;
  } finally { surface.close(); input.destroy(); }
});
