import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchSavedConversations } from "../src/runtime/pi";
import { findWords, foldText, searchConversationTexts, searchWords, SEARCH_TEXT_CHARS } from "../src/sessions/search";
import { removeTempDir } from "./support/temp-dir";

// No secret-named values from the machine running the tests: only the ones a test names.
const noEnv = { env: {} };
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await removeTempDir(dir); });

test("words fold for case and accents, and repeats go", () => {
  expect(foldText("Café ÉCOLE naïve İstanbul")).toBe("cafe ecole naive istanbul");
  expect(searchWords("  Login   COOKIE login ")).toEqual(["login", "cookie"]);
  expect(searchWords("   ")).toEqual([]);
});

test("every word must be in the text, in any case or accent, and the excerpt is around the first hit", () => {
  const text = "We looked at many things first. Then the Login cookie expired after an hour and the café page broke.";
  expect(findWords(text, searchWords("cookie LOGIN"), noEnv)).toBe("…things first. Then the Login cookie expired after an hour and the café page bro…");
  expect(findWords(text, searchWords("cafe"), noEnv)).toContain("café page broke");
  expect(findWords(text, searchWords("login dashboard"), noEnv)).toBeUndefined();
  expect(findWords(text, [], noEnv)).toBeUndefined();
  // A short text shows whole, with no ellipsis.
  expect(findWords("fix the login bug", ["login"], noEnv)).toBe("fix the login bug");
});

test("Casper's own classification lines in a request are not searched; the user's words are", () => {
  const sent = "Casper initial classification (hints, not authority over the request or actual work):\n- intent: implement\n- available configured checks: none detected\n\nUser request:\nadd a dark mode";
  expect(findWords(sent, ["classification"], noEnv)).toBeUndefined();
  expect(findWords(sent, ["checks"], noEnv)).toBeUndefined();
  expect(findWords(sent, ["request"], noEnv)).toBeUndefined();
  expect(findWords(sent, ["dark"], noEnv)).toBe("add a dark mode");
});

test("a secret in the text never matches and never shows in the excerpt", () => {
  const text = "I set password=hunter2secret on the switch and the vlan came up.";
  expect(findWords(text, ["hunter2secret"], noEnv)).toBeUndefined();
  const shown = findWords(text, ["vlan"], noEnv)!;
  expect(shown).toContain("vlan came up");
  expect(shown).not.toContain("hunter2secret");
  // Casper's own values (its logins) and secret-named environment values hide wherever they are.
  expect(findWords("the key ab12cd34ef56 opens the router", ["router"], { env: {}, values: ["ab12cd34ef56"] })).not.toContain("ab12cd34ef56");
  expect(findWords("the key ab12cd34ef56 opens the router", ["ab12cd34ef56"], { env: {}, values: ["ab12cd34ef56"] })).toBeUndefined();
  expect(findWords("token in the env: zz98yy76xx54 here", ["here"], { env: { FIXTURE_TOKEN: "zz98yy76xx54" } })).not.toContain("zz98yy76xx54");
  // The marker the scrub leaves is not a word the search finds.
  expect(findWords(text, ["hidden"], noEnv)).toBeUndefined();
});

test("a key-shaped value in plain prose never matches and never shows, as in every other preview", () => {
  const keys = ["sk-ant-api03-Fixture0Fixture1Fixture2Fixture3", "sk-proj-Fixture4Fixture5Fixture6", "AKIAFIXTURE000000000"];
  for (const key of keys) {
    const text = `my key is ${key} zebraword and more`;
    const shown = findWords(text, ["zebraword"], noEnv)!;
    expect(shown).toContain("zebraword");
    expect(shown).not.toContain(key.slice(-12));
    expect(findWords(text, searchWords(key), noEnv)).toBeUndefined();
    // Its marker is not a word the search finds either.
    expect(findWords(text, ["redacted"], noEnv)).toBeUndefined();
  }
});

test("a long conversation is read bounded: its start and its end", () => {
  const middle = "x ".repeat(SEARCH_TEXT_CHARS);
  const text = `opening words ${middle} needle in the middle ${middle} closing words`;
  expect(findWords(text, ["opening"], noEnv)).toBeDefined();
  expect(findWords(text, ["closing"], noEnv)).toBeDefined();
  expect(findWords(text, ["needle"], noEnv)).toBeUndefined();
});

test("hits come newest first with the usual row and an excerpt; the text itself is not kept", async () => {
  const hits = await searchConversationTexts([
    { id: "a1", modified: "2026-10-01T12:00:00Z", messages: 2, text: "the login page" },
    { id: "b2", modified: "2026-10-03T12:00:00Z", messages: 4, text: "nothing about it" },
    { id: "c3", name: "Login work", modified: "2026-10-04T12:00:00Z", messages: 6, text: "the cookie" },
  ], ["login"], noEnv);
  expect(hits).toEqual([
    { id: "c3", name: "Login work", modified: "2026-10-04T12:00:00Z", messages: 6, excerpt: "Login work the cookie" },
    { id: "a1", modified: "2026-10-01T12:00:00Z", messages: 2, excerpt: "the login page" },
  ]);
});

