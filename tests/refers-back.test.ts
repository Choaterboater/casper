import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { checkWordsOnly, refersBack } from "../src/app/earlier-conversation";
import type { AgentRuntime, RuntimeConversation } from "../src/runtime/types";
import { richApp } from "./support/app";
import { withEnv } from "./support/env";

/**
 * A real v0.4.3 start: the row offered "1 Continue today's conversation (launch omp and Casper for the comparison · 83
 * messages)", the person typed "re run test" meaning the comparison, and Casper started a new conversation that ran the
 * project's 12 unit tests instead. "still dont know what it is doing".
 */

const TODAY: RuntimeConversation[] = [
  { id: "a0a0a0a0-0000", name: "launch omp and Casper for the comparison", modified: new Date().toISOString(), messages: 83 },
];

function runtime(saved: RuntimeConversation[], resumed: string[], prompts: string[], project: string): AgentRuntime {
  const file = path.join(path.dirname(project), "session.jsonl");
  writeFileSync(file, "");
  return {
    async start() {
      return {
        setTools: () => {},
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" as const }),
        getState: () => ({ cwd: "", isStreaming: false }),
        getSessionInfo: () => ({ cwd: project, sessionId: "current", sessionFile: file }),
        forkSession: async () => ({ cwd: project, sessionId: "fork", sessionFile: file }),
        switchSession: async () => ({ cwd: project, sessionId: "current", sessionFile: file }),
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async (text: string) => { prompts.push(text); },
        listConversations: async () => saved,
        resumeConversation: async (id: string) => { resumed.push(id); },
        recentTurns: () => [],
      };
    },
    async dispose() {},
  };
}

test("what refers back to earlier work: rerun, again, same as before, and a short do-it-to-that", () => {
  for (const line of ["re run test", "rerun the test", "re-run it", "run it again", "again", "do that again", "same as before",
    "same thing for omp", "try again", "retry", "repeat the last run", "one more time", "fix it", "finish that", "run those"]) {
    expect({ line, back: refersBack(line) }).toEqual({ line, back: true });
  }
  for (const line of ["run test", "test", "fix the login bug", "explain the notes", "what is it?", "add a dark mode toggle to the settings page",
    "write a script that reruns the nightly export and mails the result to the team every morning"]) {
    expect({ line, back: refersBack(line) }).toEqual({ line, back: false });
  }
  // A pasted line is not one the person typed.
  expect(refersBack("re run test", ["re run test"])).toBe(false);
  // "run test", "test", "lint": a project check by name and nothing else.
  expect(checkWordsOnly("run test", ["test", "lint"])).toBe("test");
  expect(checkWordsOnly("test", ["test"])).toBe("test");
  expect(checkWordsOnly("run the lint", ["test", "lint"])).toBe("lint");
  expect(checkWordsOnly("run test for the parser", ["test"])).toBeUndefined();
  expect(checkWordsOnly("run test", ["lint"])).toBeUndefined();
});

test("\"re run test\" at the start, with today's conversation on offer, continues it in one line and sends the request there", async () => {
  const resumed: string[] = [], prompts: string[] = [];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => runtime(TODAY, resumed, prompts, project), { savedConversations: async () => TODAY });
    try {
      await app.until(text => text.includes("Continue today's conversation (launch omp and Casper for the comparison · 83 messages)"));
      app.input.write("re run test\r");
      await app.until(() => prompts.length === 1);
      expect(resumed).toEqual(["a0a0a0a0-0000"]);
      expect(prompts[0]).toContain("re run test");
      await app.until(text => text.lastIndexOf("idle") > text.lastIndexOf("re run test"));
      const screen = app.screen();
      expect(screen).toContain("[session] Continuing today's conversation (launch omp and Casper for the comparison): \"re run test\" refers back to it.");
      // One line, no box: not the /continue command's own lines.
      expect(screen).not.toContain("Back in \"");
      expect(screen).not.toMatch(/Type 1|Type a number/);
    } finally { await app.close(); }
  });
}, 30_000);

test("an old conversation is not continued on a guess: \"re run test\" then starts the new one", async () => {
  const OLD: RuntimeConversation[] = [{ id: "b0b0b0b0-0000", name: "Fix the login bug", modified: "2026-01-02T12:00:00Z", messages: 12 }];
  const resumed: string[] = [], prompts: string[] = [];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => runtime(OLD, resumed, prompts, project), { savedConversations: async () => OLD });
    try {
      await app.until(text => text.includes("Continue the Jan 2 conversation"));
      app.input.write("re run test\r");
      await app.until(() => prompts.length === 1);
      expect(resumed).toEqual([]);
      await app.until(text => text.lastIndexOf("idle") > text.lastIndexOf("re run test"));
    } finally { await app.close(); }
  });
}, 30_000);

test("\"run test\" at the start names which test it runs, and the Next row offers the conversation instead; nothing asks", async () => {
  const resumed: string[] = [], prompts: string[] = [];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => runtime(TODAY, resumed, prompts, project), { savedConversations: async () => TODAY },
      { files: { "package.json": JSON.stringify({ name: "smoke", scripts: { test: "node --test" } }) } });
    try {
      await app.until(text => text.includes("Continue today's conversation"));
      app.input.write("run test\r");
      await app.until(() => prompts.length === 1);
      expect(resumed).toEqual([]);
      await app.until(text => text.includes("Ask in today's conversation instead"));
      const screen = app.screen();
      expect(screen).toContain("[task] \"run test\" runs this project's test check (npm run test) in a new conversation.");
      // Its own row, or the card's Next row when a receipt card shows (Windows: undo has no copy there).
      expect(screen).toMatch(/\[?1\]?\s+Ask in today's conversation instead \(launch omp and Casper for the comparison\)/);
      expect(screen).not.toMatch(/Type 1|Type a number/);
      // Its key sends the same words into that conversation.
      await app.until(text => text.lastIndexOf("idle") > text.lastIndexOf("Ask in today's conversation instead"));
      app.input.write("1");
      await app.until(() => prompts.length === 2);
      expect(resumed).toEqual(["a0a0a0a0-0000"]);
      expect(prompts[1]).toContain("run test");
      await app.until(text => text.includes("[session] Continuing today's conversation (launch omp and Casper for the comparison)"));
    } finally { await app.close(); }
  });
}, 40_000);
