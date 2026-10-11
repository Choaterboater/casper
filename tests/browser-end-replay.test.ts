import { expect, test } from "bun:test";
import type { BrowserSession } from "../src/browser/session";
import type { BrowserReport } from "../src/browser/scenario";
import type { AgentRuntime } from "../src/runtime/types";
import { richApp } from "./support/app";

/** At the end of a task Casper replays browser checks that ran before a later edit itself, before the receipt. */

function quietRuntime(fails = false): AgentRuntime {
  return {
    async start() {
      return {
        setTools: () => {},
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" as const }),
        getState: () => ({ cwd: "", isStreaming: false }),
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async () => { if (fails) throw new Error("synthetic model failure"); },
      };
    },
    async dispose() {},
  };
}

const check = (freshness: "fresh" | "stale") => ({ id: "c1", name: "Save", scenarioSha256: "0", url: "http://127.0.0.1:3000/", viewport: { width: 390, height: 800 },
  status: "pass" as const, baseline: "pass" as const, freshness, assertions: [{ kind: "text", status: "pass" as const, actual: "Saved" }] });

/** One task against a fake browser whose end replay passes the check, or (when it can't run) leaves it stale. */
async function endOfTask(replays: boolean, fails = false): Promise<{ calls: string[]; screen: string }> {
  process.env.TERM = "xterm-256color";
  const app = await richApp(() => quietRuntime(fails));
  const calls: string[] = [];
  let replayed = false;
  (app.app as unknown as { browser: BrowserSession }).browser = {
    status: () => ({ state: "ready" }), assertCleanup: () => {},
    replayStale: async (since: number) => { calls.push(typeof since === "number" ? "replay" : "replay without a start"); replayed = replays; },
    report: async (): Promise<BrowserReport> => { calls.push("report"); return { status: replayed ? "pass" : "incomplete", checks: [check(replayed ? "fresh" : "stale")], guidance: "g" }; },
    close: async () => {},
  } as unknown as BrowserSession;
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("make the save button work\r");
    await app.until(text => /browser checks passed|Browser checks: /.test(text));
    return { calls, screen: app.screen() };
  } finally { await app.close(); }
}

test("a stale browser check is replayed by Casper once at the end, and its fresh pass counts on the receipt", async () => {
  const { calls, screen } = await endOfTask(true);
  expect(calls.slice(0, 2)).toEqual(["replay", "report"]);
  expect(screen).toContain("✓ browser checks passed (1)");
  expect(screen).not.toContain("replay to count");
}, 30_000);

test("when the end replay can't run, the receipt keeps today's line", async () => {
  const { calls, screen } = await endOfTask(false);
  expect(calls.slice(0, 2)).toEqual(["replay", "report"]);
  expect(screen).toContain("Browser checks: 1 of 1 passed; all ran before a later edit or command (replay to count)");
}, 30_000);

test("a failed task does not replay browser checks", async () => {
  const { calls } = await endOfTask(true, true);
  expect(calls).toEqual(["report"]);
}, 30_000);

test("a check the AI withdrew shows on the receipt with its reason, and the passing ones still count", async () => {
  process.env.TERM = "xterm-256color";
  const app = await richApp(() => quietRuntime());
  (app.app as unknown as { browser: BrowserSession }).browser = {
    status: () => ({ state: "ready" }), assertCleanup: () => {}, replayStale: async () => {},
    report: async (): Promise<BrowserReport> => ({ status: "pass", guidance: "g", checks: [
      { ...check("fresh"), id: "c0", name: "Heading", status: "withdrawn", baseline: "fail", withdrawn: "expected text had a typo" }, check("fresh")] }),
    close: async () => {},
  } as unknown as BrowserSession;
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("make the save button work\r");
    await app.until(text => text.includes("withdrawn by the AI"));
    const screen = app.screen();
    expect(screen).toContain("1 check withdrawn by the AI: Heading (expected text had a typo)");
    expect(screen).toContain("✓ browser checks passed (1)");
    expect(screen).not.toContain("Browser checks failed");
  } finally { await app.close(); }
}, 30_000);
