import { describe, expect, test } from "bun:test";
import { cursorAfter, listSessions, LIST_PAGE, type ListSource } from "../src/acp/session-list";
import { initializeResult } from "../src/acp/session";
import type { RuntimeConversation } from "../src/runtime/types";

// session/list, session/resume and session/close (decision 114): the router's list from saved conversations, with no
// session process. The router and its children are driven end to end in tests/acp-sessions.integration.test.ts.
const FOLDER = "/work/project";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 12, minute)).toISOString();
const saved = (id: string, minute: number, more: Partial<RuntimeConversation> = {}): RuntimeConversation =>
  ({ id, modified: at(minute), firstMessage: `Request ${id}`, messages: 2, ...more });
const source = (list: RuntimeConversation[], more: Partial<ListSource> = {}): ListSource & { folders: string[] } => {
  const folders: string[] = [];
  return { folders, saved: async (folder) => { folders.push(folder); return list; }, secrets: () => [], ...more };
};
const refusal = (reply: Promise<unknown>) => reply.then(() => undefined, (error: { code: number; message: string }) => ({ code: error.code, message: error.message }));

describe("an ACP app lists, resumes and closes Casper sessions (decision 114)", () => {
  test("Initialize says Casper lists, resumes and closes sessions, and still forks, whatever acp_mcp says", () => {
    for (const setting of ["on", "ask", "off"] as const) {
      expect(initializeResult(setting)).toMatchObject({ agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {}, list: {}, resume: {}, close: {} } } });
    }
  });

  test("The list is the folder's saved conversations newest first, as SessionInfo: ID, the folder, the title /resume shows and the time", async () => {
    const from = source([
      saved("a1", 1, { name: "Fix the login page" }),
      saved("b2", 5, { firstMessage: "Casper initial classification (hints only)\n\nUser request:\nAdd a dark mode\n\nmore" }),
      saved("c3", 3, { firstMessage: "", name: undefined }),
    ]);
    const reply = await listSessions(FOLDER, undefined, from);
    expect(from.folders).toEqual([FOLDER]);
    expect(reply).toEqual({ sessions: [
      { sessionId: "b2", cwd: FOLDER, title: "Add a dark mode", updatedAt: at(5) },
      { sessionId: "c3", cwd: FOLDER, title: null, updatedAt: at(3) },
      { sessionId: "a1", cwd: FOLDER, title: "Fix the login page", updatedAt: at(1) },
    ] });
  });

  test("A conversation with no messages, a session opened and never used, is left out", async () => {
    const reply = await listSessions(FOLDER, undefined, source([saved("used", 2), saved("empty", 4, { messages: 0 })]));
    expect((reply.sessions as Array<{ sessionId: string }>).map((item) => item.sessionId)).toEqual(["used"]);
  });

  test("Pages follow nextCursor to the end with no conversation twice; the last page has no cursor", async () => {
    const list = Array.from({ length: 7 }, (_, index) => saved(`id${index}`, index % 3));
    const seen: string[] = [];
    let cursor: unknown;
    let pages = 0;
    do {
      const reply = await listSessions(FOLDER, cursor, source(list, { pageSize: 3 }));
      seen.push(...(reply.sessions as Array<{ sessionId: string }>).map((item) => item.sessionId));
      cursor = reply.nextCursor;
      pages++;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(["id2", "id5", "id1", "id4", "id0", "id3", "id6"]);
    expect(LIST_PAGE).toBe(50);
  });

  test("A conversation saved between pages does not repeat one the app already has", async () => {
    const list = [saved("old", 1), saved("mid", 2), saved("new", 3)];
    const first = await listSessions(FOLDER, undefined, source(list, { pageSize: 2 }));
    expect((first.sessions as Array<{ sessionId: string }>).map((item) => item.sessionId)).toEqual(["new", "mid"]);
    const next = await listSessions(FOLDER, first.nextCursor, source([saved("newest", 9), ...list], { pageSize: 2 }));
    expect(next).toEqual({ sessions: [{ sessionId: "old", cwd: FOLDER, title: "Request old", updatedAt: at(1) }] });
  });

  test("The cursor holds only a time and an ID, and a cursor that is not one is refused with -32602", async () => {
    const cursor = cursorAfter(saved("abc", 1, { name: "secret words", firstMessage: "a request" }));
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    expect(JSON.parse(text)).toEqual({ m: at(1), i: "abc" });
    for (const bad of ["not a cursor", 42, Buffer.from("{}").toString("base64url")]) {
      expect(await refusal(listSessions(FOLDER, bad, source([])))).toEqual({ code: -32602, message: "cursor must be a nextCursor from an earlier session/list reply" });
    }
    expect(await listSessions(FOLDER, null, source([]))).toEqual({ sessions: [] });
  });

  test("Casper's own secret values are hidden in a title, also where the title's cut falls inside one", async () => {
    const value = "list-title-secret-4f7a2c9e1b";
    const long = `${"word ".repeat(10)}${value} after`;
    const reply = await listSessions(FOLDER, undefined, source([
      saved("named", 2, { name: `Deploy with ${value}` }),
      saved("cut", 1, { firstMessage: long }),
    ], { secrets: () => [value] }));
    const titles = (reply.sessions as Array<{ title: string }>).map((item) => item.title);
    expect(titles[0]).toBe("Deploy with <secret hidden>");
    expect(titles[1]).toContain("<secret hidden>");
    for (const title of titles) expect(title).not.toContain(value.slice(0, 12));
  });

  test("A key-shaped value is hidden in a title with no list of values, and a failing secret read still lists", async () => {
    const key = `sk-ant-api03-${"A1b2C3d4".repeat(6)}`;
    const reply = await listSessions(FOLDER, undefined, source([saved("k", 1, { name: `use ${key}` })], { secrets: () => { throw new Error("unreadable"); } }));
    const [item] = reply.sessions as Array<{ title: string }>;
    expect(item!.title).not.toContain(key.slice(0, 20));
  });
});
