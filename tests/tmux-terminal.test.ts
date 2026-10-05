import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { RuntimeEventView } from "../src/app/events";
import { bellSequence, detectHostTerminal, TITLE_RESTORE, TITLE_SAVE, tmuxPassthrough, type HostCommand } from "../src/tui/host-terminal";
import type { ActivityPane } from "../src/tui/side-pane";
import { InteractiveTerminal, type TerminalHost } from "../src/tui/terminal";
import { fakeWriter } from "./support/tty";

process.env.TERM = "xterm-256color";

function fakePane() {
  const shown: string[][] = [], logged: string[] = [];
  let closed = 0;
  const pane: ActivityPane = { show: lines => { shown.push([...lines]); }, log: line => { logged.push(line); }, close: () => { closed++; } };
  return { pane, shown, logged, get closed() { return closed; } };
}

function session(host?: TerminalHost) {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter();
  const terminal = new InteractiveTerminal(input, screen.writer, () => {}, () => {}, host);
  const events = new RuntimeEventView(terminal, { write: text => { terminal.write(text); } }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
  });
  return { input, screen, terminal, events, close: () => { terminal.close(); input.destroy(); } };
}

test("Casper knows tmux and iTerm2 from the environment alone", () => {
  expect(detectHostTerminal({ TMUX: "/tmp/tmux-0/default,42,0", TMUX_PANE: "%3", TERM: "tmux-256color" })).toEqual({ tmux: true, tmuxPane: "%3", iterm: false });
  // Over ssh from a tmux pane: TERM says tmux, but there is no pane here to split.
  expect(detectHostTerminal({ TERM: "tmux-256color" })).toEqual({ tmux: true, iterm: false });
  expect(detectHostTerminal({ TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: "w0t0p0:ABCDEF12-3456" }))
    .toEqual({ tmux: false, iterm: true, itermSession: "ABCDEF12-3456" });
  expect(detectHostTerminal({ LC_TERMINAL: "iTerm2", TMUX: "/tmp/s,1,0", TMUX_PANE: "%0" })).toEqual({ tmux: true, tmuxPane: "%0", iterm: true });
  expect(detectHostTerminal({ TERM: "xterm-256color" })).toEqual({ tmux: false, iterm: false });
});

test("the done bell reaches iTerm2 through tmux; elsewhere it is a plain bell", () => {
  expect(bellSequence({ tmux: true, iterm: false }, "done")).toBe("\x07");
  expect(bellSequence({ tmux: false, iterm: true }, "done")).toBe("\x07\x1b]9;done\x07");
  expect(bellSequence({ tmux: true, iterm: true }, "done")).toBe(`\x07${tmuxPassthrough("\x1b]9;done\x07")}`);
  expect(tmuxPassthrough("\x1b]9;x\x07")).toBe("\x1bPtmux;\x1b\x1b]9;x\x07\x1b\\");
});

test("inside tmux the busy steps go to the side pane, not the Working box, and the pane closes at exit", async () => {
  const fake = fakePane();
  let opened = 0;
  const s = session({ host: { tmux: true, tmuxPane: "%1", iterm: false }, openPane: () => { opened++; return fake.pane; }, run: () => ({ status: 1, stdout: "" }) });
  try {
    s.terminal.setStatus("fixture"); s.terminal.start();
    expect(opened).toBe(0); // no pane until there is something to show
    s.events.handle({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: { command: "npm test" } });
    s.events.handle({ type: "tool_end", toolName: "bash", toolCallId: "b1", input: { command: "npm test" }, isError: false });
    s.terminal.logHelper("helper explorer · ✓ read · src/app.ts");
    expect(opened).toBe(1);
    expect(fake.shown.flat()).toContain("• bash · npm test");
    expect(fake.logged).toEqual(["helper explorer · ✓ read · src/app.ts"]);
    s.terminal.write("done\n");
    await s.screen.until(output => output.includes("done"));
    expect(Bun.stripANSI(s.screen.output)).not.toContain(" Working ");
  } finally { s.close(); }
  expect(fake.closed).toBe(1);
  s.terminal.close();
  expect(fake.closed).toBe(1);
});

