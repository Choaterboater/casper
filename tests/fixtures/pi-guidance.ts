import { PiRuntime } from "../../src/runtime/pi";
import { DEFAULT_SYSTEM_PROMPT_APPEND, LEAN_SYSTEM_PROMPT_APPEND } from "../../src/app/prompt";
import type { GuidanceSetting } from "../../src/runtime/guidance";

const [cwd] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const runtime = new PiRuntime();
let guidance: GuidanceSetting = "auto";
let ran = 0;
try {
  const session = await runtime.start({ cwd, systemPromptAppend: DEFAULT_SYSTEM_PROMPT_APPEND + "\nUSER_RULE",
    leanSystemPromptAppend: LEAN_SYSTEM_PROMPT_APPEND + "\nUSER_RULE", guidance: () => guidance,
    tools: [{ name: "casper_session", description: "Casper's state now: model, effort, roles, usage and cost, context, last task, background tasks, MCP servers. Read-only, free.",
      inputSchema: { type: "object", additionalProperties: false, properties: { part: { type: "string" } } }, sequential: true,
      execute: async () => { ran++; return { text: "GUIDANCE_TOOL_RAN" }; } }] });
  await session.prompt("Read the state tool, then answer.");
  guidance = "off";
  await session.prompt("Answer with full guidance.");
  guidance = "auto";
  await session.clearConversation!();
  await session.prompt("Answer after rebind.");
  console.log("GUIDANCE_RESULT=" + JSON.stringify({ ran }));
} finally { await runtime.dispose(); }
