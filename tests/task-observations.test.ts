import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { ProjectModel } from "../src/project/model";
import type { AgentRuntime, RuntimeSession } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { classifyTask, formatTaskPrompt } from "../src/task/classify";
import { TaskObservations } from "../src/task/observations";
import { formatTaskResult } from "../src/task/result";

const bash = (command: string, isError = false) => ({
  type: "tool_end" as const, toolName: "bash", toolCallId: "call", input: { command }, isError, output: { text: "ok", truncated: false },
});

function observed(configured: Record<string, string>, command: string): string[] {
  const observations = new TaskObservations();
  observations.observeToolEnd(bash(command), configured);
  return observations.snapshot([]).observedChecks.map(({ name }) => name);
}

test("a shell run of the configured script under its package-manager alias is observed as that check", () => {
  const npm = { test: "npm run test", lint: "npm run lint" };
  expect(observed(npm, "npm test")).toEqual(["test"]);
  expect(observed(npm, "  npm   run test ")).toEqual(["test"]);
  expect(observed(npm, "npm run-script lint")).toEqual(["lint"]);
  expect(observed({ test: "npm test" }, "npm run test")).toEqual(["test"]);
  expect(observed({ test: "pnpm run test" }, "pnpm test")).toEqual(["test"]);
  expect(observed({ test: "yarn run test" }, "yarn test")).toEqual(["test"]);

  // Different programs or arguments are never the configured check: `bun test` is Bun's
  // runner, not the `test` script; extra arguments may select a subset.
  expect(observed({ test: "bun run test" }, "bun test")).toEqual([]);
  expect(observed({ test: "bun test" }, "bun run test")).toEqual([]);
  expect(observed(npm, "npm test -- sum")).toEqual([]);
  expect(observed(npm, "pnpm test")).toEqual([]);
  expect(observed(npm, "node test.js")).toEqual([]);
  expect(observed({ lint: "npm run lint" }, "npm lint")).toEqual([]);
  // Quoted blanks are data, so they are compared verbatim.
  expect(observed({ test: 'node -e "a  b"' }, 'node -e "a b"')).toEqual([]);
  expect(observed({ test: 'node -e "a  b"' }, ' node -e "a  b" ')).toEqual(["test"]);
});

test("the receipt reports an aliased shell test run as a diagnostic observation", () => {
  const observations = new TaskObservations();
  observations.observeToolEnd(bash("npm test"), { test: "npm run test" });
  const text = formatTaskResult({ execution: "completed", ...observations.snapshot(["sum.js"]) });
  expect(text).toContain("test:success (diagnostics only)");
});

const response = (usage?: { tokens: number; estimatedCost: number }) => ({ type: "assistant_response_end" as const, stopReason: "toolUse", ...(usage ? { usage } : {}) });

test("usage counts every model response and totals its reported tokens and cost", () => {
  const observations = new TaskObservations();
  expect(observations.snapshot([]).usage).toEqual({ turns: 0, tokens: 0, estimatedCost: 0 });
  observations.observeUsage(response({ tokens: 100, estimatedCost: 0.25 }));
  observations.observeUsage({ type: "tool_start", toolName: "bash" });
  observations.observeUsage(response({ tokens: 50, estimatedCost: 0.5 }));
  expect(observations.snapshot([]).usage).toEqual({ turns: 2, tokens: 150, estimatedCost: 0.75 });
});

test("a delegated subagent's reported usage is added to the task's tokens and cost, but not its turns", () => {
  const delegated = new TaskObservations();
  delegated.observeUsage(response({ tokens: 100, estimatedCost: 0.25 }));
  delegated.observeUsage({ type: "tool_start", toolName: "delegate" });
  delegated.observeUsage({ type: "tool_start", toolName: "delegate" });
  // The children report in either order relative to the parent's events; an invalid call that
  // started no child reports zero.
  delegated.recordDelegatedUsage({ tokens: 40, estimatedCost: 0.125 });
  expect(delegated.snapshot([]).usage).toEqual({ turns: 1, tokens: null, estimatedCost: null });
  delegated.recordDelegatedUsage({ tokens: 0, estimatedCost: 0 });
  delegated.observeUsage(response({ tokens: 50, estimatedCost: 0.5 }));
  expect(delegated.snapshot([]).usage).toEqual({ turns: 2, tokens: 190, estimatedCost: 0.875 });
});

