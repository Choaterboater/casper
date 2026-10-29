/** Real-terminal fixture: no provider, network or device calls. */
import { CasperApp } from "../../src/app";
import { folderTrustDefaults } from "../../src/project/trust";
import { loadProjectContext } from "../../src/project/context";
import { SkillRegistry } from "../../src/skills/registry";
import type { AgentRuntime, RuntimeEventListener } from "../../src/runtime/types";

const root = process.argv[2]!, home = process.argv[3]!;
const listeners = new Set<RuntimeEventListener>();
const runtime: AgentRuntime = {
  start: async () => ({
    getStatus: () => ({ provider: "fixture", model: "terminal", auth: "configured" }),
    getState: () => ({ cwd: root, isStreaming: false }), setTools() {}, abort: async () => {},
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    prompt: async text => {
      const changed = text.includes("User's change:");
      const answer = `Title: ${changed ? "A revised header" : "A cleaner, animated header"}\n\nGoal:\nThe ghost and name in one colour, with a short fade-in.\n\nWhat I found:\n- The header lives in src/tui/banner.ts and is drawn once before the prompt, preserving the established fallback on plain terminals.\n- Plain terminals already get one line\n\nWhat you'll see:\nA brief fade-in reveals the new header:\n\`\`\`\n▄▄███▄▄  CASPER  (fades in)\n\`\`\`\n\nSteps:\n1. Write the three tests first — tests/banner.test.ts\n2. Draw the header in the accent colour — src/tui/banner.ts\n\nDone means:\n- Plain terminal has one line, rich header drawn once, fades in\n- typecheck and lint\n\nOpen questions:\n- Should the reduced-motion setting also disable the header animation on terminals that support colour and rich output?\n- The renderer already keeps a one-line fallback for plain terminals.\n\nDetails:\nUse the existing banner renderer.\n`;
      for (const event of [{ type: "assistant_response_start", provider: "fixture", model: "terminal" }, { type: "assistant_text_delta", delta: answer }, { type: "assistant_response_end", stopReason: "stop" }] as const) for (const listener of listeners) listener(event);
    },
  }), dispose: async () => {},
};
const app = new CasperApp({ input: process.stdin, output: process.stdout, runtimeFactory: () => runtime, sessionHomeDir: home,
  loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
  loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
  loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }), loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
  loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
});
// As in the test preload: the folder counts as one you trusted, so the screen opens with no "Trust this folder?" box.
folderTrustDefaults.lookup = async (info) => ({ trusted: true, from: info.root });
try { await app.runInteractive(root); } finally { await app.close(); }