test("outside tmux the Working box stays and no pane is opened", async () => {
  const s = session();
  try {
    s.terminal.setStatus("fixture"); s.terminal.start();
    s.events.handle({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: { command: "npm test" } });
    await s.screen.until(output => output.includes(" Working "));
    s.terminal.logHelper("helper explorer · read");
    expect(s.terminal.hasPane).toBe(false);
  } finally { s.close(); }
});

test("the title is set for the session and the one before comes back at exit; the pane setting is undone", () => {
  const calls: string[][] = [];
  const run: HostCommand = argv => { calls.push([...argv]); return { status: 0, stdout: "" }; };
  const s = session({ host: { tmux: true, tmuxPane: "%4", iterm: true }, openPane: () => undefined, run });
  s.terminal.setStatus("fixture"); s.terminal.start();
  s.terminal.setTitle("Casper · notes");
  s.close();
  const output = s.screen.output;
  expect(output.indexOf(TITLE_SAVE)).toBeGreaterThanOrEqual(0);
  expect(output).toContain("\x1b]0;Casper · notes\x07");
  expect(output.indexOf(TITLE_RESTORE)).toBeGreaterThan(output.indexOf("\x1b]0;Casper · notes\x07"));
  // Passthrough (for iTerm2's notice) is turned on for Casper's own pane only, then unset again.
  expect(calls).toContainEqual(["tmux", "set-option", "-p", "-t", "%4", "allow-passthrough", "on"]);
  expect(calls).toContainEqual(["tmux", "set-option", "-p", "-u", "-t", "%4", "allow-passthrough"]);
  expect(calls.every(argv => argv.includes("%4"))).toBe(true);
});

test("a pane that already has its own passthrough setting is left as it is", () => {
  const calls: string[][] = [];
  const run: HostCommand = argv => { calls.push([...argv]); return { status: 0, stdout: argv[1] === "show-options" ? "off\n" : "" }; };
  const s = session({ host: { tmux: true, tmuxPane: "%4", iterm: true }, openPane: () => undefined, run });
  s.terminal.start(); s.close();
  expect(calls.map(argv => argv[1])).toEqual(["show-options"]);
});

test("the bell inside tmux under iTerm2 carries the notice through tmux", async () => {
  const s = session({ host: { tmux: true, tmuxPane: "%4", iterm: true }, openPane: () => undefined, run: () => ({ status: 1, stdout: "" }) });
  try {
    s.terminal.setStatus("fixture"); s.terminal.start();
    s.terminal.setAttentionAfter(0);
    const first = s.terminal.readCommand();
    s.input.write("do it\r");
    await first;
    void s.terminal.readCommand();
    expect(s.screen.output).toContain("\x1bPtmux;\x1b\x1b]9;Casper is waiting for you\x07\x1b\\");
  } finally { s.close(); }
});

test("inside tmux Casper's helpers show their steps in the side pane", async () => {
  const { CasperApp } = await import("../src/app");
  const fake = fakePane();
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter();
  const child = {
    async start(): Promise<never> { throw new Error("read-only only"); },
    async startReadOnly(options: { cwd: string }) {
      const listeners = new Set<(event: import("../src/runtime/types").RuntimeEvent) => void>();
      return {
        prompt: async () => {
          for (const listener of listeners) listener({ type: "tool_start", toolName: "grep", toolCallId: "g1", input: { pattern: "login", path: options.cwd } });
          for (const listener of listeners) listener({ type: "assistant_text_delta", delta: "src/login.ts:4" });
        },
        abort: async () => {}, subscribe: (listener: (event: import("../src/runtime/types").RuntimeEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        getState: () => ({ cwd: options.cwd, isStreaming: false }),
      };
    },
    async dispose() {},
  };
  const app = new CasperApp({ input, output: screen.writer, subagentRuntimeFactory: () => child as never,
    terminalHost: { host: { tmux: true, tmuxPane: "%1", iterm: false }, openPane: () => fake.pane, run: () => ({ status: 1, stdout: "" }) } });
  try {
    const result = await app.subagents.run({ role: "explorer", goal: "Find the login code", cwd: "/repo", projectContext: "rules" });
    expect(result.status).toBe("completed");
    expect(fake.logged).toEqual(["helper explorer started: Find the login code", "helper explorer · • grep · login · /repo", "helper explorer finished"]);
    expect(screen.output).not.toContain("helper explorer");
  } finally { await app.close(); input.destroy(); }
  expect(fake.closed).toBe(1);
});
