import { PiRuntime } from "../../src/runtime/pi";
import type { RuntimeEvent } from "../../src/runtime/types";

const [cwd] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const runtime = new PiRuntime();
const events: RuntimeEvent[] = [];
// Models the app's beforeChanges gate: closed until a recorded ask attempt opens it.
let gateOpen = false;
let gateConsults = 0;
try {
  const session = await runtime.start({
    cwd, tools: [],
    systemPromptAppend: "Casper beforeChanges gate fixture",
    beforeToolGate: toolName => {
      gateConsults++;
      return gateOpen ? undefined : `ask before ${toolName}`;
    },
  });
  session.subscribe(event => {
    events.push(event);
    // A recorded ask (answered or skipped) opens the gate in the app; the fixture
    // stands in for that receipt by opening on the first blocked tool result.
    if (event.type === "tool_end" && event.isError) gateOpen = true;
  });
  let promptError: string | undefined;
  try { await session.prompt("Create the marker file."); } catch (error) { promptError = String(error); }
  console.log("GATE_RESULT=" + JSON.stringify({
    gateConsults,
    toolEnds: events.filter(event => event.type === "tool_end"),
    ...(promptError ? { promptError } : {}),
  }));
} finally { await runtime.dispose(); }
