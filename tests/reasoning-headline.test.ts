import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { RuntimeEventView } from "../src/app/events";
import { RuntimeEventMapper } from "../src/app/json-events";
import { reasoningHeadline } from "../src/runtime/reasoning-headline";
import type { RuntimeEvent } from "../src/runtime/types";
import type { DisplayLevel } from "../src/tui/display";
import type { ActivityPane } from "../src/tui/side-pane";
import { TerminalSurface, type WorkView } from "../src/tui/surface";
import { InteractiveTerminal } from "../src/tui/terminal";
import { withEnv } from "./support/env";
import { waitUntil } from "./support/wait";

test("a reasoning headline is the summary's latest **Title**, else its latest finished sentence, at most 60 characters", () => {
  expect(reasoningHeadline("**Planning the port fix**\n\nI will check the config first.")).toBe("Planning the port fix");
  expect(reasoningHeadline("**Reading the config**\n\nok.\n\n**Choosing a free port**\n\nThe test")).toBe("Choosing a free port");
  expect(reasoningHeadline("I looked at the logs. The port is taken by another process. Next I")).toBe("The port is taken by another process");
  expect(reasoningHeadline("Checking the")).toBe("Checking the");
  expect(reasoningHeadline("The key is sk-live-abcdef1234567890. ")).toBe("The key is <redacted>");
  expect(reasoningHeadline("\u001b[2J**Title here**")).toBe("Title here");
  expect(Array.from(reasoningHeadline(`${"long ".repeat(30)}words.`)!)).toHaveLength(60);
  for (const text of ["", "   \n ", "**a**", "ok."]) expect(reasoningHeadline(text)).toBeUndefined();
});

const open: RuntimeEventView[] = [];
afterEach(() => { for (const view of open.splice(0)) view.reset(); });
function screen(options: { rich?: boolean; level?: DisplayLevel; on?: boolean } = {}) {
  let work: WorkView | undefined;
  const output: string[] = [];
  const terminal = { rich: options.rich ?? true, columns: 120, questionsShown: 0, questionOpen: false, endAssistant() {}, assistant() {},
    setWork(next?: WorkView) { work = next; }, writeFold() {} };
  const view = new RuntimeEventView(terminal as unknown as InteractiveTerminal, { write(text) { output.push(text); } }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
    display: () => options.level ?? "normal", reasoningHeadline: () => options.on ?? true,
  });
  open.push(view);
  return { get work() { return work; }, output, send: (...events: RuntimeEvent[]) => { for (const event of events) view.handle(event); } };
}
const thinking = (chars: number, headline?: string): RuntimeEvent => ({ type: "assistant_progress", kind: "thinking", chars, ...(headline ? { headline } : {}) });
const begin: RuntimeEvent = { type: "assistant_response_start", provider: "fixture", model: "m" };

test("the status row shows the headline while the model reasons; the generic line stays for the steps pane", () => {
  const s = screen();
  s.send(begin, thinking(3_000, "Planning the port fix"));
  expect(s.work?.headline).toStartWith("Planning the port fix · ");
  expect(s.work?.status).toStartWith("Reasoning · 2.9k chars · ");
  // Tool preparation and later reasoning without readable text fall back.
  s.send({ type: "assistant_progress", kind: "tool_call", toolName: "write", chars: 1_200 });
  expect(s.work?.headline).toBeUndefined();
  s.send(thinking(500));
  expect(s.work?.headline).toBeUndefined();
  expect(s.work?.status).toStartWith("Reasoning · 500 chars");
});

test("after a group of tool calls, its intent line stays before the headline while the model reasons on", () => {
  const s = screen();
  const input = { command: "bun test" };
  s.send(begin, { type: "assistant_text_delta", delta: "Fixing the port test.\n" }, { type: "tool_start", toolName: "bash", toolCallId: "1", input },
    { type: "tool_end", toolName: "bash", toolCallId: "1", input, isError: false, output: { text: "ok", truncated: false } },
    begin, thinking(2_000, "Planning the next step"));
  expect(s.work?.intent).toBe("Fixing the port test");
  expect(s.work?.headline).toStartWith("Planning the next step · ");
});

test("no headline at /details quiet, with the setting off, or on a plain terminal; never in the transcript", () => {
  for (const options of [{ level: "quiet" as const }, { on: false }]) {
    const s = screen(options);
    s.send(begin, thinking(3_000, "Planning the port fix"));
    expect(s.work?.headline).toBeUndefined();
  }
  const plain = screen({ rich: false });
  plain.send(begin, thinking(3_000, "Planning the port fix"), { type: "assistant_text_delta", delta: "Done." }, { type: "message_end" });
  expect(plain.output.join("")).not.toContain("Planning the port fix");
  const rich = screen();
  rich.send(begin, thinking(3_000, "Planning the port fix"), { type: "assistant_text_delta", delta: "Done." }, { type: "message_end" });
  expect(rich.output.join("")).not.toContain("Planning the port fix");
});

test("on screen the headline takes the status row's words, after the intent, and Esc stops stays", async () => {
  const chunks: string[] = [];
  const surface = new TerminalSurface({ input: new PassThrough(), output: { write: (text: string) => { chunks.push(text); }, columns: 80, rows: 20 },
    color: false, onEOF: () => {} }, () => {}, () => {});
  try {
    surface.start();
    surface.setWork({ rows: [], status: "Reasoning · 3.0k chars · 12s", intent: "Fixing the port test", headline: "Planning the port fix · 12s" });
    expect(await waitUntil(() => /\S Fixing the port test · Planning the port fix · 12s · Esc stops/.test(Bun.stripANSI(chunks.join(""))), 5_000)).toBe(true);
    expect(Bun.stripANSI(chunks.join(""))).not.toContain("3.0k chars");
  } finally { surface.close(); }
});

test("--json never carries the headline: progress events are not part of the stream", () => {
  expect(new RuntimeEventMapper().map({ type: "assistant_progress", kind: "thinking", chars: 3_000, headline: "Planning the port fix" })).toEqual([]);
});

test("the steps pane logs the generic Reasoning line, never the headline", async () => {
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const shown: string[] = [];
    const pane: ActivityPane = { show: lines => { shown.push(...lines); }, log: () => {}, close: () => {} };
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
    const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 140, rows: 30, write() {} });
    const terminal = new InteractiveTerminal(input, writer, () => {}, () => {},
      { host: { tmux: true, tmuxPane: "%1", iterm: false }, openPane: () => pane, run: () => ({ status: 1, stdout: "" }) });
    try {
      terminal.start();
      terminal.setWork({ rows: ["• bash · npm test"], status: "Reasoning · 3.0k chars · 12s", headline: "Planning the port fix · 12s" });
      expect(shown.join("\n")).toContain("Reasoning · 3.0k chars");
      expect(shown.join("\n")).not.toContain("Planning the port fix");
    } finally { terminal.close(); input.destroy(); }
  });
});
