import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { continueLabel, continueWords, conversationDay, EARLY_ONE_WAIT_MS, NEW_CONVERSATION_HINT } from "../src/app/earlier-conversation";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";
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
  expect(FULL_HELP_TEXT).toContain("\n  /continue                         Go back to the most recent other conversation saved in this folder, as casper --continue does at startup; each start is a new conversation, and 1 on the start's row runs this\n");
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

/** The earlier conversations a folder has, as the start's row reads them: an old one with replies, and an empty one
 * /clear left (newer, never offered). */
const EARLIER: RuntimeConversation[] = [
  { id: "b0b0b0b0-0000", name: "Fix the login bug", modified: "2026-10-21T12:00:00Z", messages: 12 },
  { id: "e0e0e0e0-0000", modified: "2026-10-22T12:00:00Z", messages: 0 },
];
function withPrompts(base: AgentRuntime, prompts: string[]): AgentRuntime {
  return {
    ...base,
    async start(options) {
      const session = await base.start(options);
      return { ...session, prompt: async (text: string) => { prompts.push(text); } };
    },
  };
}
const ROW = `Next: 1 ${continueLabel(EARLIER[0]!.modified)} (Fix the login bug · 12 messages)`;

test("a plain start begins a new conversation and offers one row to continue the last one: 1 continues it", async () => {
  const resumed: Array<[string, unknown]> = [];
  const prompts: string[] = [];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => withPrompts(runtime(() => EARLIER, resumed, project), prompts), { savedConversations: async () => EARLIER });
    try {
      await app.until(text => text.includes(ROW));
      expect(app.screen()).toContain(NEW_CONVERSATION_HINT);
      // Nothing reopened on its own.
      expect(resumed).toEqual([]);
      app.input.write("1");
      await app.until(text => text.includes("Back in \"Fix the login bug\""));
      // What --continue would pick: the newest with replies, never the empty one /clear left.
      expect(resumed).toEqual([["b0b0b0b0-0000", { keepUnwritten: false }]]);
      expect(prompts).toEqual([]);
    } finally { await app.close(); }
  });
}, 30_000);

test("Enter on the empty prompt runs nothing, and typing a request starts the new conversation", async () => {
  const resumed: Array<[string, unknown]> = [];
  const prompts: string[] = [];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => withPrompts(runtime(() => EARLIER, resumed, project), prompts), { savedConversations: async () => EARLIER });
    try {
      await app.until(text => text.includes(ROW));
      app.input.write("\r");
      await Bun.sleep(200);
      expect(resumed).toEqual([]);
      app.input.write("explain the notes\r");
      await app.until(() => prompts.length === 1);
      expect(prompts[0]).toContain("explain the notes");
      expect(resumed).toEqual([]);
      // The row is gone with the first request: a later 1 is an ordinary request.
      app.input.write("1\r");
      await app.until(() => prompts.length === 2);
      expect(resumed).toEqual([]);
    } finally { await app.close(); }
  });
}, 30_000);

test("a folder with no earlier conversation shows no row; a one-shot run never offers one", async () => {
  const resumed: Array<[string, unknown]> = [];
  const prompts: string[] = [];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const empty = await richApp(project => withPrompts(runtime(() => [], resumed, project), prompts), { savedConversations: async () => [] });
    try {
      await empty.until(text => text.includes("idle"));
      await Bun.sleep(200);
      expect(empty.screen()).not.toContain("Continue the");
    } finally { await empty.close(); }
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-oneshot-row-"));
  try {
    const home = path.join(root, "home"); const project = path.join(root, "project");
    await mkdir(home); await mkdir(project); writeFileSync(path.join(project, "notes.txt"), "notes\n");
    let written = "";
    const app = new CasperApp({
      sessionHomeDir: home, runtimeFactory: () => withPrompts(runtime(() => EARLIER, resumed, project), prompts), savedConversations: async () => EARLIER,
      loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
      loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
      loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      output: { write: (text: string) => { written += text; } },
    });
    try {
      await app.runOnce("explain the notes", project);
      expect(written).not.toContain("Continue the");
      expect(resumed).toEqual([]);
      expect(prompts.at(-1)).toContain("explain the notes");
    } finally { await app.close(); }
  } finally { await removeTempDir(root); }
}, 30_000);

