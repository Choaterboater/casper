import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { browserSession } from "../src/app/task-tools";
import { parseScenario, type BrowserCheck } from "../src/browser/scenario";
import { BrowserSession, type CarriedCheck } from "../src/browser/session";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

// A real session lost its checks between tasks: the browser closes at each task's end, and "Unknown browser check id"
// came back three times when the AI replayed one to get its before-edit result.

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function folder() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-carried-checks-"));
  cleanup.push(() => removeTempDir(root));
  return root;
}

/** A check an earlier task recorded: what it runs and how its last run went. */
function recorded(n: number, status: BrowserCheck["status"] = "fail"): CarriedCheck {
  const scenario = parseScenario({ name: `Title ${n}`, url: "http://127.0.0.1:5173/", steps: [], assertions: [{ kind: "text", selector: "h1", expected: "New title" }] });
  return { scenario, check: { id: `check-${n}`, name: scenario.name, scenarioSha256: "0".repeat(64), url: scenario.url, viewport: scenario.viewport,
    status, baseline: "fail", freshness: "fresh", assertions: [{ kind: "text", status: status === "pass" ? "pass" : "fail", actual: "Old title" }] } };
}

test("a browser takes an earlier task's checks: none is in its report until it runs, none can be withdrawn unseen, and the newest 24 go on", async () => {
  const root = await folder();
  const earlier = Array.from({ length: 30 }, (_, index) => recorded(index + 1));
  const session = new BrowserSession({ projectRoot: root, stateDirectory: root, carried: earlier });
  cleanup.push(() => session.close());
  expect(session.carried().map(({ check }) => check.id)).toEqual(earlier.slice(-24).map(({ check }) => check.id));
  // An earlier task's result belongs to that task's receipt.
  expect(await session.report()).toMatchObject({ status: "incomplete", checks: [] });
  await expect(session.run({ action: "withdraw", id: "check-30", reason: "expected text had a typo" }))
    .rejects.toThrow("This check was recorded in an earlier task: replay it first, or record a corrected check of the same page");
  await expect(session.run({ action: "withdraw", id: "check-29", reason: "typo", replacedBy: "check-30" }))
    .rejects.toThrow("replacedBy must name a check run in this task; replay it first");
  await expect(session.run({ action: "replay", id: "check-1" })).rejects.toThrow("Unknown browser check id; replay an id a check returned in this conversation");
  // Untouched, they go on as they came, results and all.
  expect(session.carried()).toEqual(earlier.slice(-24));
});

test("in the app, the next task's browser replays the last one's check ids; /clear forgets them", async () => {
  const root = await folder();
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(project);
  await writeFile(path.join(project, "notes.txt"), "Notes.\n");
  const listeners = new Set<RuntimeEventListener>();
  const runtime: AgentRuntime = {
    async start() {
      return {
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools() {}, async clearConversation() {},
        prompt: async () => { for (const listener of listeners) { listener({ type: "assistant_text_delta", delta: "ok" }); listener({ type: "message_end" }); } },
      };
    },
    async dispose() {},
  };
  const casper = new CasperApp({
    runtimeFactory: () => runtime, output: { write: () => {} }, sessionHomeDir: home, verificationMode: "off",
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  cleanup.push(() => casper.close());
  await casper.runOnce("say hello", project);
  // The first task's browser, closed at its end with a check in it.
  const carried = new BrowserSession({ projectRoot: project, stateDirectory: root, carried: [recorded(1)] });
  casper.browser = carried;
  await carried.close();
  // The next task starts: its browser, opened when the AI needs one, has the check's id.
  await casper.runOnce("say hello again", project);
  expect(casper.browser).toBeUndefined();
  const next = browserSession(casper);
  expect(next.carried().map(({ check }) => check.id)).toEqual(["check-1"]);
  expect(await next.report()).toMatchObject({ checks: [] });
  // A new conversation starts without them.
  await casper.runOnce("/clear", project);
  expect(casper.browserChecks).toBeUndefined();
  expect(browserSession(casper).carried()).toEqual([]);
});
