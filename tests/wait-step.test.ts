import { afterAll, expect, spyOn, test } from "bun:test";
import { RuntimeEventView } from "../src/app/events";
import { plainSteps } from "../src/app/plain-steps";
import { waitPurpose, waitSeconds, waitWords } from "../src/app/wait-step";
import type { RuntimeEvent } from "../src/runtime/types";
import type { WorkView } from "../src/tui/surface";
import type { InteractiveTerminal } from "../src/tui/terminal";

/** From a live session: a wait step showed only "Running sleep 90 +1 more · 13s", never what it waited for. */

let clock = 1_000;
const spy = spyOn(performance, "now").mockImplementation(() => clock);
afterAll(() => spy.mockRestore());

const POLL = "sleep 90; ssh nas 'tail -5 /tmp/app-build.log'";

test("a wait says how long and, from the step's own words, what comes after it", () => {
  expect(waitSeconds(POLL)).toBe(90);
  expect(waitSeconds("sleep 300 && tail compare.out")).toBe(300);
  expect(waitSeconds("sleep 2m; tail x")).toBe(120);
  expect(waitSeconds("sleep 5; tail x")).toBeUndefined();
  expect(waitSeconds("npm test")).toBeUndefined();
  expect(waitSeconds("echo sleep 90")).toBeUndefined();
  expect(waitPurpose("Check the app build log")).toBe("checking the app build log");
  expect(waitPurpose("Wait for the build, then read its log")).toBe("reading its log");
  expect(waitPurpose(undefined, "Waiting for the build, then checking the log")).toBe("checking the log");
  expect(waitPurpose(undefined, "Radio stats can take a few minutes to catch up, so I'll check again in 2 minutes")).toBe("checking again");
  expect(waitPurpose("Wait 90 seconds")).toBeUndefined();
  expect(waitPurpose(undefined, "The build looks slow")).toBeUndefined();
  expect(waitWords(90, "checking the app build log")).toBe("Waiting 90 s, then checking the app build log");
  expect(waitWords(300)).toBe("Waiting 5 min");
});

test("a running wait step reads 'Waiting 90 s, then …' in the steps, and plain 'Waiting 90 s' with no words", () => {
  const step = { toolName: "bash", kind: "command" as const, input: { command: POLL }, startedAt: 0, line: "" };
  expect(plainSteps([{ ...step, description: "Check the app build log" }], 13_000)).toEqual(["• Waiting 90 s, then checking the app build log · 13s"]);
  expect(plainSteps([step], 13_000, { intent: "Waiting for the build, then checking the log" })).toEqual(["• Waiting 90 s, then checking the log · 13s"]);
  expect(plainSteps([step], 13_000)).toEqual(["• Waiting 90 s · 13s"]);
});

function view() {
  let work: WorkView | undefined;
  const terminal = { rich: true, columns: 120, questionsShown: 0, questionOpen: false, endAssistant() {}, assistant() {},
    setWork(next?: WorkView) { work = next; }, write() {}, writeFold() {} };
  const events = new RuntimeEventView(terminal as unknown as InteractiveTerminal, { write() {} }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false, projectRoot: () => "/work/app" });
  return { events, get work() { return work; }, handle: (...list: RuntimeEvent[]) => { for (const event of list) events.handle(event); } };
}

test("the status row says what the wait is for, from the AI's words before it", () => {
  clock = 1_000;
  const s = view();
  s.handle({ type: "assistant_text_delta", delta: "Waiting for the build, then checking the log." },
    { type: "tool_start", toolName: "bash", toolCallId: "1", input: { command: POLL } });
  clock += 13_000;
  s.handle({ type: "tool_progress", toolName: "bash", toolCallId: "1", text: "" });
  expect(s.work?.status).toBe("Waiting 90 s, then checking the log · 13s");
  // The words are the wait's own line now, so they don't lead the row a second time.
  expect(s.work?.intent).toBeUndefined();
  expect(s.work?.plain).toEqual(["• Waiting 90 s, then checking the log · 13s"]);
  s.events.reset();
  const titled = view();
  titled.handle({ type: "tool_start", toolName: "bash", toolCallId: "2", input: { command: POLL }, description: "Check the app build log" });
  expect(titled.work?.status).toBe("Waiting 90 s, then checking the app build log · 0s");
  titled.events.reset();
});
