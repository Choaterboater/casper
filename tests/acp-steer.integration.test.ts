import { afterEach, expect } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startAcp, until, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { afterTool, cleanUpAfterEach, fixProject, fixture, lastUser, REVIEW, reviewOn, shellCheckTest, type Payload, type Step } from "./support/scripting";

// An app's line typed while Casper works (decision 86), against a real `casper acp` child and the scripted provider.
const clients: AcpClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close().catch(() => {}); });
cleanUpAfterEach();
const open = (...args: Parameters<typeof startAcp>) => { const client = startAcp(...args); clients.push(client); return client; };

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fake-acp-client", version: "1" } };
const text = (words: string) => [{ type: "text", text: words }];
const LINE = "ALSO_MENTION_PINEAPPLE";
const isChecklistCall = (payload: Payload) => JSON.stringify(payload.messages).includes("Casper checklist.");
const carries = (payload: Payload, words: string) => JSON.stringify(payload.messages).includes(words);
const ofSession = (client: AcpClient, sessionId: string) => client.updates.filter((update) => update.sessionId === sessionId).map((update) => update.update);
/** The read notices Casper sent: the app's own lines, as the model read them. */
const notices = (client: AcpClient, sessionId: string) => ofSession(client, sessionId).filter((update) => update.sessionUpdate === "user_message_chunk" && update._meta?.casper?.steered === true);
/** Where in the session's updates the first model words holding `words` are. */
const wordsAt = (client: AcpClient, sessionId: string, words: string) => ofSession(client, sessionId).findIndex((update) => update.sessionUpdate === "agent_message_chunk" && String(update.content?.text).includes(words));

/** A scripted response that waits: `reached` once its request arrives, and it answers once `release` is called. */
function held() {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return { reached: reached.promise, release: () => released.resolve(), wait: async () => { reached.resolve(); await released.promise; } };
}

async function session(client: AcpClient, folder: string): Promise<string> {
  await client.request("initialize", INIT);
  return (await client.request("session/new", { cwd: folder, mcpServers: [] })).sessionId as string;
}
const steer = (client: AcpClient, sessionId: string, prompt: unknown, messageId = "m1") => client.request("_casper/steer", { sessionId, prompt, messageId });
/** A 1x1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/** The user messages of a request that hold `words`: their words, and how many pictures go with each. */
function userMessagesWith(payload: Payload, words: string): Array<{ words: string; pictures: number }> {
  return payload.messages.filter((message) => message.role === "user").map((message) => {
    const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []) as Array<{ type: string; text?: string }>;
    return { words: parts.flatMap((part) => part.type === "text" ? [part.text ?? ""] : []).join("\n"), pictures: parts.filter((part) => part.type === "image_url").length };
  }).filter((message) => message.words.includes(words));
}

shellCheckTest("A steer during a slow step is taken, reaches the next request and is announced before that response's first words", async () => {
  const slow = held();
  const f = await fixture(async (_request, payload): Promise<Step> => {
    if (isChecklistCall(payload)) return { text: "[]" };
    if (carries(payload, LINE)) return { text: "SECOND_ANSWER." };
    await slow.wait();
    return { text: "FIRST_ANSWER." };
  });
  const client = open(f);
  const sessionId = await session(client, f.project);
  const done = client.request("session/prompt", { sessionId, prompt: text("Tell me about this folder") });
  await slow.reached;
  expect(await steer(client, sessionId, text(LINE))).toEqual({ steered: true, messageId: "m1" });
  slow.release();
  expect((await done).stopReason).toBe("end_turn");
  // The next request carries the line once; the app hears it was read before the words that answer it.
  const read = f.payloads.filter((payload) => carries(payload, LINE));
  expect(read.length).toBeGreaterThan(0);
  expect(JSON.stringify(read[0]!.messages).split(LINE).length).toBe(2);
  const notice = notices(client, sessionId);
  expect(notice).toEqual([{ sessionUpdate: "user_message_chunk", content: { type: "text", text: LINE }, messageId: "m1", _meta: { casper: { steered: true } } }]);
  const at = ofSession(client, sessionId).indexOf(notice[0]);
  expect(wordsAt(client, sessionId, "FIRST_ANSWER")).toBeLessThan(at);
  expect(wordsAt(client, sessionId, "SECOND_ANSWER")).toBeGreaterThan(at);
  expect(client.stderr()).toContain("↳ sent to Casper · it reads this when its current step ends");
}, childTestLimit(1));

