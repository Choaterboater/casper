import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { CasperApp } from "../src/app";
import { settleQueuedLines, steerOrQueue } from "../src/app/during-work";
import { queueTypedRequest } from "../src/app/workspace";
import { TerminalSurface } from "../src/tui/surface";

/** What was pasted into a draft stays with it: through a question, an edit box, and lines put back in the prompt. */
function makeSurface() {
  const input = new PassThrough();
  const surface = new TerminalSurface({
    input, output: { write: () => {}, columns: 100, rows: 30 }, color: false, onEOF: () => {},
  }, () => {}, () => {});
  surface.start();
  return { surface, input };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const block = "big model: this came from a log";

test("a pasted draft sitting in the prompt when an approval opens is still pasted after it", async () => {
  const { surface, input } = makeSurface();
  try {
    const line = surface.readCommand();
    input.write(`\x1b[200~${block}\x1b[201~`);
    await tick();
    const answer = surface.approve("Run it?\n", "Make this change?", [{ label: "No" }, { label: "Yes, this once" }]);
    input.write("1");
    expect(await answer).toBe("No");
    input.write("\r");
    expect(await line).toBe(block);
    expect(surface.takeSubmittedPastes()).toEqual([block]);
  } finally { surface.close(); }
});

test("a pasted draft set aside for an edit box comes back still pasted", async () => {
  const { surface, input } = makeSurface();
  try {
    const line = surface.readCommand();
    input.write(`\x1b[200~${block}\x1b[201~`);
    await tick();
    const edited = surface.editLines("Edit the plan", "Enter keeps it", ["step one"]);
    input.write("\r");
    expect(await edited).toEqual(["step one"]);
    input.write("\r");
    expect(await line).toBe(block);
    expect(surface.takeSubmittedPastes()).toEqual([block]);
  } finally { surface.close(); }
});

test("lines put back in the prompt keep what was pasted into them", async () => {
  const { surface, input } = makeSurface();
  try {
    const line = surface.readCommand();
    surface.restoreDraft(block, [block]);
    input.write("\r");
    expect(await line).toBe(block);
    expect(surface.takeSubmittedPastes()).toEqual([block]);
  } finally { surface.close(); }
});

function fakeApp(over: Partial<Record<string, unknown>> = {}) {
  const restored: Array<{ text: string; pasted: readonly string[] }> = [];
  const output: string[] = [];
  const app = {
    closing: false, commandActive: true, queuedLines: [] as string[], linePastes: new Map<string, readonly string[]>(),
    commandAbort: new AbortController(), session: undefined as unknown,
    terminal: {
      restoreDraft: (text: string, pasted: readonly string[] = []) => { restored.push({ text, pasted }); return true; },
      takeSubmittedPastes: () => [block],
    },
    output: { write: (text: string) => { output.push(text); } },
    ...over,
  };
  return { app: app as unknown as CasperApp & typeof app, restored, output };
}

test("Esc on a task: queued lines go back in the prompt with their pastes, and the record of them is cleared", () => {
  const { app, restored } = fakeApp();
  app.queuedLines.push("typed line", block);
  app.linePastes.set(block, [block]);
  app.linePastes.set("a line the AI already read", ["a line the AI already read"]);
  app.commandAbort.abort();
  settleQueuedLines(app);
  expect(restored).toEqual([{ text: `typed line\n${block}`, pasted: [block] }]);
  expect(app.linePastes.size).toBe(0);
});

test("after a task, the paste record of lines the AI read is cleared; queued lines keep theirs", () => {
  const { app } = fakeApp();
  app.queuedLines.push(block);
  app.linePastes.set(block, [block]);
  app.linePastes.set("read by the AI", ["read by the AI"]);
  settleQueuedLines(app);
  expect([...app.linePastes.keys()]).toEqual([block]);
});

test("a line typed as the task ends comes back with its pastes", async () => {
  const { app, restored } = fakeApp({ commandActive: false, session: { steer: async () => false } });
  app.linePastes.set(block, [block]);
  await steerOrQueue(app, block);
  expect(restored).toEqual([{ text: block, pasted: [block] }]);
  expect(app.linePastes.size).toBe(0);
});

test("a request pasted at the new-project question keeps its paste record", () => {
  const { app } = fakeApp();
  queueTypedRequest(app, block);
  expect(app.queuedPrompt).toBe(block);
  expect(app.linePastes.get(block)).toEqual([block]);
});
