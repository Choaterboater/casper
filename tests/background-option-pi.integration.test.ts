import { expect, test } from "bun:test";
import path from "node:path";
import type { RuntimeEvent } from "../src/runtime/types";
import { answer, calls, cleanUpAfterEach, fixture } from "./support/phase8-pi";
import { childTestLimit } from "./support/limits";

cleanUpAfterEach();

test.skipIf(process.platform === "win32")("real Pi offers the shell a background option; a call that sets it starts in Casper's background commands at once", async () => {
  let step = 0;
  const f = await fixture(() => {
    if (step++ === 0) return calls([{ name: "bash", args: { command: "echo comparison started; sleep 40; echo comparison done", background: true } }]);
    return answer("Started");
  });
  const harness = path.join(f.agent, "background-view.ts");
  await Bun.write(harness, `const { PiRuntime } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/runtime/pi.ts"))});
const { BackgroundCommands } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/runtime/background-commands.ts"))});
const commands = new BackgroundCommands({ notify: () => {} });
const runtime = new PiRuntime();
const events = [];
try {
  const session = await runtime.start({ cwd: process.cwd(), localModels: false, shell: { wrap: async (command) => ({ command }), background: () => commands } });
  session.subscribe(event => { events.push(event); });
  await session.prompt('Start the comparison.');
  console.log('BACKGROUND_VIEW=' + JSON.stringify({ events, running: commands.list().map(entry => entry.id) }));
} finally { await commands.close(); await runtime.dispose(); }
`);
  const run = await f.run([harness]);
  expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
  const result: { events: RuntimeEvent[]; running: string[] } = JSON.parse(run.stdout.split("BACKGROUND_VIEW=")[1]!);
  const bash = (f.payloads[0]!.tools as Array<{ function: { name: string; parameters: { properties: Record<string, { type?: string; description?: string }>; required?: string[] } } }>)
    .find(tool => tool.function.name === "bash")!.function.parameters;
  expect(bash.properties.background?.type).toBe("boolean");
  expect(bash.properties.background?.description).toContain("Not &, nohup, setsid or tmux");
  expect(bash.required ?? []).not.toContain("background");
  const end = result.events.find((event): event is Extract<RuntimeEvent, { type: "tool_end" }> => event.type === "tool_end" && event.toolName === "bash")!;
  expect(end.isError).toBe(false);
  expect(end.output?.text).toContain("comparison started");
  expect(end.output?.text).toContain("As asked (background: true), after 3 s it moved to the background as cmd-1");
  expect(end.output?.text).not.toContain("comparison done");
  // The turn ended while the job still ran: it went on without waiting for it.
  expect(result.running).toEqual(["cmd-1"]);
}, childTestLimit());
