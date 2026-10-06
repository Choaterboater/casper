import { PiRuntime } from "../../src/runtime/pi";
import type { RuntimeEvent } from "../../src/runtime/types";

/** A crew builder on the real Pi runtime: cwd, mode ("work" or "calls"). Prints BUILDER_RESULT=<json>. */
const [cwd, mode] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const runtime = new PiRuntime();
const controller = new AbortController();
const events: RuntimeEvent[] = [];
try {
  const session = await runtime.startBuilder!({
    cwd, signal: controller.signal,
    maxTurns: 6, maxToolCalls: mode === "calls" ? 2 : 12,
    systemPromptAppend: "Casper builder acceptance fixture",
    beforeToolGate: (name, input) => name === "write" && String(input?.path).includes("outside") ? "Not done: outside the copy." : undefined,
  });
  session.subscribe((event) => { events.push(event); });
  let replaceBlocked = false;
  try { session.setTools?.([]); } catch { replaceBlocked = true; }
  await session.prompt("Make the change.").catch(() => {});
  console.log("BUILDER_RESULT=" + JSON.stringify({ events, replaceBlocked }));
} finally { await runtime.dispose(); }
