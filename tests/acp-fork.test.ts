import { describe, expect, test } from "bun:test";
import { forkConversation, initializeResult, markOf } from "../src/acp/session";
import { RPC } from "../src/acp/rpc";

// An ACP app forks a Casper conversation (decision 97): the mark a prompt reply carries, and the errors session/fork
// answers with. The whole flow runs against a real `casper acp` in tests/acp-fork.integration.test.ts.

const refusal = (reply: Promise<unknown>) => reply.then(() => undefined, (error: { code: number; message: string }) => ({ code: error.code, message: error.message }));
const INFO = { cwd: "/project", sessionId: "copy", sessionFile: "/sessions/copy.jsonl" };

describe("an ACP app forks a Casper conversation (decision 97)", () => {
  test("initialize advertises sessionCapabilities.fork, whatever acp_mcp says", () => {
    for (const setting of ["on", "ask", "off"] as const) expect(initializeResult(setting)).toMatchObject({ agentCapabilities: { sessionCapabilities: { fork: {} } } });
  });

  test("The mark is the conversation's last entry, and there is none for a runtime with no marks or an empty conversation", () => {
    expect(markOf({ conversationMark: () => "a1b2c3d4" })).toBe("a1b2c3d4");
    expect(markOf({})).toBeUndefined();
    expect(markOf(undefined)).toBeUndefined();
    expect(markOf({ conversationMark: () => null })).toBeUndefined();
    expect(markOf({ conversationMark: () => { throw new Error("no conversation"); } })).toBeUndefined();
  });

  test("A fork passes the source and the mark to the runtime and answers with the copy", async () => {
    const asked: Array<[string, string | undefined]> = [];
    const session = { forkAt: async (source: string, at?: string) => { asked.push([source, at]); return INFO; } };
    expect(await forkConversation(session, "source", "a1b2c3d4", "/project")).toEqual(INFO);
    expect(await forkConversation(session, "source", undefined, "/project")).toEqual(INFO);
    expect(asked).toEqual([["source", "a1b2c3d4"], ["source", undefined]]);
  });

  test("An unknown conversation is not found, an unknown mark is invalid params, and a runtime with no fork is method not found", async () => {
    expect(await refusal(forkConversation({ forkAt: async () => "unknown conversation" as const }, "gone", undefined, "/project")))
      .toEqual({ code: RPC.notFound, message: "No saved conversation gone in /project" });
    expect(await refusal(forkConversation({ forkAt: async () => "unknown mark" as const }, "source", "ffffffff", "/project")))
      .toEqual({ code: RPC.invalidParams, message: "No point ffffffff in conversation source" });
    const none = await refusal(forkConversation({}, "source", undefined, "/project"));
    expect(none?.code).toBe(RPC.methodNotFound);
    expect(none?.message).toContain("session/load");
  });
});