test("the row names the day plainly: today's, yesterday's, a date, and the year when it isn't this one", () => {
  const now = new Date(2026, 9, 27, 15, 0);
  expect(conversationDay(new Date(2026, 9, 27, 9, 0).toISOString(), now)).toBe("today's");
  expect(conversationDay(new Date(2026, 9, 26, 23, 0).toISOString(), now)).toBe("yesterday's");
  expect(conversationDay(new Date(2026, 9, 21, 12, 0).toISOString(), now)).toBe("Oct 21");
  expect(conversationDay(new Date(2025, 11, 30, 12, 0).toISOString(), now)).toBe("Dec 30, 2025");
  // "Continue today's conversation", never "Continue the today's conversation".
  expect(continueLabel(new Date(2026, 9, 27, 9, 0).toISOString(), now)).toBe("Continue today's conversation");
  expect(continueLabel(new Date(2026, 9, 26, 23, 0).toISOString(), now)).toBe("Continue yesterday's conversation");
  expect(continueLabel(new Date(2026, 9, 21, 12, 0).toISOString(), now)).toBe("Continue the Oct 21 conversation");
});

/** Like `runtime`, but the session is in whichever conversation it last resumed. */
function following(saved: RuntimeConversation[], resumed: Array<[string, unknown]>, project: string): AgentRuntime {
  let current = "current";
  const base = runtime(() => saved, resumed, project);
  return {
    async start(...args: Parameters<AgentRuntime["start"]>) {
      const session = await base.start(...args);
      return {
        ...session,
        getSessionInfo: () => ({ ...session.getSessionInfo!(), sessionId: current }),
        resumeConversation: async (id: string, options?: unknown) => { await session.resumeConversation!(id, options as never); current = id; },
      };
    },
    dispose: () => base.dispose(),
  };
}

const TWO: RuntimeConversation[] = [
  { id: "a0a0a0a0-0000", name: "Write the Docker script", modified: "2026-10-04T10:00:00Z", messages: 8 },
  { id: "current", name: "Fix the login bug", modified: "2026-10-04T11:00:00Z", messages: 4 },
];

test("/continue again in the conversation /continue opened stays there, instead of jumping back to the one you left", async () => {
  const resumed: Array<[string, unknown]> = [];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => following(TWO, resumed, project));
    try {
      await app.until(text => text.includes("idle"));
      app.input.write("/continue\r");
      await app.until(text => text.includes("Back in \"Write the Docker script\""));
      app.input.write("/continue\r");
      await app.until(text => text.includes("so you stay in it"));
      expect(app.screen()).toContain("[session] You're in the conversation /continue opened, so you stay in it. /resume lists the others.");
      expect(resumed.map(([id]) => id)).toEqual(["a0a0a0a0-0000"]);
      // /resume moves on, and from there /continue goes back as before.
      app.input.write("/resume current\r");
      await app.until(text => text.includes("Back in \"Fix the login bug\""));
      app.input.write("/continue\r");
      await app.until(text => text.split("Back in \"Write the Docker script\"").length === 3);
      expect(resumed.map(([id]) => id)).toEqual(["a0a0a0a0-0000", "current", "a0a0a0a0-0000"]);
    } finally { await app.close(); }
  });
}, 30_000);

test("after casper --continue, /continue stays in the conversation it opened", async () => {
  const resumed: Array<[string, unknown]> = [];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => following(TWO, resumed, project), { conversation: { continue: true } });
    try {
      await app.until(text => text.includes("idle"));
      app.input.write("/continue\r");
      await app.until(text => text.includes("so you stay in it"));
      expect(app.screen()).toContain("[session] You're in the conversation /continue opened, so you stay in it. /resume lists the others.");
    } finally { await app.close(); }
  });
}, 30_000);

test("the docs say /continue stays in the conversation it opened", async () => {
  const read = async (file: string) => (await readFile(path.join(import.meta.dir, "..", "docs", file), "utf8")).replace(/\s+/g, " ");
  expect(await read("SESSIONS.md")).toContain("In the conversation `/continue` or `--continue` opened, `/continue` stays there and says so, rather than going back to the one you left; `/resume` lists the others.");
  expect(await read("TERMINAL_UX.md")).toContain("In the conversation `/continue` or `--continue` opened, it stays there and says so |");
});

test("1 typed before the continue row shows waits for it, and continues the last conversation", async () => {
  const resumed: Array<[string, unknown]> = [];
  const prompts: string[] = [];
  let release!: () => void;
  const looked = new Promise<void>(resolve => { release = resolve; });
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => withPrompts(runtime(() => EARLIER, resumed, project), prompts),
      { savedConversations: async () => { await looked; return EARLIER; } });
    try {
      await app.until(text => text.includes("idle"));
      expect(app.screen()).not.toContain(ROW);
      app.input.write("1\r");
      await Bun.sleep(100);
      release();
      await app.until(text => text.includes("Back in \"Fix the login bug\""));
      expect(resumed).toEqual([["b0b0b0b0-0000", { keepUnwritten: false }]]);
      expect(prompts).toEqual([]);
    } finally { await app.close(); }
  });
}, 30_000);

