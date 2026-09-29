import { PiRuntime } from "../../src/runtime/pi";
import type { RuntimeEvent } from "../../src/runtime/types";

// A gate that refuses every tool, as a plan turn refuses all but reading: it must be asked for every tool.
const [cwd] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const runtime = new PiRuntime();
const events: RuntimeEvent[] = [];
const consulted: string[] = [];
try {
  const session = await runtime.start({
    cwd, tools: [],
    beforeToolGate: toolName => { consulted.push(toolName); return `blocked ${toolName}`; },
  });
  session.subscribe(event => { events.push(event); });
  await session.prompt("Read the notes.");
  console.log("GATE_RESULT=" + JSON.stringify({ consulted, toolEnds: events.filter(event => event.type === "tool_end") }));
} finally { await runtime.dispose(); }