shellCheckTest("A steer that names a picture file or links one carries the picture to a model that sees pictures", async () => {
  const slow = held();
  const f = await fixture(async (_request, payload): Promise<Step> => {
    if (isChecklistCall(payload)) return { text: "[]" };
    if (carries(payload, "LINKED_PICTURE") && carries(payload, "NAMED_PICTURE")) return { text: "A grey button." };
    await slow.wait();
    return { text: "FIRST_ANSWER." };
  });
  // A model that can see pictures, as the session's model.
  const models = path.join(f.home, ".casper/agent/models.json");
  const listed = JSON.parse(await Bun.file(models).text());
  listed.providers.fixture.models.push({ id: "eyes", input: ["text", "image"] });
  await writeFile(models, JSON.stringify(listed));
  await writeFile(f.settings, JSON.stringify({ defaultProvider: "fixture", defaultModel: "eyes", retry: { enabled: false } }));
  const shot = path.join(f.project, "shot.png");
  await writeFile(shot, Buffer.from(PNG, "base64"));
  const client = open(f);
  const sessionId = await session(client, f.project);
  const done = client.request("session/prompt", { sessionId, prompt: text("Tell me about this folder") });
  await slow.reached;
  // A dropped file (a resource_link), and a line that starts with a picture's path (a / line that is no command).
  expect(await steer(client, sessionId, [{ type: "text", text: "LINKED_PICTURE what is wrong here" }, { type: "resource_link", uri: pathToFileURL(shot).href, name: "shot.png" }], "linked"))
    .toEqual({ steered: true, messageId: "linked" });
  expect(await steer(client, sessionId, text(`${shot} NAMED_PICTURE and here`), "named")).toEqual({ steered: true, messageId: "named" });
  slow.release();
  expect((await done).stopReason).toBe("end_turn");
  const read = f.payloads.find((payload) => carries(payload, "LINKED_PICTURE") && carries(payload, "NAMED_PICTURE"))!;
  for (const marker of ["LINKED_PICTURE", "NAMED_PICTURE"]) {
    const [message] = userMessagesWith(read, marker);
    expect(message?.pictures).toBe(1);
    expect(message?.words).toContain(`is the file ${shot}`);
  }
  // The app is told each line was read, in its own words.
  expect(notices(client, sessionId).map((notice) => [notice.messageId, notice.content.text])).toEqual([
    ["linked", `LINKED_PICTURE what is wrong here\nAttached file shot.png: "${shot}"`], ["named", `${shot} NAMED_PICTURE and here`]]);
}, childTestLimit(1));

shellCheckTest("A steer with no prompt running is refused and nothing reaches the model", async () => {
  const f = await fixture(() => ({ text: "Hello." }));
  const client = open(f);
  const sessionId = await session(client, f.project);
  expect(await steer(client, sessionId, text(LINE), "early")).toEqual({ steered: false, messageId: "early" });
  // A session the router does not know is not found, as a prompt to it is.
  const unknown = await steer(client, "not-a-session", text(LINE)).then(() => undefined, (error: { code?: number }) => error.code);
  expect(unknown).toBe(-32002);
  expect((await client.request("session/prompt", { sessionId, prompt: text("Say hello") })).stopReason).toBe("end_turn");
  expect(f.payloads.length).toBeGreaterThan(0);
  expect(f.payloads.filter((payload) => carries(payload, LINE))).toEqual([]);
  expect(notices(client, sessionId)).toEqual([]);
}, childTestLimit(1));

