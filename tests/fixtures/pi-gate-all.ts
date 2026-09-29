import { PiRuntime } from "../../src/runtime/pi";
import type { RuntimeEvent } from "../../src/runtime/types";

// A gate that refuses every tool, as a plan turn refuses all but reading: it must be asked for every tool.
const [cwd] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const runtime = new PiRuntime();
const events: RuntimeEvent[] = [];
const consulted: string[] = [];
const ran: string[] = [];
try {
  const session = await runtime.start({
    cwd,
    // One of Casper's own tools: it must meet the same gate as Pi's built-in tools.
    tools: [{ name: "casper_probe", description: "Probe tool", inputSchema: { type: "object", properties: {} },
      execute: async () => { ran.push("casper_probe"); return { text: "probe ran" }; } }],
    beforeToolGate: toolName => { consulted.push(toolName); return `blocked ${toolName}`; },
  });
  session.subscribe(event => { events.push(event); });
  await session.prompt("Read the notes.");
  console.log("GATE_RESULT=" + JSON.stringify({ consulted, ran, toolEnds: events.filter(event => event.type === "tool_end") }));
} finally { await runtime.dispose(); }
