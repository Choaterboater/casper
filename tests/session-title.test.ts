import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { TITLE_RESTORE, TITLE_SAVE } from "../src/tui/host-terminal";
import { sessionTitle, windowTitle } from "../src/tui/session-title";
import { InteractiveTerminal } from "../src/tui/terminal";
import { fakeWriter } from "./support/tty";

process.env.TERM = "xterm-256color";

test("a conversation is named from its first request, without a model call", () => {
  expect(sessionTitle("Build a small web app in this empty folder: an IPv4 subnet calculator.\n- Input an address")).toBe("IPv4 subnet calculator");
  expect(sessionTitle("Please fix the login bug in auth.ts where users get logged out")).toBe("fix the login bug in auth.ts where users…");
  expect(sessionTitle("\n  add dark mode. Then run the tests")).toBe("add dark mode");
  expect(sessionTitle("Can you rename getUser to fetchUser?")).toBe("rename getUser to fetchUser");
  expect(sessionTitle("a VLAN report — keep it short")).toBe("VLAN report");
});

test("nothing to name: blank text and slash commands", () => {
  expect(sessionTitle("   \n ")).toBeUndefined();
  expect(sessionTitle("/status")).toBeUndefined();
  expect(sessionTitle("...")).toBeUndefined();
});

test("the window title marks busy work with ◐ and says only the name when idle", () => {
  expect(windowTitle("subnet calculator", true)).toBe("◐ Casper · subnet calculator");
  expect(windowTitle("subnet calculator", false)).toBe("Casper · subnet calculator");
});

test("the title is set in any rich terminal, written only when it changes, and the old one comes back at exit", () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter();
  const terminal = new InteractiveTerminal(input, screen.writer, () => {}, () => {});
  terminal.setStatus("fixture"); terminal.start();
  terminal.setTitle("◐ Casper · notes");
  terminal.setTitle("◐ Casper · notes");
  terminal.setTitle("Casper · notes");
  terminal.close(); input.destroy();
  const output = screen.output;
  expect(output.split("\x1b]0;◐ Casper · notes\x07").length).toBe(2);
  expect(output).toContain("\x1b]0;Casper · notes\x07");
  expect(output.indexOf(TITLE_SAVE)).toBeLessThan(output.indexOf("\x1b]0;◐ Casper · notes"));
  expect(output.lastIndexOf(TITLE_RESTORE)).toBeGreaterThan(output.lastIndexOf("\x1b]0;Casper · notes"));
});

test("a result gets a colored edge on the rich terminal (green pass, red fail, yellow between); plain stays as it was", () => {
  const rich = (text: string) => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
    const screen = fakeWriter();
    const terminal = new InteractiveTerminal(input, screen.writer, () => {}, () => {});
    terminal.setStatus("fixture"); terminal.start();
    terminal.writeResult(text);
    terminal.close(); input.destroy();
    return screen.output;
  };
  expect(rich("✓ Verified · test passed · 3 files changed\nUndo: /undo 1\n")).toContain("\x1b[32m▌\x1b[0m");
  expect(rich("✗ test failed\n")).toContain("\x1b[31m▌\x1b[0m");
  expect(rich("• Checks passed — not proven\n✓ test passed\n")).toContain("\x1b[33m▌\x1b[0m");
  const plain = fakeWriter();
  const terminal = new InteractiveTerminal(Object.assign(new PassThrough(), { isTTY: false }), plain.writer, () => {}, () => {});
  terminal.writeResult("✓ test passed\n");
  expect(plain.output).not.toContain("▌");
  expect(plain.output).toContain("✓ test passed");
});