shellCheckTest("A steer during checks is refused and the next prompt does not carry it", async () => {
  const f = await fixture((_request, payload) => isChecklistCall(payload) ? { text: "[]" } : afterTool(payload) ? { text: "Fixed sum.js." }
    : lastUser(payload).includes("Fix sum.js") ? { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] } : { text: "You're welcome." });
  // The check says it runs, then waits until the test lets it go on (in Casper's own folder: checks write only in the
  // project, and a copy of it the proof checks reads the flag from here). It is a Bun script, as Windows runs a check
  // through cmd.exe.
  const flag = (name: string) => path.join(f.project, ".casper", name);
  const check = path.join(f.root, "check.mjs");
  await writeFile(check, [`import { existsSync, readFileSync, writeFileSync } from "node:fs";`,
    `try { writeFileSync(${JSON.stringify(flag("checking"))}, ""); } catch {}`,
    `while (!existsSync(${JSON.stringify(flag("go"))})) await Bun.sleep(50);`,
    `process.exit(readFileSync("sum.js", "utf8").includes("fixed") ? 0 : 1);`].join("\n"));
  await fixProject(f, `"${process.execPath}" "${check}"`);
  const client = open(f);
  const sessionId = await session(client, f.project);
  const done = client.request("session/prompt", { sessionId, prompt: text("Fix sum.js") });
  await until(() => existsSync(flag("checking")), 60_000, "the check to start");
  expect(await steer(client, sessionId, text(LINE))).toEqual({ steered: false, messageId: "m1" });
  await writeFile(flag("go"), "");
  expect((await done).stopReason).toBe("end_turn");
  expect((await client.request("session/prompt", { sessionId, prompt: text("Thanks") })).stopReason).toBe("end_turn");
  expect(f.payloads.filter((payload) => carries(payload, LINE))).toEqual([]);
  expect(notices(client, sessionId)).toEqual([]);
}, childTestLimit(1));

shellCheckTest("A cancelled prompt sends no notice and the next request does not carry the line", async () => {
  const slow = held();
  let requests = 0;
  const f = await fixture(async (_request, payload): Promise<Step> => {
    if (isChecklistCall(payload)) return { text: "[]" };
    if (++requests === 1) await slow.wait();
    return { text: "Answered." };
  });
  const client = open(f);
  const sessionId = await session(client, f.project);
  const done = client.request("session/prompt", { sessionId, prompt: text("Tell me about this folder") });
  await slow.reached;
  expect(await steer(client, sessionId, text(LINE))).toEqual({ steered: true, messageId: "m1" });
  client.notify("session/cancel", { sessionId });
  expect((await done).stopReason).toBe("cancelled");
  slow.release();
  expect((await client.request("session/prompt", { sessionId, prompt: text("Tell me again") })).stopReason).toBe("end_turn");
  expect(requests).toBeGreaterThan(1);
  expect(f.payloads.filter((payload) => carries(payload, LINE))).toEqual([]);
  expect(notices(client, sessionId)).toEqual([]);
}, childTestLimit(1));

shellCheckTest("A steer sent before the model starts joins the request as a later instruction and is announced first", async () => {
  // The checklist call runs before the task's first model turn: the line arrives while it is out.
  const checklist = held();
  const f = await fixture(async (_request, payload): Promise<Step> => {
    if (isChecklistCall(payload)) { await checklist.wait(); return { text: "[]" }; }
    return afterTool(payload) ? { text: "Fixed sum.js." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] };
  });
  await fixProject(f);
  const client = open(f);
  const sessionId = await session(client, f.project);
  const done = client.request("session/prompt", { sessionId, prompt: text("Fix sum.js") });
  await checklist.reached;
  expect(await steer(client, sessionId, text(LINE))).toEqual({ steered: true, messageId: "m1" });
  checklist.release();
  expect((await done).stopReason).toBe("end_turn");
  const first = f.payloads.find((payload) => !isChecklistCall(payload))!;
  expect(lastUser(first)).toContain(`Later instructions the user typed during this task, oldest first:\\n- ${LINE}`);
  const notice = notices(client, sessionId);
  expect(notice).toEqual([{ sessionUpdate: "user_message_chunk", content: { type: "text", text: LINE }, messageId: "m1", _meta: { casper: { steered: true } } }]);
  expect(wordsAt(client, sessionId, "Fixed sum.js")).toBeGreaterThan(ofSession(client, sessionId).indexOf(notice[0]));
  expect(client.stderr()).not.toContain("↳ sent to Casper");
}, childTestLimit(1));

