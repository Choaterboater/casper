import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentRuntime, RuntimeConversation, RuntimeConversationHit } from "../src/runtime/types";
import { conversationLabel, matchConversation, requestOf } from "../src/sessions/resume";
import { searchConversationTexts } from "../src/sessions/search";
import { richApp } from "./support/app";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const now = Date.parse("2026-10-04T12:00:00Z");
const saved: RuntimeConversation[] = [
  { id: "a1b2c3d4-0000", name: "Fix the login bug", modified: "2026-10-04T09:00:00Z", messages: 12 },
  { id: "a1ffffff-0000", modified: "2026-10-01T12:00:00Z", firstMessage: "Casper initial classification\n\nUser request:\nadd a dark mode\n\nPlan", messages: 4 },
];

test("an ID prefix picks one conversation; an unknown or shared prefix says so", () => {
  expect(matchConversation(saved, "a1b2")).toEqual(saved[0]);
  expect(matchConversation(saved, "a1ffffff-0000")).toEqual(saved[1]);
  expect(() => matchConversation(saved, "a1")).toThrow("matches 2 conversations");
  expect(() => matchConversation(saved, "zz")).toThrow("No saved conversation starts with zz");
});

test("a conversation reads as its title (or first request), when, and how many messages", () => {
  expect(conversationLabel(saved[0]!, now)).toEqual({ title: "Fix the login bug", detail: "3h ago · 12 messages" });
  expect(conversationLabel(saved[1]!, now)).toEqual({ title: "add a dark mode", detail: "3 days ago · 4 messages" });
  expect(requestOf("plain words")).toBe("plain words");
});

type Search = (words: readonly string[], options?: { secretValues?: readonly string[]; signal?: AbortSignal }) => Promise<RuntimeConversationHit[]>;

function runtime(resumed: string[], project: string, searchConversations?: Search): AgentRuntime {
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
        listConversations: async () => [{ id: "current", modified: new Date().toISOString(), messages: 2 }, ...saved],
        resumeConversation: async (id: string) => { resumed.push(id); },
        ...(searchConversations ? { searchConversations } : {}),
        recentTurns: () => [{ role: "user" as const, text: "Casper initial classification\n\nUser request:\nfix the login bug" },
          { role: "assistant" as const, text: "I changed auth.ts so the session cookie is kept.\nAll tests pass." }],
      };
    },
    async dispose() {},
  };
}

test("/resume is a numbered picker (1 stays here); after resuming the last turns show", async () => {
  const resumed: string[] = [];
  const app = await richApp(project => runtime(resumed, project));
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("/resume\r");
    await app.until(text => text.includes("Fix the login bug"));
    expect(app.screen()).toContain("❯ 1. Stay in this conversation");
    expect(app.screen()).toContain("  2. Fix the login bug");
    expect(app.screen()).not.toContain("a1b2c3d4-0000  ");
    app.input.write("2");
    await app.until(text => text.includes("I changed auth.ts"));
    expect(resumed).toEqual(["a1b2c3d4-0000"]);
    expect(app.screen()).toContain("you  fix the login bug");
    app.input.write("/resume a1ff\r");
    await app.until(() => resumed.length === 2);
    expect(resumed[1]).toBe("a1ffffff-0000");
  } finally { await app.close(); }
}, 30_000);

test("/resume <words> searches every saved conversation's text: a numbered picker of the matches, 1 stays here", async () => {
  const resumed: string[] = [];
  const searched: string[][] = [];
  const passed: Array<{ secretValues?: readonly string[]; signal?: AbortSignal } | undefined> = [];
  const texts: Record<string, string> = { "current": "the login cookie in this one", "a1b2c3d4-0000": "The session Cookie expired; I fixed the login check in auth.ts.", "a1ffffff-0000": "add a dark mode" };
  const search: Search = async (words, options) => {
    searched.push([...words]);
    passed.push(options);
    return searchConversationTexts([{ id: "current", modified: new Date().toISOString(), messages: 2 }, ...saved].map(item => ({ ...item, text: texts[item.id]! })), words, { env: {} });
  };
  // A saved network login: Casper's own values reach the search, which hides them.
  const login = "fixture-login-token-0123";
  const app = await richApp(project => runtime(resumed, project, search), {},
    { homeFiles: { ".casper/network-logins.json": JSON.stringify({ mist: { MIST_API_TOKEN: login } }) } });
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("/resume LOGIN cookie\r");
    await app.until(text => text.includes("newest match first"));
    expect(searched).toEqual([["login", "cookie"]]);
    expect(passed[0]?.secretValues).toContain(login);
    // Esc stops a long search.
    expect(passed[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(app.screen()).toContain("❯ 1. Stay in this conversation");
    // The one you are in is not offered; the match shows its excerpt.
    expect(app.screen()).toContain("  2. Fix the login bug");
    expect(app.screen()).toContain("The session Cookie expired; I fixed the login check");
    expect(app.screen()).not.toContain("  3. ");
    app.input.write("2");
    await app.until(() => resumed.length === 1);
    expect(resumed).toEqual(["a1b2c3d4-0000"]);
    // An ID's start that matches stays an ID: no search.
    app.input.write("/resume a1ff\r");
    await app.until(() => resumed.length === 2);
    expect(resumed[1]).toBe("a1ffffff-0000");
    expect(searched.length).toBe(1);
    await app.until(text => text.includes('Back in "add a dark mode"') && text.lastIndexOf('Back in "add a dark mode"') < text.lastIndexOf("Ready: nothing is running"));
    // Hex that is no ID's start is searched like any word.
    app.input.write("/resume decaf\r");
    await app.until(text => text.includes("No saved conversation here mentions decaf."));
    expect(searched.at(-1)).toEqual(["decaf"]);
    app.input.write("/resume decaf words\r");
    await app.until(text => text.includes("No saved conversation here mentions decaf words."));
    expect(searched.at(-1)).toEqual(["decaf", "words"]);
    expect(resumed.length).toBe(2);
  } finally { await app.close(); }
}, 30_000);
