import { expect, test } from "bun:test";
import { casperSessionTool, sessionSnapshot, SESSION_TOOL, type SessionToolSource } from "../src/app/session-tool";

const secret = "sk-or-v1-0123456789abcdef0123456789abcdef";

function source(overrides: Partial<SessionToolSource> = {}): SessionToolSource {
  return {
    status: () => ({ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", thinkingLevel: "medium", configuredEffort: "auto",
      availableThinkingLevels: ["off", "low", "medium", "high"], auth: "configured", defaultModel: { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" } }),
    roles: () => ({ fast: "openrouter/fast-one", reason: "anthropic/claude-opus-4-8:high" }),
    usage: () => ({ tokens: { input: 100, output: 50, cacheRead: 300, cacheWrite: 0, total: 450 }, estimatedCost: 0.0123,
      effortClassification: { requests: 2, tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 }, estimatedCost: 0.0001 },
      context: { tokens: 4000, contextWindow: 128000, percent: 3.125 }, messages: 7 }),
    lastTask: () => ({ execution: "completed", receipt: 12, changedPaths: ["src/a.ts", "/etc/hosts", "../outside.txt", "C:\\x.txt"],
      verification: { status: "fail", repairAttempts: 0, rounds: [], results: [
        { name: "test", status: "fail", cwd: "/home/someone/project", exitCode: 1, signal: null, stdout: secret, stderr: "", truncated: false, durationMs: 5 },
        { name: "lint", status: "pass", cwd: "/x", exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 5 },
      ] } }),
    tasks: () => [
      { kind: "dev server", name: "web", status: "running at http://10.1.2.3:3000", stop: async () => "" },
      { kind: "helper", name: "explorer: find the login code", status: "running", stop: async () => "" },
    ],
    mcp: () => [{ name: "central", source: "/home/someone/.casper/mcp.json", transport: "http", state: "ready", toolCount: 3,
      limits: { connectS: 1, callS: 1 }, approved: true, consent: "remembered", writes: "off", access: "access not checked",
      error: `token ${secret}` } as never],
    sideQuestions: () => ({ requests: 1, tokens: 40, estimatedCost: 0.0002 }),
    ...overrides,
  };
}

test("casper_session: model, usage, context, last task, tasks and MCP status, read-only", async () => {
  const tool = casperSessionTool(source());
  expect(tool.name).toBe(SESSION_TOOL);
  expect(tool.sequential).toBeFalsy();
  const all = JSON.parse((await tool.execute({})).text);
  expect(all.model).toEqual({ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash", effort: "medium", configuredEffort: "auto",
    availableEfforts: ["off", "low", "medium", "high"], savedDefault: "openrouter/deepseek/deepseek-v4.1-flash",
    roles: { fast: "openrouter/fast-one", build: null, reason: "anthropic/claude-opus-4-8:high", review: null } });
  expect(all.usage).toEqual({ input: 100, output: 50, cacheRead: 300, cacheWrite: 0, cacheHitRate: 0.75,
    estimatedCost: 0.0123, costNote: "estimate, not a bill", classifierCost: 0.0001, sideQuestionCost: 0.0002 });
  expect(all.context).toEqual({ tokens: 4000, window: 128000, percent: 3.1, messages: 7 });
  expect(all.lastTask.number).toBe(12);
  // Only paths inside the project.
  expect(all.lastTask.changedPaths).toEqual(["src/a.ts"]);
  expect(all.lastTask.checks).toEqual({ test: "fail", lint: "pass" });
  expect(typeof all.lastTask.receiptLine).toBe("string");
  expect(all.tasks).toEqual([{ n: 1, kind: "dev server", label: "web", running: true }, { n: 2, kind: "helper", label: "explorer: find the login code", running: true }]);
  expect(all.mcp).toEqual([{ name: "central", connected: true, writes: "off" }]);
  // No secrets, no hosts, no paths outside the project.
  const text = JSON.stringify(all);
  for (const leak of [secret, "10.1.2.3", "/home/someone", "/etc/hosts", "outside.txt"]) expect(text).not.toContain(leak);
});

test("casper_session: part narrows the answer; an unknown part is an error, not a guess", async () => {
  const tool = casperSessionTool(source());
  expect(Object.keys(JSON.parse((await tool.execute({ part: "model" })).text))).toEqual(["model"]);
  expect(Object.keys(JSON.parse((await tool.execute({ part: "lastTask" })).text))).toEqual(["lastTask"]);
  const bad = await tool.execute({ part: "secrets" });
  expect(bad.isError).toBe(true);
  expect(bad.text).toContain("model, usage, context, lastTask, tasks, mcp");
});

test("casper_session: nothing loaded yet reads as null, and the description stays short", async () => {
  const empty = sessionSnapshot({ status: () => undefined, roles: () => ({}), usage: () => undefined, lastTask: () => undefined, tasks: () => [], mcp: () => [] });
  expect(empty).toEqual({ model: null, usage: null, context: null, lastTask: null, tasks: [], mcp: [] });
  const tool = casperSessionTool(source());
  // About 60 tokens: it is offered every task.
  expect(tool.description.split(/\s+/).length).toBeLessThanOrEqual(45);
  expect(JSON.stringify(tool.inputSchema).length).toBeLessThan(300);
});
