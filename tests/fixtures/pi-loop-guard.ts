import { PiRuntime } from "../../src/runtime/pi";
import type { RuntimeEvent } from "../../src/runtime/types";

const [cwd, mode] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const runtime = new PiRuntime();
const events: RuntimeEvent[] = [];
/** Every call the spend pause saw: a skipped repeat must still reach it. */
const waits: string[] = [];
/** "refuse": every shell command is refused as a run that can't ask refuses it; how often it was asked is kept. */
const approvals: string[] = [];
const shell = mode === "refuse" ? { approve: async (command: string) => { approvals.push(command); return "Not run: shell commands need your OK here, and this run can't ask."; },
  wrap: async (command: string) => ({ command }) } as unknown as Parameters<typeof runtime.start>[0]["shell"] : undefined;
try {
  const session = await runtime.start({ cwd, tools: [], systemPromptAppend: "Casper loop guard fixture", ...(shell ? { shell } : {}),
    beforeToolWait: async (toolName) => { waits.push(toolName); return undefined; } });
  session.subscribe(event => events.push(event));
  await session.prompt("Read the notes.");
  console.log("LOOP_RESULT=" + JSON.stringify({ toolEnds: events.filter(event => event.type === "tool_end"), waits, approvals }));
} finally { await runtime.dispose(); }
