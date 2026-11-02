import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRuntime, RuntimeConversation } from "../src/runtime/types";
import { buildNextRow, keyCaps } from "../src/tui/next-row";
import { ansiCells, cellsFor, type Cell } from "./support/ansi-cells";
import { richApp } from "./support/app";
import { withEnv } from "./support/env";

/**
 * A real start in ~/Documents read "Next:  1  Continue yesterday's conversation (1    5  messages)    2  Saved pages (12)":
 * the conversation's first message was a stray "1" (taken as its title), and the " · " between that title and "5
 * messages" was read as the gap before another step, so the 5 became a key cap.
 */

const PAGE = "<!doctype html><html><head><title>radar</title></head><body><h1>radar</h1></body></html>";
const PAGES = { ".casper/pages/homeassist-0f0f0f0f0f0f0f0f/planes-radar.html": PAGE };
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString();

function startRuntime(saved: RuntimeConversation[], project: string): AgentRuntime {
  const file = path.join(path.dirname(project), "session.jsonl");
  return {
    async start() {
      await writeFile(file, "");
      return {
        setTools: () => {}, getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" as const }),
        getState: () => ({ cwd: "", isStreaming: false }),
        getSessionInfo: () => ({ cwd: project, sessionId: "current", sessionFile: file }),
        forkSession: async () => ({ cwd: project, sessionId: "fork", sessionFile: file }),
        switchSession: async () => ({ cwd: project, sessionId: "current", sessionFile: file }),
        subscribe: () => () => {}, abort: async () => {}, prompt: async () => {},
        listConversations: async () => saved, resumeConversation: async () => {},
      };
    },
    async dispose() {},
  };
}

/** The start's Next row as the real terminal drew it: its text, and its cells from the writer's own bytes. */
async function startRow(earlier: RuntimeConversation): Promise<{ text: string; cells: Cell[][] }> {
  let result = { text: "", cells: [] as Cell[][] };
  await withEnv({ TERM: "xterm-256color", NO_COLOR: undefined }, async () => {
    const app = await richApp(project => startRuntime([earlier], project), { savedConversations: async () => [earlier] }, { homeFiles: PAGES });
    try {
      await app.until(text => /Next:[^\n]*Saved pages \(1\)/.test(text));
      const rendered = (app.app.terminal as unknown as { surface: { tui: { render(width: number): string[] } } }).surface.tui.render(120);
      const rows = rendered.filter(row => Bun.stripANSI(row).includes("Next:"));
      expect(rows.length).toBe(1);
      result = { text: Bun.stripANSI(rows[0]!), cells: ansiCells(rows) };
    } finally { await app.close(); }
  });
  return result;
}

const capped = (cells: Cell[][]) => cells.flat().filter(cell => cell.inverse).map(cell => cell.char).join("");

test("a first message with no words in it (a stray 1) is no title: the count reads plainly and only the step keys are caps", async () => {
  const { text, cells } = await startRow({ id: "a1", firstMessage: "1", modified: yesterday(), messages: 5 });
  expect(text).toContain("Next:  1  Continue yesterday's conversation (5 messages)    2  Saved pages (1)   · press a number");
  expect(capped(cells)).toBe(" 1  2 ");
  expect(cellsFor(cells, "5 messages").some(cell => cell.inverse || cell.bold)).toBe(false);
}, 30_000);

test("a conversation with no title at all shows just its count, never a placeholder", async () => {
  const { text } = await startRow({ id: "a1", modified: yesterday(), messages: 15 });
  expect(text).toContain("1  Continue yesterday's conversation (15 messages)    2  Saved pages (1)");
  expect(text).not.toContain("no messages yet");
}, 30_000);

test("a titled conversation keeps its title, and a one-digit count after it is no key cap", async () => {
  const { text, cells } = await startRow({ id: "a1", name: "Fix the login bug", modified: yesterday(), messages: 5 });
  expect(text).toContain("1  Continue yesterday's conversation (Fix the login bug, 5 messages)    2  Saved pages (1)");
  expect(capped(cells)).toBe(" 1  2 ");
  expect(cellsFor(cells, "5 messages").some(cell => cell.inverse || cell.bold)).toBe(false);
}, 30_000);

test("a step's own words never hold the separator between steps, so a digit in them is never read as a key", () => {
  const row = buildNextRow({ more: [{ label: "See result", command: "/jobs show a", note: "fix it · 3 files" }, { label: "Saved pages", command: "/pages", note: "2" }] })!;
  expect(row.line).toBe("Next: 1 See result (fix it, 3 files) · 2 Saved pages (2)");
  expect(keyCaps(row.line.slice(6), false)).toBe("[1] See result (fix it, 3 files)   [2] Saved pages (2)   · press a number");
  // Keys out of order mean the text is not a row of steps: it is left as written.
  expect(keyCaps("1 Show diff (1 · 5 messages) · 2 Undo", false)).toBe("1 Show diff (1 · 5 messages) · 2 Undo");
});
