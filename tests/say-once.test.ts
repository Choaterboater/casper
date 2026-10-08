import { expect, test } from "bun:test";
import type { AgentRuntime, RuntimeStatus } from "../src/runtime/types";
import { interactiveTerminal } from "./support/tty";
import { richApp } from "./support/app";

/** Each fact on screen is said once, in one form: the banner's model line, /status beside the footer, a line typed
 * while the answer streams. */

const status: RuntimeStatus = { provider: "fixture", model: "demo", auth: "configured", thinkingLevel: "high" };

function runtime(): AgentRuntime {
  return {
    async start() {
      return {
        setTools: () => {},
        getStatus: () => status,
        getUsage: () => ({ tokens: { input: 900, output: 112, cacheRead: 0, cacheWrite: 0, total: 1012 }, context: { tokens: 1300, contextWindow: 128_000, percent: 1.04 } }),
        getState: () => ({ cwd: "", isStreaming: false }),
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async () => {},
      } as never;
    },
    async dispose() {},
  };
}

test("the banner names the model before the command hint", async () => {
  process.env.TERM = "xterm-256color";
  const app = await richApp(runtime);
  try {
    await app.until(text => text.includes("idle"));
    const screen = app.screen();
    expect(screen.indexOf(" model     ")).toBeGreaterThan(-1);
    expect(screen.indexOf(" model     ")).toBeLessThan(screen.indexOf(" /help · /status · /login · /model"));
  } finally { await app.close(); }
}, 30_000);

test("/status writes provider/model and the context share as the footer does", async () => {
  process.env.TERM = "xterm-256color";
  const app = await richApp(runtime);
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("hello\r");
    await app.until(text => text.includes("fixture/demo · high │ ctx 1%~ │ idle"));
    app.input.write("/status\r");
    await app.until(text => text.includes(" context   "));
    const screen = app.screen();
    expect(screen).toContain(" model     fixture/demo · effort high");
    expect(screen).toContain(" context   1%~");
    expect(screen).toContain("fixture/demo · high │ ctx 1%~");
  } finally { await app.close(); }
}, 30_000);

test("a line typed while the answer streams is echoed after the words so far, and the answer carries on under it", async () => {
  process.env.TERM = "xterm-256color";
  const session = interactiveTerminal();
  const REPAINT = "\x1b[2J\x1b[H\x1b[3J";
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    void session.terminal.readCommand();
    session.input.write("go\r");
    await session.screen.until(output => output.includes("❯ go"));
    session.terminal.setBusySubmit(() => true);
    session.terminal.assistant("First part of the answer.\n\n");
    session.input.write("next idea\r");
    await session.screen.until(output => output.includes("❯ next idea"));
    session.terminal.assistant("Second part.");
    session.terminal.endAssistant();
    // A width change repaints the whole transcript, in order.
    const repaints = session.screen.output.split(REPAINT).length;
    session.screen.writer.columns = 90; session.screen.writer.emit("resize");
    await session.screen.until(() => session.screen.output.split(REPAINT).length > repaints && session.screen.output.split(REPAINT).at(-1)!.includes("Second part."));
    const frame = Bun.stripANSI(session.screen.output.split(REPAINT).at(-1)!).split("\r\n").map(line => line.trimEnd()).filter(Boolean);
    const from = frame.indexOf("First part of the answer.");
    expect(frame.slice(from, from + 3)).toEqual(["First part of the answer.", "❯ next idea", "Second part."]);
  } finally { session.close(); }
});
