import { expect, test } from "bun:test";
import path from "node:path";
import { answer, calls, cleanUpAfterEach, fixture } from "./support/phase8-pi";
import { childTestLimit } from "./support/limits";

cleanUpAfterEach();

// An ACP box names the step that raised it (decision 85): the step is found by the model's id of the running tool call,
// so the questions the AI's writes and commands raise must run inside it.
test("The outside-write hook and the AI's bash run inside their tool call id", async () => {
  let step = 0;
  const f = await fixture(() => {
    if (step++ === 0) return calls([
      { name: "write", args: { path: path.join(path.dirname(f.project), "elsewhere", "out.txt"), content: "out\n" } },
      { name: "bash", args: { command: "printf ran" } },
    ]);
    return answer("Done");
  });
  const harness = path.join(f.agent, "tool-call-id.ts");
  await Bun.write(harness, `const { PiRuntime } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/runtime/pi.ts"))});
const { toolCallId } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/runtime/tool-reason.ts"))});
const runtime = new PiRuntime();
const started = {}, asked = [];
const shell = { keepEnv: [], wrap: async (command) => ({ command }),
  approve: async (command) => { asked.push({ hook: "approve", id: toolCallId() ?? null }); return undefined; },
  outsideWrite: async (absolute) => { asked.push({ hook: "outsideWrite", id: toolCallId() ?? null }); return undefined; },
  bundleWrite: async (absolute) => { asked.push({ hook: "bundleWrite", id: toolCallId() ?? null }); return undefined; } };
try {
  const session = await runtime.start({ cwd: process.cwd(), localModels: false, shell });
  session.subscribe(event => { if (event.type === "tool_start") started[event.toolName] = event.toolCallId; });
  await session.prompt("Write the note outside and print a word.");
  console.log("TOOL_CALL_IDS=" + JSON.stringify({ started, asked }));
} finally { await runtime.dispose(); }
`);
  const run = await f.run([harness]);
  expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
  const result: { started: Record<string, string>; asked: Array<{ hook: string; id: string | null }> } = JSON.parse(run.stdout.split("TOOL_CALL_IDS=")[1]!);
  expect(result.started).toEqual({ write: "call_0", bash: "call_1" });
  // Each question knows the step it belongs to: the write's two hooks, and the command's own question.
  expect([...result.asked].sort((a, b) => a.hook.localeCompare(b.hook))).toEqual([
    { hook: "approve", id: "call_1" },
    { hook: "bundleWrite", id: "call_0" },
    { hook: "outsideWrite", id: "call_0" },
  ]);
}, childTestLimit());
