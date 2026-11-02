import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import { folderTrust, folderTrustDefaults } from "../src/project/trust";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener } from "../src/runtime/types";
import { ansiCells, cellsFor } from "./support/ansi-cells";
import { richApp } from "./support/app";
import { withEnv } from "./support/env";

/**
 * A question asked in the home folder ("what is pac mcp") ended in an amber card: "⚠ Not verified: Casper never trusts
 * your home folder; open a project folder to run its checks", "Changes unknown: not a project folder". The AI had only
 * read a file with `python3 -c`. Casper never runs checks there and can't compare its files, so a command it can't read
 * as a look leaves changes unknown; with nothing it can see changed, that is one grey line, not a card.
 */

// The suite trusts every folder (tests/support/preload.ts); these tests read the folder as Casper does: home is never trusted.
const suiteLookup = folderTrustDefaults.lookup;
beforeAll(() => { folderTrustDefaults.lookup = folderTrust; });
afterAll(() => { folderTrustDefaults.lookup = suiteLookup; });

const UNKNOWN = "– Changes unknown: not a project folder (your home folder)";

/** A runtime whose turn runs these tools (as the AI would) and then answers. */
function answering(folder: string, tools: Array<{ name: string; input: Record<string, unknown> }>): AgentRuntime {
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
  return {
    async start() {
      return {
        setTools: () => {}, getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" as const }),
        getState: () => ({ cwd: folder, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {},
        prompt: async () => {
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          for (const [index, tool] of tools.entries()) {
            emit({ type: "tool_start", toolName: tool.name, toolCallId: `t${index}`, input: tool.input });
            emit({ type: "tool_end", toolName: tool.name, toolCallId: `t${index}`, input: tool.input, isError: false, output: { text: "ok", truncated: false } });
          }
          emit({ type: "assistant_text_delta", delta: "PAC is a proxy auto-config file.\n" });
          emit({ type: "assistant_response_end", stopReason: "stop" });
          emit({ type: "message_end" });
        },
      };
    },
    async dispose() {},
  };
}

/** Asks `request` in the home folder and returns the screen and the rendered rows once the task has ended. */
async function askAtHome(request: string, tools: Array<{ name: string; input: Record<string, unknown> }>) {
  let result = { screen: "", rows: [] as string[] };
  await withEnv({ TERM: "xterm-256color", NO_COLOR: undefined }, async () => {
    const app = await richApp(project => answering(path.join(path.dirname(project), "home"), tools), { savedConversations: async () => [] }, { trusted: false, openHome: true });
    try {
      await app.until(text => text.includes("idle"));
      const from = app.screen().length;
      app.input.write(`${request}\r`);
      await app.until(text => text.slice(from).includes("PAC is a proxy auto-config file."));
      // The task has ended once the footer is idle again after the answer.
      await app.until(text => { const at = text.lastIndexOf("PAC is a proxy auto-config file."); return at >= 0 && text.lastIndexOf("idle") > at; });
      await Bun.sleep(100);
      const rows = (app.app.terminal as unknown as { surface: { tui: { render(width: number): string[] } } }).surface.tui.render(120);
      result = { screen: app.screen().slice(from), rows };
    } finally { await app.close(); }
  });
  return result;
}

test("a question in the home folder whose command Casper can't read as a look shows one grey line, not an amber card", async () => {
  const { screen, rows } = await askAtHome("what is pac mcp", [{ name: "bash", input: { command: "python3 -c \"print(open('notes.json').read())\"" } }]);
  expect(screen).not.toContain("Not verified");
  expect(screen).not.toContain("never trusts your home folder");
  expect(screen).not.toContain("▌");
  const line = rows.filter(row => Bun.stripANSI(row).includes(UNKNOWN));
  expect(line.length).toBe(1);
  // Grey (the muted role, dim), never amber.
  const cells = cellsFor(ansiCells(line), UNKNOWN);
  expect(cells.length).toBe(UNKNOWN.length);
  expect(cells.every(cell => cell.dim)).toBe(true);
}, 30_000);

test("a question in the home folder that only looked shows no card and no line", async () => {
  const { screen } = await askAtHome("what is pac mcp", [{ name: "bash", input: { command: "ls" } }]);
  expect(screen).not.toContain("Not verified");
  expect(screen).not.toContain("Changes unknown");
  expect(screen).not.toContain("▌");
}, 30_000);

test("in the home folder a command Casper knows changes things keeps the card", async () => {
  const { screen } = await askAtHome("what is pac mcp", [{ name: "bash", input: { command: "rm notes.json" } }]);
  expect(screen).toContain("▌");
  expect(screen).toContain("deleted notes.json");
}, 30_000);

test("in the home folder an edit by the AI keeps the card", async () => {
  const { screen } = await askAtHome("what is pac mcp", [{ name: "write", input: { path: "notes.json" } }]);
  expect(screen).toContain("▌");
  expect(screen).toContain("Changes unknown");
}, 30_000);

test("in the home folder a request for a change keeps the card, even when its command shows no change Casper knows", async () => {
  const { screen } = await askAtHome("add the pac server to notes.json", [{ name: "bash", input: { command: "python3 -c \"print(1)\"" } }]);
  expect(screen).toContain("▌");
  expect(screen).toContain("Changes unknown");
}, 30_000);
