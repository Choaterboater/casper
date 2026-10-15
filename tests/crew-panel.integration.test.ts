import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import type { AgentRuntime, RuntimeBuilderStartOptions, RuntimeEvent, RuntimeEventListener, RuntimeReadOnlyStartOptions, RuntimeSession } from "../src/runtime/types";

/** Actual manager lifecycle through the app hook, without a provider, shell command, or worktree. */
class Child implements AgentRuntime {
  readonly ready = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  async start(): Promise<RuntimeSession> { throw new Error("not a main runtime"); }
  private session(cwd: string): RuntimeSession {
    const listeners = new Set<RuntimeEventListener>();
    const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
    return {
      prompt: async () => {
        emit({ type: "assistant_response_start" });
        emit({ type: "tool_start", toolName: "read", toolCallId: "read-1" });
        this.ready.resolve();
        await this.release.promise;
        emit({ type: "tool_end", toolName: "read", toolCallId: "read-1", isError: false });
        emit({ type: "assistant_text_delta", delta: "No findings.\nCoverage is limited." });
        emit({ type: "assistant_response_end", stopReason: "stop", usage: { tokens: 1250, estimatedCost: 0 } });
      },
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      abort: async () => { this.release.resolve(); },
      getState: () => ({ cwd, isStreaming: false }),
    };
  }
  async startBuilder(options: RuntimeBuilderStartOptions): Promise<RuntimeSession> { return this.session(options.cwd); }
  async startReadOnly(options: RuntimeReadOnlyStartOptions): Promise<RuntimeSession> { return this.session(options.cwd); }
  async dispose() {}
}

for (const rich of [true, false]) test(`app lifecycle renders crew updates and retains only rich review outcomes (rich=${rich})`, async () => {
  const previousTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const input = Object.assign(new PassThrough(), { isTTY: rich });
  const written: string[] = [];
  const children: Child[] = [];
  const output = { write: (text: string) => { written.push(text); }, isTTY: rich, columns: 100, rows: 24 };
  const app = new CasperApp({ input, output,
    subagentRuntimeFactory: () => { const child = new Child(); children.push(child); return child; } });
  try {
    const builder = app.subagents.runBuilder({ cwd: process.cwd(), label: "Builder 3", goal: "Implement the selected part", projectContext: "Test project" });
    // Startup is asynchronous; the fake child signals when it has emitted its first tool event.
    while (!children.length) await Promise.resolve();
    await children[0]!.ready.promise;
    const rows = app.terminal.crewRows(100, 10).join("\n");
    if (rich) expect(rows).toContain("Builder 3 · read…");
    else expect(rows).toBe("");
    children[0]!.release.resolve();
    await builder;
    if (rich) {
      const completed = app.terminal.crewRows(100, 10).join("\n");
      expect(completed).toContain("Builder 3 · Done");
      expect(completed).toContain("1.3k tokens");
    }
    expect(written.join("")).not.toContain("[crew]");
    const review = app.subagents.run({ role: "reviewer", cwd: process.cwd(), goal: "Review the selected part", projectContext: "Test project" });
    while (children.length < 2) await Promise.resolve();
    await children[1]!.ready.promise;
    if (rich) expect(app.terminal.crewRows(100, 10).join("\n")).toContain("Reviewer 2 · read…");
    children[1]!.release.resolve();
    await review;
    const outcomes = written.join("");
    if (rich) {
      expect(outcomes).toContain("[crew] Reviewer 2: No findings.\n");
      expect(outcomes).not.toContain("Coverage is limited.");
    } else expect(outcomes).not.toContain("[crew]");
    const beforeApplication = written.length;
    const chatter = "Builder 3 is working in its own copy: Implement the selected part";
    const notApplied = "Builder 3's work was not applied (patch conflicts with your folder). It stays in its copy; /crew lists it.";
    const applied = "A builder's change was applied to your folder, uncommitted: src/a.ts.";
    app.terminal.writeCrew(chatter);
    app.terminal.writeCrew(notApplied); // Model completion is not proof that the changes landed.
    app.terminal.writeCrew(applied);
    const application = written.slice(beforeApplication).join("");
    if (rich) {
      expect(application).toContain("  [crew] Builder 3's work was not applied (patch conflicts with your folder). It stays in its copy;\n  /crew lists it.\n");
    } else expect(application).toContain(`[crew] ${notApplied}\n`);
    expect(application).toContain(`[crew] ${applied}\n`);
    if (rich) expect(application).not.toContain(chatter);
    else expect(application).toContain(`[crew] ${chatter}\n`);
  } finally {
    for (const child of children) child.release.resolve();
    await app.close();
    if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm;
  }
});
