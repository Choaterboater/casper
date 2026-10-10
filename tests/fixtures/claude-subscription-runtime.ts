// Real Casper runtime with a synthetic native Claude CLI: no account or network.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PiRuntime } from "../../src/runtime/pi";
import type { RuntimeEvent } from "../../src/runtime/types";

const runtime = new PiRuntime();
const events: RuntimeEvent[] = [];
let gateOpen = false;
let approvals = 0;
let wraps = 0;
try {
  const session = await runtime.start({ cwd: process.cwd(), localModels: false,
    privatePaths: [path.join(process.cwd(), "private")],
    beforeToolGate: name => name === "write" && !gateOpen ? "fixture approval required" : undefined,
    shell: {
      approve: async () => { approvals++; return "fixture shell refused"; },
      wrap: async command => { wraps++; return { command }; },
    },
  });
  session.subscribe(event => {
    events.push(event);
    if (event.type === "tool_end" && event.toolName === "write" && event.isError) gateOpen = true;
  });
  await session.selectModel!({ query: "claude-subscription/claude-opus-4-8", persist: false });
  await session.prompt("SUBSCRIPTION_TOOL_FIXTURE", undefined, { request: "SUBSCRIPTION_TOOL_FIXTURE", maxTurns: 8 });
  const info = session.getSessionInfo!();
  const saved = await readFile(info.sessionFile!, "utf8");
  const turns = session.recentTurns!(4);
  // Enough visible history to cross Pi's unchanged 20k recent-token retention boundary.
  await session.appendContext!("COMPACTION_FIXTURE ".repeat(8_000));
  await session.prompt("Finish the compaction fixture.");
  await session.compact!("Keep the fixture evidence.");
  const compacted = await readFile(info.sessionFile!, "utf8");
  console.log(JSON.stringify({ approvals, wraps, ends: events.filter(event => event.type === "tool_end"), saved, compacted, turns }));
} finally { await runtime.dispose(); }
