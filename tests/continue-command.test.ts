import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentRuntime, RuntimeConversation } from "../src/runtime/types";
import { CONTINUE_TYPED, continueNamed, formatTaskPrompt } from "../src/task/classify";
import { COMMANDS, runsDuringWork } from "../src/tui/commands";
import { FULL_HELP_TEXT, HELP_TEXT } from "../src/tui/help";
import { richApp } from "./support/app";
import { withEnv } from "./support/env";

/** A runtime whose saved conversations are `saved()`; "current" is the one the session is in. */
function runtime(saved: () => RuntimeConversation[], resumed: Array<[string, unknown]>, project: string): AgentRuntime {
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
        prompt: async () => {},
        listConversations: async () => saved(),
        resumeConversation: async (id: string, options?: unknown) => { resumed.push([id, options]); },
        recentTurns: () => [{ role: "user" as const, text: "Casper initial classification\n\nUser request:\nfix the login bug" },
          { role: "assistant" as const, text: "I changed auth.ts so the session cookie is kept." }],
      };
    },
    async dispose() {},
  };
}

test("/continue goes back to the newest other conversation in this folder, not the one you are in nor an empty one", async () => {
  const resumed: Array<[string, unknown]> = [];
  const saved: RuntimeConversation[] = [
    { id: "c0c0c0c0-0000", name: "Add a dark mode", modified: "2026-10-02T09:00:00Z", messages: 6 },
    { id: "current", modified: "2026-10-04T11:59:00Z", messages: 2 },
    // What /clear leaves: saved at once, with nothing in it.
    { id: "e0e0e0e0-0000", modified: "2026-10-04T11:00:00Z", messages: 0 },
    { id: "b0b0b0b0-0000", name: "Fix the login bug", modified: "2026-10-04T09:00:00Z", messages: 12 },
  ];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => runtime(() => saved, resumed, project));
    try {
      await app.until(text => text.includes("idle"));
      app.input.write("/continue\r");
      await app.until(text => text.includes("I changed auth.ts"));
      // Like --continue, a new conversation with no reply is dropped rather than saved for the next /continue.
      expect(resumed).toEqual([["b0b0b0b0-0000", { keepUnwritten: false }]]);
      expect(app.screen()).toContain("[session] Back in \"Fix the login bug\". Your files are not changed; /resume lists the others.");
      expect(app.screen()).toContain("you  fix the login bug");
    } finally { await app.close(); }
  });
}, 30_000);

test("/continue with no other conversation in this folder says so, and nothing changes", async () => {
  const resumed: Array<[string, unknown]> = [];
  let saved: RuntimeConversation[] = [];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => runtime(() => saved, resumed, project));
    try {
      await app.until(text => text.includes("idle"));
      app.input.write("/continue\r");
      await app.until(text => text.includes("No earlier conversation"));
      expect(app.screen()).toContain("[session] No earlier conversation in this workspace; starting a new one.");
      // Once the one you are in has a reply it is listed too; an empty one /clear left doesn't count.
      saved = [{ id: "current", modified: "2026-10-04T11:59:00Z", messages: 2 }, { id: "e0e0e0e0-0000", modified: "2026-10-04T12:00:00Z", messages: 0 }];
      app.input.write("/continue\r");
      await app.until(text => text.includes("staying in this one"));
      expect(app.screen()).toContain("[session] No earlier conversation in this workspace; staying in this one.");
      expect(resumed).toEqual([]);
    } finally { await app.close(); }
  });
}, 30_000);

test("/help and the / menu list /continue next to /resume, and it waits for a running task as /resume does", () => {
  expect(HELP_TEXT).toContain("\n  /continue, /resume     Go back to this folder's last conversation, or pick one; /clear starts fresh\n");
  expect(FULL_HELP_TEXT).toContain("\n  /continue                         Go back to the most recent other conversation saved in this folder, as casper --continue does at startup\n");
  expect(FULL_HELP_TEXT).toContain("Conversations are saved per folder: /continue and /resume see this folder's.");
  const names = COMMANDS.map(command => command.name);
  expect(names.indexOf("continue")).toBe(names.indexOf("resume") + 1);
  expect([runsDuringWork("/resume"), runsDuringWork("/continue")]).toEqual([false, false]);
});

test("asked in plain words to continue an earlier session, the AI is told the commands that do it, and only then", () => {
  for (const request of ["cccontinue last session", "continue the previous conversation", "can you resume our last chat?",
    "pick up where we left off", "Go back to yesterday's session", "carry on from the earlier sessions"]) {
    expect({ request, named: continueNamed(request) }).toEqual({ request, named: true });
  }
  // This conversation's own work, or no earlier session at all.
  for (const request of ["continue", "continue the last task", "resume the download", "fix the login bug",
    "what changed since the last release?", "the job resumed after the last session timed out"]) {
    expect({ request, named: continueNamed(request) }).toEqual({ request, named: false });
  }
  expect(CONTINUE_TYPED).toBe("Earlier sessions: if this conversation doesn't have the work, tell the user conversations are saved per folder: "
    + "they type /continue for the most recent one here, or /resume to pick one (in another folder, start Casper there). "
    + "You can't run / commands or read saved conversations.");
  const model = { commands: {} } as never;
  const general = { intent: "general", mode: "modify", verification: [] } as never;
  expect(formatTaskPrompt("cccontinue last session", general, model)).toContain(`\n- ${CONTINUE_TYPED}\n`);
  expect(formatTaskPrompt("fix the login bug", general, model)).not.toContain("/continue");
  // A change Casper will review and prove gets the request as written, plus this one line when it asks for an earlier session.
  const proving = { proveChange: true, reviewFollows: true };
  expect(formatTaskPrompt("fix the login bug", general, model, proving)).toBe("fix the login bug");
  expect(formatTaskPrompt("continue the last session", general, model, proving)).toBe(`${CONTINUE_TYPED}\nUser request:\ncontinue the last session`);
});