test("usage is unknown, never an undercount, when a response has none or a subagent made model calls", () => {
  const unreported = new TaskObservations();
  unreported.observeUsage(response({ tokens: 100, estimatedCost: 0.25 }));
  unreported.observeUsage(response());
  unreported.observeUsage(response({ tokens: 50, estimatedCost: 0.5 }));
  expect(unreported.snapshot([]).usage).toEqual({ turns: 3, tokens: null, estimatedCost: null });

  // A delegation whose child never reported, or reported no usage, leaves the totals unknown.
  const unreportedChild = new TaskObservations();
  unreportedChild.observeUsage(response({ tokens: 100, estimatedCost: 0.25 }));
  unreportedChild.observeUsage({ type: "tool_start", toolName: "delegate" });
  expect(unreportedChild.snapshot([]).usage).toEqual({ turns: 1, tokens: null, estimatedCost: null });
  const unknownChild = new TaskObservations();
  unknownChild.observeUsage({ type: "tool_start", toolName: "delegate" });
  unknownChild.recordDelegatedUsage(null);
  expect(unknownChild.snapshot([]).usage).toEqual({ turns: 0, tokens: null, estimatedCost: null });

  const classified = new TaskObservations();
  classified.recordUntrackedModelUse();
  classified.observeUsage(response({ tokens: 100, estimatedCost: 0.25 }));
  expect(classified.snapshot([]).usage).toEqual({ turns: 1, tokens: null, estimatedCost: null });
});

