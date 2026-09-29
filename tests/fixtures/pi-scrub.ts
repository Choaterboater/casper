import { PiRuntime } from "../../src/runtime/pi";
import type { RuntimeEvent } from "../../src/runtime/types";
import { Scrubber } from "../../src/secrets/netconan";
import { hiddenSecretGate } from "../../src/secrets/gate";
import { scrubToolOutput } from "../../src/secrets/tool-output";

// Wires the Pi hooks the way the app does: the hidden-secret gate and the tool output scrubber.
// FIXTURE_FILES_OFF=1 stands in for "/secrets files off".
const [cwd] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const runtime = new PiRuntime();
const events: RuntimeEvent[] = [];
const scrubber = new Scrubber({ env: { CASPER_NETCONAN: "off" } });
const filesOn = process.env.FIXTURE_FILES_OFF !== "1";
try {
  // FIXTURE_SCRUB_THROW=1 makes the check itself fail.
  const scrub = (toolName: string, input: Record<string, unknown>, texts: string[], signal?: AbortSignal) =>
    process.env.FIXTURE_SCRUB_THROW === "1" ? Promise.reject(new Error("scrubber broke"))
      : filesOn ? scrubToolOutput(scrubber, toolName, input, texts, signal) : Promise.resolve(undefined);
  // FIXTURE_READ_ONLY=1 starts a /delegate child the way SubagentManager does.
  const session = process.env.FIXTURE_READ_ONLY === "1"
    ? await runtime.startReadOnly({ cwd, signal: new AbortController().signal, maxTurns: 4, maxToolCalls: 4, scrubToolOutput: scrub })
    : await runtime.start({
      cwd, tools: [],
      systemPromptAppend: "Casper secret scrub fixture",
      beforeToolGate: (toolName, input) => hiddenSecretGate(toolName, input),
      scrubToolOutput: scrub,
    });
  session.subscribe(event => { events.push(event); });
  let promptError: string | undefined;
  try { await session.prompt("Read the files."); } catch (error) { promptError = String(error); }
  console.log("SCRUB_RESULT=" + JSON.stringify({
    toolEnds: events.filter(event => event.type === "tool_end"),
    ...(promptError ? { promptError } : {}),
  }));
} finally { await runtime.dispose(); }
