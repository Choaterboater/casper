import { PiRuntime } from "../../src/runtime/pi";
import type { RuntimeEvent } from "../../src/runtime/types";
import { Scrubber } from "../../src/secrets/netconan";
import { hiddenSecretGate } from "../../src/secrets/gate";
import { scrubToolOutput } from "../../src/secrets/tool-output";

// Wires the Pi hooks the way the app does: the hidden-secret gate and the tool output scrubber.
// FIXTURE_FILES_OFF=1 stands in for "/secrets files off" (device configs off; .env files stay hidden).
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
      : scrubToolOutput(scrubber, toolName, input, texts, signal, { configs: filesOn });
  // FIXTURE_READ_ONLY=1 starts a /delegate child the way SubagentManager does.
  const session = process.env.FIXTURE_READ_ONLY === "1"
    ? await runtime.startReadOnly({ cwd, signal: new AbortController().signal, maxTurns: 4, maxToolCalls: 4, scrubToolOutput: scrub })
    : await runtime.start({
      // A stand-in for Casper's service tool: its logs are command output too.
      cwd, tools: [{ name: "service", description: "Service logs", inputSchema: { type: "object", properties: { action: { type: "string" } } },
        execute: async () => ({ text: JSON.stringify({ service: "web", logs: "listening on 3000\nconnecting postgres://app:DbPassw0rd99@db/app\nAPI_TOKEN=tok-live-778899\n" }) }) }],
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
