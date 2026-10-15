import { PiRuntime } from "../../src/runtime/pi";
import type { CheckChange } from "../../src/runtime/check-changes";
import type { RuntimeEvent } from "../../src/runtime/types";

const [cwd, choice] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const runtime = new PiRuntime();
const asked: CheckChange[] = [], toolEnds: RuntimeEvent[] = [];
let commands = { test: "bun .casper/quick-test.ts" };
try {
  const session = await runtime.start({ cwd, tools: [], localModels: false,
    checkChanges: { commands: () => commands, ask: async (change) => { asked.push(change); return choice === "save" ? "save" : choice === "session" ? "session" : undefined; },
      useSessionCommands: (next) => { commands = { ...commands, ...next }; } },
  });
  session.subscribe((event) => { if (event.type === "tool_end") toolEnds.push(event); });
  await session.prompt("Make the requested check change.");
  console.log("CHECK_CHANGES=" + JSON.stringify({ asked, commands, toolEnds }));
} finally { await runtime.dispose(); }