test("the task result carries this task's usage; automatic-effort classification makes tokens unknown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-task-usage-"));
  try {
    await mkdir(path.join(root, "home"));
    let classifications = 0;
    let classify = false;
    const runtime: AgentRuntime = {
      async start(): Promise<RuntimeSession> {
        const listeners = new Set<(event: Parameters<Parameters<RuntimeSession["subscribe"]>[0]>[0]) => void>();
        return {
          async prompt() {
            if (classify) classifications++;
            for (const listener of listeners) {
              listener({ type: "assistant_response_start" });
              listener({ type: "assistant_response_end", stopReason: "stop", usage: { tokens: 120, estimatedCost: 0.5 } });
            }
          },
          async abort() {}, setTools() {}, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
          getState: () => ({ cwd: root, isStreaming: false }),
          getUsage: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, messages: 0,
            effortClassification: { requests: classifications, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
        };
      },
      async dispose() {},
    };
    const app = new CasperApp({
      verificationMode: "off", runtimeFactory: () => runtime, output: { write: () => {} },
      loadProjectContext: (project) => loadProjectContext(project, { homeDir: path.join(root, "home") }),
      loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: path.join(root, "home") }),
    });
    try {
      await app.runOnce("explain the project", root);
      expect(app.getLastTaskResult()?.usage).toEqual({ turns: 1, tokens: 120, estimatedCost: 0.5 });
      // Each task counts only its own responses.
      classify = true;
      await app.runOnce("explain the project again", root);
      expect(app.getLastTaskResult()?.usage).toEqual({ turns: 1, tokens: null, estimatedCost: null });
    } finally { await app.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

const model: ProjectModel = {
  schemaVersion: 1, project: { name: "sum", root: "/sum", git: false }, languages: ["javascript"], frameworks: [],
  packageManager: "npm", commands: { test: "npm run test" }, architecture: {}, conventions: [], detectedAt: "2026-01-01T00:00:00.000Z",
};

test("in auto mode the model is told Casper runs the final checks; casper_check stays for iteration", () => {
  const classification = classifyTask("fix the failing test");
  const auto = formatTaskPrompt("fix the failing test", classification, model, { verificationMode: "auto" });
  const offered = formatTaskPrompt("fix the failing test", classification, model, { verificationMode: "offer" });
  expect(offered).not.toContain("Casper runs the final checks");
  expect(auto).toContain("Casper runs the final checks itself after your last edit and records them; you do not need to. Use casper_check while iterating if it helps. Bash runs of checks are diagnostics only.");
  expect(auto.endsWith("User request:\nfix the failing test")).toBe(true);
});

test("--verify (auto mode) asks the first turn for the checklist by default, and sends the request alone when the review is on", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-verify-requested-"));
  try {
    await mkdir(path.join(root, "home"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
    const prompts: string[] = [];
    const runtime: AgentRuntime = {
      async start(): Promise<RuntimeSession> {
        return {
          async prompt(text) { prompts.push(text); }, async abort() {}, subscribe: () => () => {},
          getState: () => ({ cwd: root, isStreaming: false }),
        };
      },
      async dispose() {},
    };
    const run = async (auto: boolean) => {
      const app = new CasperApp({
        verificationMode: auto ? "auto" : "offer", runtimeFactory: () => runtime, output: { write: () => {} },
        loadProjectContext: (project) => loadProjectContext(project, { homeDir: path.join(root, "home") }),
        loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: path.join(root, "home") }),
      });
      try { await app.runOnce("fix the failing test", root); } finally { await app.close(); }
    };
    await run(false); await run(true);
    // The review is off by default: auto mode's first turn asks for the checklist and the failing test itself.
    expect(prompts.map((prompt) => prompt.includes("Casper initial classification"))).toEqual([true, true]);
    expect(prompts.map((prompt) => prompt.includes("Tick a requirement only when a test you can name asserts it"))).toEqual([false, true]);
    // With the review on, it checks the requirements afterwards, so the first turn is the request alone.
    await mkdir(path.join(root, ".casper"));
    await writeFile(path.join(root, ".casper/project.yaml"), "verification:\n  review: true\n");
    await run(true);
    expect(prompts[2]!.includes("Casper initial classification")).toBe(false);
    expect(prompts[2]!.trim().endsWith("fix the failing test")).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a known test runner the model ran is kept only as a suggestion, and only when it passed with no test command set", () => {
  const end = (command: string, isError = false) => ({ type: "tool_end" as const, toolName: "bash", toolCallId: "t", input: { command },
    output: { text: "", truncated: false }, isError });
  const passed = new TaskObservations();
  passed.observeToolEnd(end("uv run pytest"), {});
  expect(passed.snapshot([]).testRunner).toBe("uv run pytest");
  expect(passed.snapshot([]).observedChecks).toEqual([]);
  const failed = new TaskObservations();
  failed.observeToolEnd(end("uv run pytest", true), {});
  expect(failed.snapshot([]).testRunner).toBeUndefined();
  const configured = new TaskObservations();
  configured.observeToolEnd(end("uv run pytest"), { test: "make test" });
  expect(configured.snapshot([]).testRunner).toBeUndefined();
  const other = new TaskObservations();
  other.observeToolEnd(end("python -c 'import os'"), {});
  expect(other.snapshot([]).testRunner).toBeUndefined();
});

test("changes the AI made on another machine over ssh reach the receipt, marked as read from the commands", async () => {
  const { formatReceipt, SECRET_IN_COMMAND } = await import("../src/task/result");
  const observations = new TaskObservations();
  observations.observeToolEnd(bash("ssh root@lab-01 'pveum user token add root@pam demoapp --privsep 0'"), {});
  observations.observeToolEnd(bash("ssh root@lab-01 'systemctl enable --now demoapp'"), {});
  observations.observeToolEnd(bash("ssh root@lab-01 'cat /etc/hosts'"), {});
  // Refused by Casper: it never ran.
  observations.observeToolEnd({ ...bash("ssh sw1 'reboot'", true), output: { text: "Not run: the user said no to reaching sw1.", truncated: false } }, {});
  observations.observeToolEnd({ ...bash("curl -H 'Authorization: PVEAPIToken=<secret hidden>' https://lab-01:8006/api2/json"), input: { command: "curl …", secretHidden: true as const } }, {});
  const snapshot = observations.snapshot([]);
  expect(snapshot.remoteChanges).toEqual([{ host: "lab-01", changes: [
    "made an API token (pveum user token add root@pam demoapp --privse…)", "turned a service on or off at boot (systemctl enable --now demoapp)"] }]);
  expect(snapshot.secretInCommand).toBe(true);
  const receipt = formatReceipt({ execution: "completed", ...snapshot });
  expect(receipt).toContain("• Changed on lab-01 (from the commands Casper saw): made an API token (pveum user token add root@pam demoapp --privse…); turned a service on or off at boot (systemctl enable --now demoapp)");
  expect(receipt).toContain(`• ${SECRET_IN_COMMAND}`);
  expect(SECRET_IN_COMMAND).toBe("A secret appeared in a command; change it after this task.");
  expect(formatTaskResult({ execution: "completed", ...snapshot })).toContain("(from the commands Casper saw)");
  // Nothing remote, nothing said.
  const quiet = new TaskObservations();
  quiet.observeToolEnd(bash("npm test"), {});
  expect(formatReceipt({ execution: "completed", ...quiet.snapshot([]) })).not.toContain("Changed on");
});

test("a question-only task that changed another machine over ssh still prints the receipt with that line", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-remote-receipt-"));
  try {
    await mkdir(path.join(root, "home"));
    const runtime: AgentRuntime = {
      async start(): Promise<RuntimeSession> {
        const listeners = new Set<(event: Parameters<Parameters<RuntimeSession["subscribe"]>[0]>[0]) => void>();
        return {
          async prompt() {
            for (const listener of listeners) {
              listener({ type: "assistant_response_start" });
              listener({ type: "tool_end", toolName: "bash", toolCallId: "c1", isError: false, output: { text: "", truncated: false },
                input: { command: "ssh root@lab-01 'systemctl enable --now demoapp'" } });
              listener({ type: "assistant_response_end", stopReason: "stop" });
            }
          },
          async abort() {}, setTools() {}, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
          getState: () => ({ cwd: root, isStreaming: false }),
        };
      },
      async dispose() {},
    };
    let written = "";
    const app = new CasperApp({
      verificationMode: "off", runtimeFactory: () => runtime, output: { write: (text: string) => { written += text; } },
      loadProjectContext: (project) => loadProjectContext(project, { homeDir: path.join(root, "home") }),
      loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: path.join(root, "home") }),
    });
    try {
      await app.runOnce("check the lab host uptime", root);
      expect(written).toContain("• Changed on lab-01 (from the commands Casper saw): turned a service on or off at boot (systemctl enable --now demoapp)");
    } finally { await app.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
