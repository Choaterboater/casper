import { PiRuntime } from "../../src/runtime/pi";
import type { RuntimeEvent } from "../../src/runtime/types";

const [cwd] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const runtime = new PiRuntime();
const events: RuntimeEvent[] = [];
/** What Casper's own tool was given after the repair. */
const picked: unknown[] = [];
try {
  const session = await runtime.start({ cwd, systemPromptAppend: "Casper tool repair fixture", tools: [{
    name: "pick", description: "Pick names.",
    inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"] },
    execute: async (args) => { picked.push(args.names); return { text: "PICKED" }; },
  }] });
  session.subscribe(event => events.push(event));
  await session.prompt("Fix the notes.");
  console.log("REPAIR_RESULT=" + JSON.stringify({ toolEnds: events.filter(event => event.type === "tool_end"), picked }));
} finally { await runtime.dispose(); }
