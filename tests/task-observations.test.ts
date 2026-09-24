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

test("the app forwards --verify (auto mode) into the task prompt", async () => {
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
      await app.runOnce("fix the failing test", root);
    };
    await run(false); await run(true);
    expect(prompts.map((prompt) => prompt.includes("Casper runs the final checks"))).toEqual([false, true]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
