import { afterEach, describe, expect, test } from "bun:test";
import { startAcp, until, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { afterTool, cleanUpAfterEach, fixture, lastUser, shellCheckTest, type Payload, type Step } from "./support/scripting";
import { BackgroundCommands } from "../src/runtime/background-commands";
import { backgroundTasks } from "../src/app/task-tools";
import { idleReply, type IdleHost } from "../src/acp/session";
import { removeTempDir } from "./support/temp-dir";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// `_casper/idle` (decision 91): whether an app may close a Casper that sits idle, against a real `casper acp` router,
// its session children and the scripted provider.
const clients: AcpClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close().catch(() => {}); });
cleanUpAfterEach();
const open = (...args: Parameters<typeof startAcp>) => { const client = startAcp(...args); clients.push(client); return client; };

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fake-acp-client", version: "1" } };
const text = (words: string) => [{ type: "text", text: words }];
const isChecklistCall = (payload: Payload) => JSON.stringify(payload.messages).includes("Casper checklist.");
const idle = (client: AcpClient, sessionId: string) => client.request("_casper/idle", { sessionId });
const refusal = (reply: Promise<unknown>) => reply.then(() => undefined, (error: { code: number }) => error.code);
type Option = { id: string; currentValue: string };
const modelOf = (options: Option[]) => options.find((option) => option.id === "model")?.currentValue;

async function session(client: AcpClient, folder: string): Promise<string> {
  await client.request("initialize", INIT);
  return (await client.request("session/new", { cwd: folder, mcpServers: [] })).sessionId as string;
}

/** A scripted response that waits: `reached` once its request arrives, and it answers once `release` is called. */
function held() {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return { reached: reached.promise, release: () => released.resolve(), wait: async () => { reached.resolve(); await released.promise; } };
}

