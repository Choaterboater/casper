import { afterAll, expect, spyOn, test } from "bun:test";
import { judgeReasonFor, judgeStatusLine, noteJudgeAllowed } from "../src/app/auto-mode";
import { RuntimeEventView } from "../src/app/events";
import { judgeCommand } from "../src/sandbox/judge";
import type { RuntimeEvent } from "../src/runtime/types";
import { withEnv } from "./support/env";
import { interactiveTerminal } from "./support/tty";

/** From a live session: a curl step's box showed `1564742851189809272\_0.webp` where the command printed
 * `1564742851189809272_0.webp`. What a command prints is shown exactly as printed, never with Markdown escapes. The
 * backslash came from the one model-written line in that box: auto mode's judge, which escapes Markdown in its reason. */

let clock = 1_000;
const spy = spyOn(performance, "now").mockImplementation(() => clock);
afterAll(() => spy.mockRestore());

const FILE = "1564742851189809272_0.webp";

async function screen(events: RuntimeEvent[], want: string, after?: (view: RuntimeEventView, f: ReturnType<typeof interactiveTerminal>) => void,
  judgeReason?: (command: string) => string | undefined): Promise<string> {
  let shown = "";
  await withEnv({ TERM: "xterm-256color", NO_COLOR: "1" }, async () => {
    const f = interactiveTerminal();
    f.screen.writer.columns = 120; f.screen.writer.rows = 45;
    try {
      f.terminal.start();
      const view = new RuntimeEventView(f.terminal, { write: text => f.terminal.write(text) }, {
        updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false, projectRoot: () => "/work/app",
        ...(judgeReason ? { judgeReason } : {}) });
      for (const event of events) { view.handle(event); clock += 100; }
      after?.(view, f);
      await f.screen.until(text => text.includes(want));
      shown = Bun.stripANSI(f.screen.output);
      view.reset();
    } finally { f.close(); }
  });
  return shown;
}

const words = (text: string): RuntimeEvent => ({ type: "assistant_text_delta", delta: text });

test("a failed command's box shows the file name exactly as printed", async () => {
  const shown = await screen([
    { type: "tool_start", toolName: "bash", toolCallId: "1", input: { command: "curl -s http://192.0.2.10:8000/photos/" } },
    { type: "tool_end", toolName: "bash", toolCallId: "1", input: { command: "curl -s http://192.0.2.10:8000/photos/" }, isError: true,
      output: { text: `photo 200 ${FILE}\n\n\nCommand timed out after 60 seconds`, truncated: false } },
    words("The request timed out."),
    { type: "message_end" },
  ], "timed out after 60");
  expect(shown).toContain(FILE);
  expect(shown).not.toContain("\\_");
});

test("Ctrl+T shows a finished command's output exactly as printed", async () => {
  let body = "";
  const shown = await screen([
    { type: "tool_start", toolName: "bash", toolCallId: "2", input: { command: "ssh nas python3 list.py" } },
    { type: "tool_end", toolName: "bash", toolCallId: "2", input: { command: "ssh nas python3 list.py" }, isError: false,
      output: { text: `sample photo: {'file': '${FILE}'}`, truncated: false } },
    words(`The newest photo is \`${FILE}\`.`),
    { type: "message_end" },
  ], "sample photo", (view, f) => {
    const step = view.lastStep()!;
    body = step.body;
    f.terminal.writePanel(step.title, step.body, { diff: step.diff });
  });
  expect(body).toBe(`sample photo: {'file': '${FILE}'}`);
  expect(shown).not.toContain("\\_");
});

test("the judge's reason above a command's output carries no Markdown escapes: Ctrl+T and /status show the name as printed", async () => {
  const command = `curl -s -o /dev/null -w "photo %{http_code}\\n" http://192.0.2.10:8000/photos/${FILE}`;
  // The judge model escaped the underscore, as Markdown would want.
  const judged = await judgeCommand({ complete: async () => ({ text: `{"verdict":"allow","reason":"checks that the photo ${FILE.replace("_", "\\\\_")} loads"}`, usage: null }),
    command, request: "check the photos load", steps: [], trusted: true });
  // Taken off as the answer is read (parseJudgeAnswer), so every place the reason shows gets the plain name.
  expect(judged.reason).not.toContain("\\_");
  const app = { judgeAllows: [] as Array<{ command: string; reason: string }> };
  noteJudgeAllowed(app as never, command, judged.reason);
  expect(judgeStatusLine(app as never)).toContain(`checks that the photo ${FILE} loads`);
  let body = "";
  const shown = await screen([
    { type: "tool_start", toolName: "bash", toolCallId: "3", input: { command } },
    { type: "tool_end", toolName: "bash", toolCallId: "3", input: { command }, isError: false, output: { text: `photo 200 ${FILE}`, truncated: false } },
    words("The photo loads."),
    { type: "message_end" },
  ], "photo 200", (view, f) => {
    const step = view.lastStep()!;
    body = step.body;
    f.terminal.writePanel(step.title, step.body, { diff: step.diff });
  }, line => judgeReasonFor(app as never, line));
  expect(body).toBe(`✓ judge: checks that the photo ${FILE} loads\nphoto 200 ${FILE}`);
  expect(shown).not.toContain("\\_");
});

test("the judge's reason never carries a Markdown escape, when it asks as when it allows", async () => {
  const { parseJudgeAnswer } = await import("../src/sandbox/judge");
  expect(parseJudgeAnswer('{"verdict":"ask","reason":"deletes photos/1564742851189809272\\\\_0.webp on the server"}')?.reason)
    .toBe("deletes photos/1564742851189809272_0.webp on the server");
});