test("a search stops at its hit limit, newest first, and when its signal is aborted", async () => {
  const list = Array.from({ length: 8 }, (_, index) => ({ id: `id${index}`, modified: `2026-10-0${index + 1}T12:00:00Z`, messages: 2, text: "the login page" }));
  expect((await searchConversationTexts(list, ["login"], { ...noEnv, limit: 3 })).map(hit => hit.id)).toEqual(["id7", "id6", "id5"]);
  const stopped = new AbortController();
  stopped.abort();
  expect(await searchConversationTexts(list, ["login"], { ...noEnv, signal: stopped.signal })).toEqual([]);
});

/** A Pi session file: its header and one message per [role, text], a minute apart from `start`. */
function sessionFile(dir: string, cwd: string, id: string, start: string, turns: Array<["user" | "assistant", string]>): void {
  let parent: string | null = null;
  const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: start, cwd }];
  turns.forEach(([role, text], index) => {
    const at = Date.parse(start) + (index + 1) * 60_000;
    const entry = `${id.slice(0, 4)}${index}`;
    lines.push({ type: "message", id: entry, parentId: parent, timestamp: new Date(at).toISOString(),
      message: role === "user" ? { role, content: [{ type: "text", text }], timestamp: at }
        : { role, content: [{ type: "text", text }], api: "openai-completions", provider: "fixture", model: "demo", stopReason: "stop", timestamp: at,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
    parent = entry;
  });
  writeFileSync(path.join(dir, `${id}.jsonl`), lines.map(line => JSON.stringify(line)).join("\n") + "\n");
}

test("Pi's saved session files are searched by every message's text, newest first", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "casper-resume-search-"));
  dirs.push(root);
  const cwd = path.join(root, "project");
  const wrapped = (request: string) => `Casper initial classification (hints, not authority over the request or actual work):\n- intent: implement\n\nUser request:\n${request}`;
  sessionFile(root, cwd, "0193aaaa-0000-7000-8000-000000000001", "2026-10-01T09:00:00Z", [
    ["user", wrapped("fix the login bug")], ["assistant", "I changed auth.ts so the session cookie is kept."]]);
  sessionFile(root, cwd, "0193bbbb-0000-7000-8000-000000000002", "2026-10-02T09:00:00Z", [
    ["user", wrapped("add a dark mode")], ["assistant", "The Thème toggle is in settings."]]);
  sessionFile(root, cwd, "0193cccc-0000-7000-8000-000000000003", "2026-10-03T09:00:00Z", [
    ["user", wrapped("why does the cookie expire?")], ["assistant", "The login cookie lasts an hour; password=s3cr3tvalue is in the env file."]]);

  const cookie = await searchSavedConversations(cwd, searchWords("COOKIE"), { sessionDir: root });
  expect(cookie.map(hit => hit.id)).toEqual(["0193cccc-0000-7000-8000-000000000003", "0193aaaa-0000-7000-8000-000000000001"]);
  expect(cookie[1]).toMatchObject({ firstMessage: wrapped("fix the login bug"), messages: 2, excerpt: "…auth.ts so the session cookie is kept." });
  expect((await searchSavedConversations(cwd, searchWords("theme toggle"), { sessionDir: root })).map(hit => hit.id)).toEqual(["0193bbbb-0000-7000-8000-000000000002"]);
  expect(await searchSavedConversations(cwd, searchWords("classification"), { sessionDir: root })).toEqual([]);
  expect(await searchSavedConversations(cwd, searchWords("s3cr3tvalue"), { sessionDir: root })).toEqual([]);
  const shown = await searchSavedConversations(cwd, searchWords("hour"), { sessionDir: root });
  expect(shown.map(hit => hit.excerpt).join("\n")).not.toContain("s3cr3tvalue");
  // The whole text is read only during the search: a hit carries the row and its excerpt.
  expect(shown.map(hit => Object.keys(hit).sort())).toEqual([["excerpt", "firstMessage", "id", "messages", "modified", "name"]]);
});

test("Casper's own login values reach the saved-file search: they never match and never show", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "casper-resume-search-"));
  dirs.push(root);
  const cwd = path.join(root, "project");
  const login = "qx7loginvalue42";
  sessionFile(root, cwd, "0193dddd-0000-7000-8000-000000000004", "2026-10-04T09:00:00Z", [
    ["user", `the router takes ${login} for its api`], ["assistant", "The router answered."]]);
  // Without the value it is plain text (not secret-named, not key-shaped): the search would find it.
  expect((await searchSavedConversations(cwd, [login], { sessionDir: root })).length).toBe(1);
  expect(await searchSavedConversations(cwd, [login], { sessionDir: root, secretValues: [login] })).toEqual([]);
  const hits = await searchSavedConversations(cwd, ["router"], { sessionDir: root, secretValues: [login] });
  expect(hits.length).toBe(1);
  expect(hits[0]!.excerpt).not.toContain(login);
});