describe("an app may close an idle Casper (decision 91)", () => {
  test("After a prompt ends Casper says it is idle", async () => {
    const f = await fixture(() => ({ text: "Hello." }));
    const client = open(f);
    const sessionId = await session(client, f.project);
    // A session that has done nothing yet is idle too.
    expect(await idle(client, sessionId)).toEqual({ idle: true, running: [] });
    expect((await client.request("session/prompt", { sessionId, prompt: text("Say hello") })).stopReason).toBe("end_turn");
    expect(await idle(client, sessionId)).toEqual({ idle: true, running: [] });
  }, childTestLimit(1));

  shellCheckTest("A background command still running is reported as a command, without its text or a secret", async () => {
    const value = "acp-idle-secret-5c1e8d";
    const command = `sleep 60 # ${value}`;
    const f = await fixture((_request, payload): Step => isChecklistCall(payload) ? { text: "[]" } : afterTool(payload) ? { text: "Started it." }
      : lastUser(payload).includes("Start the job") ? { tools: [{ name: "bash", args: { command, background: true } }] } : { text: "Done." });
    const client = open(f, [], { DEMO_API_KEY: value });
    const sessionId = await session(client, f.project);
    // Where commands are asked about (Windows has no sandbox), the app allows this one.
    client.answerPermissions((params) => ({ optionId: (params.options as Array<{ kind: string; optionId: string }>).find((choice) => choice.kind === "allow_once")!.optionId }));
    expect((await client.request("session/prompt", { sessionId, prompt: text("Start the job") })).stopReason).toBe("end_turn");
    const reply = await idle(client, sessionId);
    expect(reply).toEqual({ idle: false, running: ["command"] });
    // Only the kind: never the command, its id, a path or the secret.
    const wire = JSON.stringify(client.lines.filter((line) => line.includes('"running"')));
    for (const word of ["sleep", value, "cmd-1", f.project]) expect(wire).not.toContain(word);
  }, childTestLimit(1));

  test("A finished command whose note is still being written keeps Casper not idle", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "casper-acp-idle-note-"));
    try {
      const writing = held();
      const ended = Promise.withResolvers<{ exitCode: number | null }>();
      const commands = new BackgroundCommands({ notify: () => writing.wait() });
      const app = { backgroundCommands: commands, subagents: { isBusy: false, runs: () => [] } } as unknown as IdleHost & Parameters<typeof backgroundTasks>[0];
      app.backgroundTasks = () => backgroundTasks(app);
      const state = { busy: false, changing: false };
      commands.adopt({ command: "sleep 1", startedAt: Date.now(), output: "", done: ended.promise, stop: () => {} });
      expect(await idleReply(app, state, home)).toEqual({ idle: false, running: ["command"] });
      ended.resolve({ exitCode: 0 });
      // It has left the list, and its note for the AI is not written yet: still a command.
      await writing.reached;
      expect(commands.list()).toEqual([]);
      expect(commands.notifying()).toBe(1);
      expect(await idleReply(app, state, home)).toEqual({ idle: false, running: ["command"] });
      writing.release();
      await until(() => commands.notifying() === 0, 5_000, "the note to be written");
      expect(await idleReply(app, state, home)).toEqual({ idle: true, running: [] });
      await commands.close();
    } finally { await removeTempDir(home); }
  });

  test("During a prompt the reply is busy", async () => {
    const slow = held();
    const f = await fixture(async (_request, payload): Promise<Step> => {
      if (isChecklistCall(payload)) return { text: "[]" };
      await slow.wait();
      return { text: "Done." };
    });
    const client = open(f);
    const sessionId = await session(client, f.project);
    const done = client.request("session/prompt", { sessionId, prompt: text("Tell me about this folder") });
    await slow.reached;
    expect(await idle(client, sessionId)).toEqual({ idle: false, running: [], reason: "busy" });
    slow.release();
    expect((await done).stopReason).toBe("end_turn");
    expect(await idle(client, sessionId)).toEqual({ idle: true, running: [] });
  }, childTestLimit(1));

  test("The router routes to the right session and answers an unknown one with -32002", async () => {
    const slow = held();
    const f = await fixture(async (_request, payload): Promise<Step> => {
      if (isChecklistCall(payload)) return { text: "[]" };
      if (lastUser(payload).includes("Wait here")) await slow.wait();
      return { text: "Done." };
    });
    const client = open(f);
    const busy = await session(client, f.project);
    const quiet = (await client.request("session/new", { cwd: f.project, mcpServers: [] })).sessionId as string;
    const done = client.request("session/prompt", { sessionId: busy, prompt: text("Wait here") });
    await slow.reached;
    expect(await idle(client, busy)).toEqual({ idle: false, running: [], reason: "busy" });
    expect(await idle(client, quiet)).toEqual({ idle: true, running: [] });
    expect(await refusal(idle(client, "not-a-session"))).toBe(-32002);
    expect(await refusal(client.request("_casper/idle", {}))).toBe(-32002);
    slow.release();
    expect((await done).stopReason).toBe("end_turn");
  }, childTestLimit(1));

  test("After close and load, the receipt and model are the conversation's", async () => {
    const f = await fixture(() => ({ text: "Done." }));
    const client = open(f);
    const sessionId = await session(client, f.project);
    await client.request("session/set_config_option", { sessionId, configId: "model", value: "fixture/second" });
    expect((await client.request("session/prompt", { sessionId, prompt: text("Remember MARKER_BEFORE_CLOSE") })).stopReason).toBe("end_turn");
    // Another session sets the saved default back, as another conversation in the app would.
    const other = (await client.request("session/new", { cwd: f.project, mcpServers: [] })).sessionId as string;
    await client.request("session/set_config_option", { sessionId: other, configId: "model", value: "fixture/first" });
    // Idle: the app closes this Casper.
    expect(await idle(client, sessionId)).toEqual({ idle: true, running: [] });
    expect(await client.close()).toBe(0);

    // The app reopens Casper with its own start model and loads the conversation for the next prompt.
    const again = open(f, ["--model", "fixture/first"]);
    await again.request("initialize", INIT);
    const loaded = await again.request("session/load", { sessionId, cwd: f.project, mcpServers: [] });
    expect(modelOf(loaded.configOptions)).toBe("fixture/second");
    const done = await again.request("session/prompt", { sessionId, prompt: text("Say AFTER_LOAD") });
    expect(done.stopReason).toBe("end_turn");
    const asked = f.payloads.find((payload) => lastUser(payload).includes("AFTER_LOAD"))!;
    // The request goes on from the conversation, on its model, and the receipt counts this prompt's response.
    expect(asked.model).toBe("second");
    expect(JSON.stringify(asked.messages)).toContain("MARKER_BEFORE_CLOSE");
    expect(done._meta.casper.receipt.usage.turns).toBeGreaterThanOrEqual(1);
    expect(await idle(again, sessionId)).toEqual({ idle: true, running: [] });
  }, childTestLimit(2));
});
