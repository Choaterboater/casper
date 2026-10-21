import { expect, test } from "bun:test";
import path from "node:path";
import type { RuntimeEvent } from "../src/runtime/types";
import { answer, calls, cleanUpAfterEach, fixture } from "./support/phase8-pi";
import { childTestLimit } from "./support/limits";

cleanUpAfterEach();

test("real Pi offers the shell an optional step title; it shows with the real command and never changes what is allowed", async () => {
  let step = 0;
  const f = await fixture(() => {
    if (step++ === 0) return calls([
      { name: "bash", args: { command: "printf step-title-ok", description: "Print the check word" } },
      // A harmless title on a command Casper refuses: the command decides, the title only shows with it.
      { name: "bash", args: { command: "cat ~/.ssh/config", description: "Read the readme" } },
    ]);
    return answer("Done");
  });
  const harness = path.join(f.agent, "title-view.ts");
  await Bun.write(harness, `const { PiRuntime } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/runtime/pi.ts"))});
import { RuntimeEventView } from ${JSON.stringify(path.join(import.meta.dir, "../src/app/events.ts"))};
import { renderFold } from ${JSON.stringify(path.join(import.meta.dir, "../src/tui/terminal.ts"))};
const runtime = new PiRuntime();
const events = [], live = [], folded = [], plain = [];
const views = [true, false].map(rich => new RuntimeEventView({
  rich, columns: 120, questionsShown: 0, questionOpen: false, endAssistant() {}, assistant() {},
  setWork(work) { if (rich && work) live.push(...work.rows, ...(work.plain ?? [])); },
  writeFold(fold) { folded.push(...renderFold(fold, 120, false, false)); },
}, { write(text) { if (!rich) plain.push(text); } }, {
  updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
}));
try {
  const session = await runtime.start({ cwd: process.cwd(), localModels: false });
  session.subscribe(event => { events.push(event); for (const view of views) view.handle(event); });
  await session.prompt('Print the check word.');
  console.log('TITLE_VIEW=' + JSON.stringify({ events, live, folded, plain }));
} finally { for (const view of views) view.reset(); await runtime.dispose(); }
`);
  const run = await f.run([harness]);
  expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
  const result: { events: RuntimeEvent[]; live: string[]; folded: string[]; plain: string[] } = JSON.parse(run.stdout.split("TITLE_VIEW=")[1]!);
  // The model is offered the title, optional, on the shell tool.
  const bash = (f.payloads[0]!.tools as Array<{ function: { name: string; parameters: { properties: Record<string, { type?: string }>; required?: string[] } } }>)
    .find(tool => tool.function.name === "bash")!.function.parameters;
  expect(bash.properties.description?.type).toBe("string");
  expect(bash.required ?? []).not.toContain("description");
  const ends = result.events.filter((event): event is Extract<RuntimeEvent, { type: "tool_end" }> => event.type === "tool_end");
  const printed = ends.find(event => event.input?.command === "printf step-title-ok")!;
  expect(printed).toMatchObject({ isError: false, description: "Print the check word", input: { command: "printf step-title-ok" } });
  expect(printed.output?.text).toContain("step-title-ok");
  // The title is never part of the observed input (receipts, /output, --json targets).
  expect(Object.keys(printed.input ?? {})).not.toContain("description");
  const refused = ends.find(event => event.input?.command === "cat ~/.ssh/config")!;
  expect(refused).toMatchObject({ isError: true, description: "Read the readme" });
  expect(refused.output?.text).toStartWith("Not run:");
  expect(result.live.join("\n")).toContain("Print the check word · printf step-title-ok");
  expect(result.plain.join("")).toContain("✓ Print the check word · printf step-title-ok");
  for (const rows of [result.folded, result.plain]) expect(rows.join("\n")).toContain("– Read the readme · cat ~/.ssh/config — not run");
  expect(result.folded.join("\n")).toContain("Printed the check word");
}, childTestLimit());
