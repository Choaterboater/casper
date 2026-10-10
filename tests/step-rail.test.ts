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
    session.terminal.setWork({ rows: [], status: "working" });
    session.terminal.setSteps("checklist ✓ · building");
    await session.screen.until(output => Bun.stripANSI(output).includes("checklist ✓ · building"));
    const footer = Bun.stripANSI(session.screen.output).split(/\r?\n/).filter(line => line.includes("checklist ✓ · building")).at(-1)!;
    expect(footer.indexOf("checklist ✓ · building")).toBeLessThan(footer.indexOf("project"));
    session.terminal.setSteps(undefined); session.terminal.setWork(undefined);
  } finally { session.close(); }
});

test("the footer timer counts a question's wait, like the live rows' step times", async () => {
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
    session.terminal.setSteps("checklist ✓ · building ✓ · checks");
    await session.screen.until(output => Bun.stripANSI(output.slice(from)).includes("checks · "));
    // Over two seconds passed, all of it waiting: the timer counts them, so it agrees with the box's step times.
    expect(Bun.stripANSI(session.screen.output.slice(from))).toMatch(/checks · [2-9]s/);
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

test("the footer says the state once: idle at its end only while Casper waits for a request, never working", async () => {
  const { mkdtemp, mkdir, realpath } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { PassThrough } = await import("node:stream");
  const { CasperApp } = await import("../src/app");
  const { updateFooter } = await import("../src/app/footer");
  const { loadProjectContext } = await import("../src/project/context");
  const { removeTempDir } = await import("./support/temp-dir");
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-footer-state-")));
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(home); await mkdir(project);
  const app = new CasperApp({ runtimeFactory: () => { throw new Error("no model"); }, input: new PassThrough(), output: { write: () => {} }, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }) });
  try {
    await app.start(project);
    const seen: string[] = [];
    app.terminal.setStatus = (status: string) => { seen.push(status); };
    updateFooter(app);
    // A command or task runs (or a picker such as /settings is open): the spinner or "? waiting for you" says so.
    app.commandActive = true;
    updateFooter(app);
    expect(seen[0]).toEndWith(" │ idle");
    expect(seen[1]).not.toMatch(/idle|working/);
  } finally { await app.close(); await removeTempDir(base); }
});

test("the elapsed time sits right after the spinner, before and after the first stage", async () => {
  process.env.TERM = "xterm-256color";
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("project │ fixture/demo"); session.terminal.start();
    const command = session.terminal.readCommand();
    session.input.write("go\r");
    await command;
    expect(Bun.stripANSI(session.terminal.footerLine(100)!)).toMatch(/^\S \d+s │ project │ fixture\/demo$/);
    session.terminal.setSteps("building");
    expect(Bun.stripANSI(session.terminal.footerLine(100)!)).toMatch(/^\S building · \d+s │ project │ fixture\/demo$/);
    session.terminal.setSteps(undefined);
  } finally { session.close(); }
});

test("narrow or wide, the footer never shows a finished stage as what is happening: between stages only the time", async () => {
  process.env.TERM = "xterm-256color";
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("project/master │ fixture/demo · off │ ctx 1%~"); session.terminal.start();
    const command = session.terminal.readCommand();
    session.input.write("go\r");
    await command;
    const footer = (width: number) => Bun.stripANSI(session.terminal.footerLine(width)!);
    // The last stage ended and the next has not started (live: 'proof ✓ · 1s' at 34 columns).
    session.terminal.setSteps("checklist ✓ · building ✓ · proof ✓");
    for (const width of [30, 34, 100]) {
      expect(footer(width)).not.toContain("✓");
      expect(footer(width)).toMatch(/^\S \d+s │ project/);
    }
    // A stage runs: narrow shows that one, wide the whole rail.
    session.terminal.setSteps("checklist ✓ · building ✓ · proof ✓ · checks");
    expect(footer(34)).toMatch(/^\S checks · \d+s │/);
    expect(footer(100)).toMatch(/^\S checklist ✓ · building ✓ · proof ✓ · checks · \d+s │ project/);
    session.terminal.setSteps(undefined);
  } finally { session.close(); }
});

test("idle: the state is never cut off, and the hint shows when the whole line fits", async () => {
  process.env.TERM = "xterm-256color";
  const session = interactiveTerminal();
  try {
    // The live footer at 100 columns that lost its state: '… │ task 1.3k tok · session 3....'.
    const long = "project/no git │ openrouter/moonshotai/kimi-k2-0905 · auto → high │ ctx 1%~ │ task 1.3k tok · session 3.9k tok · $0.004 │ idle";
    session.terminal.setStatus(long); session.terminal.start();
    const footer = (width: number) => Bun.stripANSI(session.terminal.footerLine(width)!);
    expect(footer(100)).toEndWith("… │ idle");
    expect(footer(100).length).toBeLessThanOrEqual(100);
    expect(footer(40)).toEndWith("… │ idle");
    expect(footer(160)).toBe(`type / for commands │ ${long}`);
    session.terminal.setStatus("project/no git │ fixture/fixture · off │ ctx 1%~ │ idle");
    expect(footer(100)).toBe("type / for commands │ project/no git │ fixture/fixture · off │ ctx 1%~ │ idle");
  } finally { session.close(); }
});
