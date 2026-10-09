import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { CANT_ASK_AI } from "../src/app/security-review";
import { receiptEvent } from "../src/app/json-events";
import { SECURITY_REVIEW_LIMITS, SubagentManager } from "../src/agents/manager";
import { loadProjectContext } from "../src/project/context";
import { MODEL_FINDING_LABEL } from "../src/security/review";
import { SkillRegistry } from "../src/skills/registry";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener, RuntimeReadOnlyStartOptions, RuntimeSession, RuntimeStartOptions } from "../src/runtime/types";
import { fakeTools, fixtureRepo, gitIn } from "./fixtures/security-tools/setup";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const ANSWER = "```json\n[{\"file\": \"app/extra.py\", \"line\": 4, \"input\": \"cmd = \\\"ls; id\\\"\", \"why\": \"cmd goes into a shell command.\"}]\n```";

/** A read-only child that answers once, reporting usage like a provider does. */
class ReviewChild implements AgentRuntime {
  static started: RuntimeReadOnlyStartOptions[] = [];
  static prompts: string[] = [];
  async start(): Promise<RuntimeSession> { throw new Error("the review must never start a full session"); }
  async startReadOnly(options: RuntimeReadOnlyStartOptions): Promise<RuntimeSession> {
    ReviewChild.started.push(options);
    const listeners = new Set<RuntimeEventListener>();
    const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
    return {
      prompt: async (text) => {
        ReviewChild.prompts.push(text);
        emit({ type: "assistant_response_start" });
        emit({ type: "assistant_text_delta", delta: ANSWER });
        emit({ type: "assistant_response_end", stopReason: "stop", usage: { tokens: 4_321, estimatedCost: 0.0123 } });
      },
      abort: async () => {}, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

/** The main session: signed in, with a review model the catalog prices. It never takes a prompt here. */
class Parent implements AgentRuntime {
  starts = 0;
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.starts++;
    return {
      prompt: async () => { throw new Error("no prompt to the main session"); }, abort: async () => {},
      subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
      getStatus: () => ({ auth: "configured", provider: "fixture", model: "main" }),
      getModelRoles: () => ({ review: "fixture/reviewer" }),
      describeModel: (query) => query === "fixture/reviewer" ? { provider: "fixture", id: "reviewer", inputCostPerMillion: 3 } : undefined,
    };
  }
  async dispose() {}
}

async function setup() {
  const root = await fixtureRepo("casper-ai-app-");
  cleanup.push(() => removeTempDir(root));
  gitIn(root, "checkout", "-qb", "feature");
  await writeFile(path.join(root, "app", "extra.py"), "import subprocess\n\ndef run(cmd):\n    return subprocess.check_output(cmd, shell=True)\n");
  gitIn(root, "add", "-A"); gitIn(root, "commit", "-qm", "extra");
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-ai-app-home-"));
  cleanup.push(() => removeTempDir(home));
  const tools = await fakeTools(home);
  let output = "";
  const parent = new Parent();
  let children = 0;
  const app = new CasperApp({
    runtimeFactory: () => parent, subagentRuntimeFactory: () => { children++; return new ReviewChild(); }, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    securitySeams: { check: { find: tools.find } },
    output: { write(text: string) { output += text; } },
  });
  cleanup.push(() => app.close());
  return { app, root, parent, output: () => output, children: () => children };
}

test("a one-shot /security-review never starts the model or the AI review", async () => {
  ReviewChild.started = [];
  const f = await setup();
  await f.app.runOnce("/security-review", f.root);
  expect(f.output()).toContain(CANT_ASK_AI);
  expect(f.parent.starts).toBe(0);
  expect(f.children()).toBe(0);
});

test("casper \"/security-review ai\" runs one read-only review child on the review model, with the review's own bounds and read gate", async () => {
  ReviewChild.started = []; ReviewChild.prompts = [];
  const f = await setup();
  await f.app.runOnce("/security-review ai", f.root);
  expect(f.children()).toBe(1);
  const options = ReviewChild.started[0]!;
  expect(options).toMatchObject({ modelRole: "review", maxTurns: SECURITY_REVIEW_LIMITS.maxTurns, maxToolCalls: SECURITY_REVIEW_LIMITS.maxToolCalls, reportTurn: true });
  expect(options.beforeToolGate?.("read", { path: ".env" })).toMatch(/^Not read: \.env may hold secrets/);
  // The full scrubber: a .env read reaches the review with its values hidden.
  const scrubbed = await options.scrubToolOutput!("read", { path: ".env" }, ["MIST_APITOKEN=abc123-live\n"]);
  expect(scrubbed?.texts[0]).not.toContain("abc123-live");
  expect(ReviewChild.prompts[0]).toContain("- app/extra.py");
  const out = f.output();
  expect(out).toContain("It runs on fixture/reviewer (your review model): at least about");
  expect(out).toContain("Running it because you asked with /security-review ai.");
  expect(out).toContain(`app/extra.py:4  cmd goes into a shell command. Example input: cmd = "ls; id"  ${MODEL_FINDING_LABEL}`);
  expect(out).toContain("The AI review used about 4.3k tokens (≈ $0.01, the catalog's estimate).");
  // --json: the receipt carries what the review spent, never "no usage".
  expect(f.app.getLastTaskResult()).toBeUndefined();
  expect(receiptEvent(undefined, undefined, 0, undefined, f.app.commandUsage()).usage).toEqual({ turns: 1, tokens: 4_321, estimatedCost: 0.0123 });
  // The next command starts from nothing spent.
  await f.app.runOnce("/security-review", f.root);
  expect(f.app.commandUsage()).toBeUndefined();
});

test("the security review's bounds can be tightened by tests, never relaxed", () => {
  expect(() => new SubagentManager({ runtimeFactory: () => new ReviewChild(), reviewTimeoutMs: SECURITY_REVIEW_LIMITS.timeoutMs + 1 })).toThrow("Invalid subagent deadline");
  expect(SECURITY_REVIEW_LIMITS).toMatchObject({ maxTurns: 30, maxToolCalls: 120, timeoutMs: 600_000 });
});