test("1 typed early in a folder with no earlier conversation is an ordinary request", async () => {
  const resumed: Array<[string, unknown]> = [];
  const prompts: string[] = [];
  let release!: () => void;
  const looked = new Promise<void>(resolve => { release = resolve; });
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => withPrompts(runtime(() => [], resumed, project), prompts),
      { savedConversations: async () => { await looked; return []; } });
    try {
      await app.until(text => text.includes("idle"));
      app.input.write("1\r");
      await Bun.sleep(100);
      release();
      const deadline = Date.now() + 15_000;
      while (!prompts.length && Date.now() < deadline) await Bun.sleep(25);
      expect(prompts.length).toBe(1);
      expect(resumed).toEqual([]);
    } finally { await app.close(); }
  });
}, 30_000);

test("the docs say a 1 sent before the row shows still continues", async () => {
  const read = async (file: string) => (await readFile(path.join(import.meta.dir, "..", "docs", file), "utf8")).replace(/\s+/g, " ");
  expect(await read("SESSIONS.md")).toContain("even when typed and sent before the row shows: Casper waits a moment for the row first.");
  expect(await read("TERMINAL_UX.md")).toContain(`a lone \`1\` on the empty prompt runs \`/continue\` (sent before the row shows, it waits up to ${EARLY_ONE_WAIT_MS / 1000} s for it)`);
});

test("at the start, a short line asking to go back runs /continue; anything longer, pasted or later is a request", () => {
  for (const line of ["continue", "Continue session", "continue the last conversation", "resume", "resume my last session",
    "pick up where we left off", "go back to the previous conversation", "please continue the last session.", "continue last chat!"]) {
    expect({ line, back: continueWords(line) }).toEqual({ line, back: true });
  }
  for (const line of ["continue the refactor", "continue fixing the tests", "resume the download", "continue session and fix the bug",
    "continue session, then add tests", "go back", "open", "1", "what did we do last session?"]) {
    expect({ line, back: continueWords(line) }).toEqual({ line, back: false });
  }
  // A pasted line is not one the person typed.
  expect(continueWords("continue session", ["continue session"])).toBe(false);
});

for (const words of ["continue session", "pick up where we left off"]) {
  test(`"${words}" as the first line, while the continue row is offered, continues the last conversation`, async () => {
    const resumed: Array<[string, unknown]> = [];
    const prompts: string[] = [];
    await withEnv({ TERM: "xterm-256color" }, async () => {
      const app = await richApp(project => withPrompts(runtime(() => EARLIER, resumed, project), prompts), { savedConversations: async () => EARLIER });
      try {
        await app.until(text => text.includes(ROW));
        app.input.write(`${words}\r`);
        await app.until(text => text.includes("Back in \"Fix the login bug\""));
        expect(app.screen()).toContain(`[session] "${words}" at the start: continuing that conversation, as 1 does.`);
        expect(resumed).toEqual([["b0b0b0b0-0000", { keepUnwritten: false }]]);
        expect(prompts).toEqual([]);
      } finally { await app.close(); }
    });
  }, 30_000);
}

test("later in a conversation, or with no earlier conversation, \"continue\" is an ordinary request", async () => {
  const resumed: Array<[string, unknown]> = [];
  const prompts: string[] = [];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => withPrompts(runtime(() => EARLIER, resumed, project), prompts), { savedConversations: async () => EARLIER });
    try {
      await app.until(text => text.includes(ROW));
      app.input.write("explain the notes\r");
      await app.until(() => prompts.length === 1);
      app.input.write("continue\r");
      await app.until(() => prompts.length === 2);
      expect(prompts[1]).toContain("continue");
      expect(resumed).toEqual([]);
      // Idle again before closing: on Windows a request still writing keeps the test home busy for its cleanup.
      await app.until(text => text.lastIndexOf("idle") > text.lastIndexOf("continue"));
    } finally { await app.close(); }
  });
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const empty: string[] = [];
    const app = await richApp(project => withPrompts(runtime(() => [], resumed, project), empty), { savedConversations: async () => [] });
    try {
      await app.until(text => text.includes("idle"));
      app.input.write("continue session\r");
      const deadline = Date.now() + 15_000;
      while (!empty.length && Date.now() < deadline) await Bun.sleep(25);
      expect(empty.length).toBe(1);
      expect(resumed).toEqual([]);
      await app.until(text => text.lastIndexOf("idle") > text.lastIndexOf("continue session"));
    } finally { await app.close(); }
  });
}, 45_000);

test("a request to continue a session, even in two words, tells the AI it can't switch and what the person types", () => {
  for (const request of ["continue session", "resume the conversation", "continue our chat"]) expect({ request, named: continueNamed(request) }).toEqual({ request, named: true });
});
