import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { startAcp, until, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { cleanUpAfterEach, fixture, lastUser, type Payload, type Step } from "./support/scripting";

// session/list, session/resume and session/close (decision 114), against a real `casper acp` router, its session
// children and the scripted provider.
const clients: AcpClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close().catch(() => {}); });
cleanUpAfterEach();
const open = (...args: Parameters<typeof startAcp>) => { const client = startAcp(...args); clients.push(client); return client; };

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fake-acp-client", version: "1" } };
const text = (words: string) => [{ type: "text", text: words }];
const refusal = (reply: Promise<unknown>) => reply.then(() => undefined, (error: { code: number }) => error.code);
const isChecklistCall = (payload: Payload) => JSON.stringify(payload.messages).includes("Casper checklist.");
type Info = { sessionId: string; cwd: string; title: string | null; updatedAt: string };
const titles = (client: AcpClient, sessionId: string) => client.updates
  .filter((update) => update.sessionId === sessionId && update.update.sessionUpdate === "session_info_update").map((update) => update.update.title as string);
const replayed = (client: AcpClient, sessionId: string) => client.updates.filter((update) => update.sessionId === sessionId && update.update.sessionUpdate === "user_message_chunk");
/** Where the first line from `from` on that passes `check` is in what the agent wrote, or -1. */
const replyLine = (client: AcpClient, from: number, check: (message: Record<string, any>) => boolean) =>
  client.lines.findIndex((line, index) => index >= from && check(JSON.parse(line) as Record<string, any>));

