import { signedBundle } from "../../src/platform/bundles";
import { PiRuntime } from "../../src/runtime/pi";
import type { RuntimeEvent } from "../../src/runtime/types";
import { Scrubber } from "../../src/secrets/netconan";
import { hiddenSecretGate } from "../../src/secrets/gate";
import { scrubToolOutput } from "../../src/secrets/tool-output";
import { dropDeniedGrepLines, reviewReadGate } from "../../src/security/review";
import type { SecurityFinding } from "../../src/security/types";

// Wires the Pi hooks the way the app does: the hidden-secret gate and the tool output scrubber.
// FIXTURE_FILES_OFF=1 stands in for "/secrets files off" (device configs off; .env files stay hidden).
const [cwd] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const runtime = new PiRuntime();
const events: RuntimeEvent[] = [];
const scrubber = new Scrubber({ env: { CASPER_NETCONAN: "off" } });
const filesOn = process.env.FIXTURE_FILES_OFF !== "1";
// FIXTURE_OUTSIDE=allow|no stands in for the session's write question about places outside the project.
const outside = process.env.FIXTURE_OUTSIDE;
const outsideAsked: string[] = [];
const outsideWrote: string[] = [];
const outsideRecorded: string[] = [];
// FIXTURE_PRIVATE=yes|no stands in for the box a command naming a private place gets with the sandbox off (decision 95).
// FIXTURE_SANDBOX_ON=1: the sandbox on, which hides those places from commands; the file tools still ask.
const privateAnswer = process.env.FIXTURE_PRIVATE;
const privateAsked: string[] = [];
const shell = outside || privateAnswer ? { wrap: async (command: string) => ({ command }), keepEnv: [],
  ...(privateAnswer ? { asksPrivate: () => process.env.FIXTURE_SANDBOX_ON !== "1", asksPrivateFile: () => true, askPrivate: async (command: string, place: { shown: string }) => {
    privateAsked.push(`${place.shown}: ${command}`);
    return privateAnswer === "no" ? `Not run: the user said no to reading ${place.shown}.` : undefined;
  } } : {}),
  // `asked`: the private box already said yes, so nothing is asked; the write is only recorded.
  outsideWrite: async (absolute: string, options?: { asked?: boolean }) => {
    if (options?.asked) { outsideRecorded.push(absolute); return undefined; }
    outsideAsked.push(absolute); return outside === "no" ? "Not done: the user said no to writing it. Don't retry it or work around it." : undefined;
  },
  wroteOutside: (absolute: string) => { outsideWrote.push(absolute); },
  // The same answer for a write inside an app bundle (src/platform/bundles.ts).
  bundleWrite: async (absolute: string) => { const bundle = signedBundle(absolute); if (!bundle) return undefined; bundleAsked.push(absolute);
    return outside === "no" ? "Not done: it is inside an app bundle, and the user said no." : undefined; } } : undefined;
const bundleAsked: string[] = [];
try {
  // FIXTURE_SCRUB_THROW=1 makes the check itself fail.
  const scrub = (toolName: string, input: Record<string, unknown>, texts: string[], signal?: AbortSignal) =>
    process.env.FIXTURE_SCRUB_THROW === "1" ? Promise.reject(new Error("scrubber broke"))
      : scrubToolOutput(scrubber, toolName, input, texts, signal, { configs: filesOn });
  // FIXTURE_REVIEW=1 starts the /security-review AI review's child the way the app does: its read gate, and grep
  // lines from files it may not read dropped before the scrubber. gitleaks "flagged" src/settings.py.
  const flagged: SecurityFinding[] = [{ tool: "gitleaks", file: "src/settings.py", line: 1, rule: "generic-api-key", severity: "high", text: "looks like a secret" }];
  const review = process.env.FIXTURE_REVIEW === "1";
  // FIXTURE_READ_ONLY=1 starts a /delegate child the way SubagentManager does.
  const session = review
    ? await runtime.startReadOnly({ cwd, signal: new AbortController().signal, maxTurns: 4, maxToolCalls: 8,
      beforeToolGate: reviewReadGate(cwd, flagged),
      scrubToolOutput: (toolName, input, texts, signal) => {
        const kept = toolName === "grep" ? dropDeniedGrepLines(cwd, flagged, input, texts) : texts;
        return scrub(toolName, input, kept, signal).then((result) => result ?? (kept === texts ? undefined : { texts: kept }));
      } })
    : process.env.FIXTURE_READ_ONLY === "1"
    ? await runtime.startReadOnly({ cwd, signal: new AbortController().signal, maxTurns: 4, maxToolCalls: 4, scrubToolOutput: scrub,
      ...(shell?.askPrivate ? { privateAsk: shell } : {}) })
    : await runtime.start({
      // A stand-in for Casper's service tool: its logs are command output too.
      cwd, tools: [{ name: "service", description: "Service logs", inputSchema: { type: "object", properties: { action: { type: "string" } } },
        execute: async () => ({ text: JSON.stringify({ service: "web", logs: "listening on 3000\nconnecting postgres://app:DbPassw0rd99@db/app\nAPI_TOKEN=tok-live-778899\n" }) }) }],
      systemPromptAppend: "Casper secret scrub fixture",
      beforeToolGate: (toolName, input) => hiddenSecretGate(toolName, input),
      scrubToolOutput: scrub,
      ...(shell ? { shell } : {}),
    });
  session.subscribe(event => { events.push(event); });
  let promptError: string | undefined;
  try { await session.prompt("Read the files."); } catch (error) { promptError = String(error); }
  console.log("SCRUB_RESULT=" + JSON.stringify({
    toolEnds: events.filter(event => event.type === "tool_end"),
    ...(outside ? { outsideAsked, outsideWrote, outsideRecorded, bundleAsked } : {}),
    ...(privateAnswer ? { privateAsked } : {}),
    ...(promptError ? { promptError } : {}),
  }));
} finally { await runtime.dispose(); }
