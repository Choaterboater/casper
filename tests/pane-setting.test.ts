import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { AgentRuntime } from "../src/runtime/types";
import { readPaneSetting, savePaneSetting } from "../src/tui/pane-setting";
import type { ActivityPane } from "../src/tui/side-pane";
import { InteractiveTerminal, type TerminalHost } from "../src/tui/terminal";
import { richApp } from "./support/app";
import { waitUntil } from "./support/wait";
import { removeTempDir } from "./support/temp-dir";

process.env.TERM = "xterm-256color";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });

function fakePane() {
  let opened = 0, closed = 0;
  const shown: string[] = [];
  const pane: ActivityPane = { show: lines => { shown.push(...lines); }, log: () => {}, close: () => { closed++; } };
  return { open: () => { opened++; return pane; }, shown, get opened() { return opened; }, get closed() { return closed; } };
}

function terminalOf(columns: number, host: TerminalHost) {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns, rows: 30, write(text: string) { output += text; } });
  const terminal = new InteractiveTerminal(input, writer, () => {}, () => {}, host);
  return { terminal, writer, screen: () => Bun.stripANSI(output), close: () => { terminal.close(); input.destroy(); } };
}

test("the saved pane setting reads back; nothing saved reads as unset", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-pane-")); roots.push(home);
  expect(await readPaneSetting(home)).toBeUndefined();
  await savePaneSetting(home, "off");
  expect(await readPaneSetting(home)).toBe("off");
  expect(JSON.parse(await readFile(path.join(home, ".casper", "pane.json"), "utf8"))).toEqual({ version: 1, pane: "off" });
  await savePaneSetting(home, "on");
  expect(await readPaneSetting(home)).toBe("on");
});

test("the steps pane opens only on a wide window, and /pane off closes it and keeps the Working box", () => {
  const fake = fakePane();
  const narrow = terminalOf(100, { host: { tmux: true, tmuxPane: "%1", iterm: false }, openPane: fake.open, run: () => ({ status: 1, stdout: "" }) });
  try {
    narrow.terminal.start();
    narrow.terminal.setActivity(["• bash · npm test"]);
    expect(fake.opened).toBe(0);
    // The window grew: the next step opens it.
    narrow.writer.columns = 140;
    narrow.terminal.setActivity(["• bash · npm test", "• read · a.ts"]);
    expect(fake.opened).toBe(1);
    narrow.terminal.setPane("off");
    expect(fake.closed).toBe(1);
    expect(narrow.terminal.hasPane).toBe(false);
    narrow.terminal.setActivity(["• bash · ls"]);
    expect(fake.opened).toBe(1);
    narrow.terminal.setPane("on");
    narrow.terminal.setActivity(["• bash · pwd"]);
    expect(fake.opened).toBe(2);
  } finally { narrow.close(); }
});

function runtime(): AgentRuntime {
  return {
    async start() {
      return {
        setTools: () => {}, getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" as const }),
        getState: () => ({ cwd: "", isStreaming: false }), subscribe: () => () => {}, abort: async () => {}, prompt: async () => {},
      };
    },
    async dispose() {},
  };
}

test("on iTerm2 Casper asks once before the first task (1 keeps one window) and /pane on|off switches it, saved", async () => {
  const fake = fakePane();
  const iterm: TerminalHost = { host: { tmux: false, iterm: true, itermSession: "ABCDEF12-3456" }, openPane: fake.open, run: () => ({ status: 1, stdout: "" }) };
  const app = await richApp(() => runtime(), { terminalHost: iterm });
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("say hi\r");
    await app.until(text => text.includes("Show Casper's steps in a split"));
    app.input.write("1");
    await app.until(text => text.includes("✓ No, keep one window"));
    await waitUntil(async () => await readPaneSetting(app.home) !== undefined);
    expect(await readPaneSetting(app.home)).toBe("off");
    const asked = app.screen().split("Show Casper's steps in a split").length;
    app.input.write("say hi again\r");
    await app.until(text => text.includes("❯ say hi again"));
    await Bun.sleep(200);
    expect(app.screen().split("Show Casper's steps in a split").length).toBe(asked);
    app.input.write("/pane on\r");
    await app.until(text => text.includes("[pane] On"));
    expect(await readPaneSetting(app.home)).toBe("on");
    app.input.write("/pane off\r");
    await app.until(text => text.includes("[pane] Off"));
    expect(await readPaneSetting(app.home)).toBe("off");
  } finally { await app.close(); }
}, 30_000);