shellCheckTest("A line taken as the review's last turn ends is still read, announced once, and restated in the repair round", async () => {
  // The review round's twelfth turn is its last (its own budget), and it breaks sum.js, so a repair round follows. Pi
  // reads a line that waits when a run ends, so the line steered while that turn is out gets one more turn.
  const last = held();
  let reviewTurns = 0;
  const f = await fixture(async (_request, payload): Promise<Step> => {
    if (isChecklistCall(payload)) return { text: "[]" };
    const user = lastUser(payload);
    if (user.includes("Casper verification repair")) return afterTool(payload) ? { text: "Repaired." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] };
    if (user.includes(LINE)) return { text: "Noted the pineapple." };
    if (user.includes(REVIEW)) {
      if (++reviewTurns < 12) return { tools: [{ name: "write", args: { path: `review-${reviewTurns}.txt`, content: "x\n" } }] };
      await last.wait();
      return { tools: [{ name: "write", args: { path: "sum.js", content: "broken again\n" } }] };
    }
    return afterTool(payload) ? { text: "Fixed." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] };
  });
  await fixProject(f);
  await reviewOn(f);
  const client = open(f);
  const sessionId = await session(client, f.project);
  const done = client.request("session/prompt", { sessionId, prompt: text("Fix sum.js") });
  await last.reached;
  expect(await steer(client, sessionId, text(LINE))).toEqual({ steered: true, messageId: "m1" });
  last.release();
  expect((await done).stopReason).toBe("end_turn");
  expect(reviewTurns).toBe(12);
  // Read once, in the turn after the review's last, and told once.
  const read = f.payloads.findIndex((payload) => lastUser(payload).includes(LINE));
  expect(read).toBeGreaterThan(0);
  expect(JSON.stringify(f.payloads[read]!.messages).split(LINE).length).toBe(2);
  expect(notices(client, sessionId)).toEqual([{ sessionUpdate: "user_message_chunk", content: { type: "text", text: LINE }, messageId: "m1", _meta: { casper: { steered: true } } }]);
  // The repair round restates the request with it, as a later instruction.
  const repair = f.payloads.find((payload) => lastUser(payload).includes("Casper verification repair"))!;
  expect(lastUser(repair)).toContain(`Later instructions the user typed during this task, oldest first:\\n- ${LINE}`);
}, childTestLimit(1));

shellCheckTest("A slash line is refused, a user secret is echoed hidden and an error's words are hidden", async () => {
  const value = "acp-steer-secret-5d1e9b";
  const slow = held();
  let requests = 0;
  const f = await fixture(async (_request, payload): Promise<Step> => {
    if (isChecklistCall(payload)) return { text: "[]" };
    if (++requests === 1) await slow.wait();
    return { text: "Answered." };
  });
  const client = open(f, [], { DEMO_API_KEY: value });
  const sessionId = await session(client, f.project);
  const done = client.request("session/prompt", { sessionId, prompt: text("Tell me about this folder") });
  await slow.reached;
  expect(await steer(client, sessionId, text("/status"), "slash")).toEqual({ steered: false, messageId: "slash" });
  expect(await steer(client, sessionId, text(`use ${value} as the key`), "secret")).toEqual({ steered: true, messageId: "secret" });
  // A prompt Casper can't read is refused with its reason, and the reason's words are hidden too.
  const refused = await steer(client, sessionId, [{ type: "image", data: "aGVsbG8=", mimeType: value }], "bad").then(() => undefined, (error: { code?: number; message: string }) => error);
  expect(refused?.code).toBe(-32602);
  expect(refused?.message).toContain("Nothing in the prompt Casper can read.");
  expect(refused?.message).not.toContain(value);
  slow.release();
  expect((await done).stopReason).toBe("end_turn");
  const notice = notices(client, sessionId);
  expect(notice).toHaveLength(1);
  expect(notice[0]).toMatchObject({ messageId: "secret", content: { type: "text", text: expect.stringContaining("as the key") } });
  expect(client.lines.join("\n")).not.toContain(value);
  expect(f.payloads.filter((payload) => carries(payload, "/status"))).toEqual([]);
}, childTestLimit(1));

shellCheckTest("A steer that arrives after its prompt ended is refused and does not enter the next prompt", async () => {
  const f = await fixture((_request, payload) => isChecklistCall(payload) ? { text: "[]" } : { text: "Answered." });
  const client = open(f);
  const sessionId = await session(client, f.project);
  expect((await client.request("session/prompt", { sessionId, prompt: text("Tell me about this folder") })).stopReason).toBe("end_turn");
  expect(await steer(client, sessionId, text(LINE))).toEqual({ steered: false, messageId: "m1" });
  expect((await client.request("session/prompt", { sessionId, prompt: text("Tell me again") })).stopReason).toBe("end_turn");
  expect(f.payloads.filter((payload) => carries(payload, LINE))).toEqual([]);
  expect(notices(client, sessionId)).toEqual([]);
}, childTestLimit(1));
