import { PiRuntime } from "../../src/runtime/pi";
import type { RuntimeEvent } from "../../src/runtime/types";

const [cwd] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const runtime = new PiRuntime();
const events: RuntimeEvent[] = [];
/** Every call the spend pause saw: a skipped repeat must still reach it. */
const waits: string[] = [];
try {
  const session = await runtime.start({ cwd, tools: [], systemPromptAppend: "Casper loop guard fixture",
    beforeToolWait: async (toolName) => { waits.push(toolName); return undefined; } });
  session.subscribe(event => events.push(event));
  await session.prompt("Read the notes.");
  console.log("LOOP_RESULT=" + JSON.stringify({ toolEnds: events.filter(event => event.type === "tool_end"), waits }));
} finally { await runtime.dispose(); }