describe("an ACP app lists, resumes and closes Casper sessions (decision 114)", () => {
  test("session/list gives the folder's saved conversations newest first with their chat titles, a secret hidden, and leaves out an unused one", async () => {
    const value = "acp-list-secret-7d3e9a1c";
    const f = await fixture((_request, payload): Step => isChecklistCall(payload) ? { text: "[]" } : { text: "Done." });
    execFileSync("git", ["init", "-q"], { cwd: f.project, env: f.env });
    const sub = path.join(f.project, "sub");
    await mkdir(sub);
    const client = open(f, [], { DEMO_API_KEY: value });
    await client.request("initialize", INIT);
    // Nothing saved yet.
    expect(await client.request("session/list", { cwd: f.project })).toEqual({ sessions: [] });
    const first = (await client.request("session/new", { cwd: f.project, mcpServers: [] })).sessionId as string;
    expect((await client.request("session/prompt", { sessionId: first, prompt: text("Explain the parser module") })).stopReason).toBe("end_turn");
    const second = (await client.request("session/new", { cwd: f.project, mcpServers: [] })).sessionId as string;
    expect((await client.request("session/prompt", { sessionId: second, prompt: text(`Check the deploy key ${value}`) })).stopReason).toBe("end_turn");
    // Opened and never used: not listed.
    const unused = (await client.request("session/new", { cwd: f.project, mcpServers: [] })).sessionId as string;
    await until(() => titles(client, first).length && titles(client, second).length, 30_000, "both chat titles");
    const asked = f.payloads.length;

    const listed = await client.request("session/list", { cwd: f.project });
    const sessions = listed.sessions as Info[];
    expect(sessions.map((item) => item.sessionId)).toEqual([second, first]);
    expect(sessions.map((item) => item.sessionId)).not.toContain(unused);
    expect(listed.nextCursor).toBeUndefined();
    for (const item of sessions) {
      expect(item.cwd).toBe(f.project);
      expect(Number.isNaN(Date.parse(item.updatedAt))).toBe(false);
      // The same title the session sent as its chat's (decision 96).
      expect(item.title).toBe(titles(client, item.sessionId)[0]!);
    }
    expect(sessions[0]!.title).toBeTruthy();
    expect(JSON.stringify(listed)).not.toContain(value);
    // A subfolder of the project lists the conversations a session opened there would find, with its own folder.
    const fromSub = await client.request("session/list", { cwd: sub });
    expect((fromSub.sessions as Info[]).map((item) => [item.sessionId, item.cwd])).toEqual([[second, sub], [first, sub]]);
    // No cwd is the folder casper acp started in; a folder that is not there has nothing.
    expect(((await client.request("session/list", {})).sessions as Info[]).map((item) => item.sessionId)).toEqual([second, first]);
    expect(await client.request("session/list", { cwd: path.join(f.project, "gone") })).toEqual({ sessions: [] });
    expect(await refusal(client.request("session/list", { cwd: f.project, cursor: "not a cursor" }))).toBe(-32602);
    // Listing called no model.
    expect(f.payloads.length).toBe(asked);
  }, childTestLimit(1));

  test("session/close stops a running prompt, whose cancelled reply comes first, ends the session, and session/resume opens it again at Ask first with no replay", async () => {
    const reached = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const f = await fixture(async (_request, payload): Promise<Step> => {
      if (isChecklistCall(payload)) return { text: "[]" };
      if (lastUser(payload).includes("Wait here")) { reached.resolve(); await released.promise; }
      return { text: "Done." };
    });
    try {
      const client = open(f);
      await client.request("initialize", INIT);
      const sessionId = (await client.request("session/new", { cwd: f.project, mcpServers: [] })).sessionId as string;
      expect((await client.request("session/prompt", { sessionId, prompt: text("Remember MARKER_BEFORE_CLOSE") })).stopReason).toBe("end_turn");
      // What this session allowed for itself: Don't ask.
      await client.request("session/set_mode", { sessionId, modeId: "full" });
      // A session/resume of a conversation that is open is refused.
      expect(await refusal(client.request("session/resume", { sessionId, cwd: f.project }))).toBe(-32600);

      const waiting = client.request("session/prompt", { sessionId, prompt: text("Wait here") });
      await reached.promise;
      const before = client.lines.length;
      expect(await client.request("session/close", { sessionId })).toEqual({});
      expect((await waiting).stopReason).toBe("cancelled");
      // The prompt's cancelled reply was written before the close's.
      const promptReply = replyLine(client, before, (message) => message.result?.stopReason === "cancelled");
      const closeReply = replyLine(client, before, (message) => message.method === undefined && JSON.stringify(message.result) === "{}");
      expect(promptReply).toBeGreaterThan(-1);
      expect(closeReply).toBeGreaterThan(promptReply);
      // From then on the session is unknown.
      expect(await refusal(client.request("session/prompt", { sessionId, prompt: text("Still there?") }))).toBe(-32002);
      expect(await refusal(client.request("session/close", { sessionId }))).toBe(-32002);
      expect(await refusal(client.request("session/close", { sessionId: "not-a-session" }))).toBe(-32002);
      released.resolve();

      const resumed = await client.request("session/resume", { sessionId, cwd: f.project, mcpServers: [] });
      expect(resumed.sessionId).toBeUndefined();
      expect(resumed.configOptions.length).toBeGreaterThan(0);
      // A new process: what the closed one allowed ended with it (decision 91).
      expect(resumed.modes.currentModeId).toBe("ask");
      // The chat's title comes again from the new process, once, as after a load (decision 96).
      await until(() => titles(client, sessionId).length === 2, 30_000, "the resumed chat's title");
      expect(titles(client, sessionId)[1]).toBe(titles(client, sessionId)[0]!);
      // Nothing is replayed: the app still shows the conversation.
      expect(replayed(client, sessionId).filter((update) => update.update._meta?.casper?.steered !== true)).toEqual([]);
      expect((await client.request("session/prompt", { sessionId, prompt: text("Say AFTER_RESUME") })).stopReason).toBe("end_turn");
      const asked = f.payloads.find((payload) => lastUser(payload).includes("AFTER_RESUME"))!;
      expect(JSON.stringify(asked.messages)).toContain("MARKER_BEFORE_CLOSE");
      // A resume of a conversation Casper does not have is -32002, as a load's is.
      expect(await refusal(client.request("session/resume", { sessionId: "0000aaaa-0000-4000-8000-000000000000", cwd: f.project }))).toBe(-32002);
      expect(await client.close()).toBe(0);
    } finally { released.resolve(); }
  }, childTestLimit(1));

  test("a session/resume sent before session/close has answered waits until the closed process has gone", async () => {
    const reached = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const f = await fixture(async (_request, payload): Promise<Step> => {
      if (isChecklistCall(payload)) return { text: "[]" };
      if (lastUser(payload).includes("Wait here")) { reached.resolve(); await released.promise; }
      return { text: "Done." };
    });
    try {
      const client = open(f);
      await client.request("initialize", INIT);
      const sessionId = (await client.request("session/new", { cwd: f.project, mcpServers: [] })).sessionId as string;
      const waiting = client.request("session/prompt", { sessionId, prompt: text("Wait here") });
      await reached.promise;
      const before = client.lines.length;
      // The app does not wait for the close's reply before it reopens the conversation.
      const closed = client.request("session/close", { sessionId });
      const resumed = client.request("session/resume", { sessionId, cwd: f.project, mcpServers: [] });
      expect(await closed).toEqual({});
      expect((await resumed).modes.currentModeId).toBe("ask");
      expect((await waiting).stopReason).toBe("cancelled");
      const closeReply = replyLine(client, before, (message) => message.method === undefined && JSON.stringify(message.result) === "{}");
      const resumeReply = replyLine(client, before, (message) => message.method === undefined && Array.isArray(message.result?.configOptions));
      expect(closeReply).toBeGreaterThan(-1);
      expect(resumeReply).toBeGreaterThan(closeReply);
      released.resolve();
      expect((await client.request("session/prompt", { sessionId, prompt: text("Say AFTER_RESUME") })).stopReason).toBe("end_turn");
      expect(await client.close()).toBe(0);
    } finally { released.resolve(); }
  }, childTestLimit(1));
});
