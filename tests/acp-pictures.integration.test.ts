import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startAcp, until, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { cleanUpAfterEach, fixture, type Payload } from "./support/scripting";

// Pictures and files in an ACP prompt (decision 78), against a real `casper acp` child and the scripted provider.
const clients: AcpClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close().catch(() => {}); });
cleanUpAfterEach();
const open = (...args: Parameters<typeof startAcp>) => { const client = startAcp(...args); clients.push(client); return client; };

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fake-acp-client", version: "1" } };
/** A 1x1 PNG, and a HEIC's first bytes (an iPhone photo). */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const HEIC = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]).toString("base64");
const words = (text: string) => ({ type: "text", text });
const image = (data = PNG, mimeType = "image/png") => ({ type: "image", mimeType, data });
const onlyProtocol = (client: AcpClient) => { for (const line of client.lines) expect(JSON.parse(line).jsonrpc).toBe("2.0"); };
/** The agent's message chunks of one session, in order. */
const chunks = (client: AcpClient, sessionId: string) => client.updates.filter((update) => update.sessionId === sessionId && update.update.sessionUpdate === "agent_message_chunk")
  .map((update) => update.update.content.text as string);

/** The words of the last user message a model request carries, and how many pictures go with it. */
function lastAsk(payload: Payload): { words: string; pictures: number } {
  const last = [...payload.messages].reverse().find((message) => message.role === "user");
  const parts = typeof last?.content === "string" ? [{ type: "text", text: last.content }] : (last?.content ?? []) as Array<{ type: string; text?: string }>;
  return { words: parts.flatMap((part) => part.type === "text" ? [part.text ?? ""] : []).join("\n"), pictures: parts.filter((part) => part.type === "image_url").length };
}
/** The task's request: the model call whose last user words include `marker`. */
const requestWith = (payloads: Payload[], marker: string) => payloads.find((payload) => lastAsk(payload).words.includes(marker));

/** The fixture's models plus `eyes`, which can see pictures; `current` is the model a session starts on, and `big`
 * makes eyes your big model (so a text-only model has one to offer). */
async function withEyes(f: Awaited<ReturnType<typeof fixture>>, current: "first" | "eyes", big: boolean): Promise<void> {
  const models = path.join(f.home, ".casper/agent/models.json");
  const listed = JSON.parse(await Bun.file(models).text());
  listed.providers.fixture.models.push({ id: "eyes", input: ["text", "image"] });
  await writeFile(models, JSON.stringify(listed));
  await writeFile(f.settings, JSON.stringify({ defaultProvider: "fixture", defaultModel: current, retry: { enabled: false }, ...(big ? { modelRoles: { reason: "fixture/eyes" } } : {}) }));
}

test("a picture and a picture file reach a model that sees them; files go as quoted paths, and a saved picture is gone after close", async () => {
  const f = await fixture(() => ({ text: "A grey button." }));
  await withEyes(f, "eyes", false);
  const shot = path.join(f.project, "shot.png");
  await writeFile(shot, Buffer.from(PNG, "base64"));
  await writeFile(path.join(f.project, "notes.txt"), "the code word is PLUM\n");
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  // Spaces around the words: the picture is still found under the line Casper runs.
  const done = await client.request("session/prompt", { sessionId, prompt: [words("  Why is this button grey?  "), image(),
    { type: "resource_link", uri: pathToFileURL(shot).href, name: "shot.png", size: 70 },
    { type: "resource_link", uri: pathToFileURL(path.join(f.project, "notes.txt")).href, name: "notes.txt", size: 22 }] });
  expect(done.stopReason).toBe("end_turn");
  const asked = lastAsk(requestWith(f.payloads, "Why is this button grey?")!);
  expect(asked.pictures).toBe(2);
  expect(asked.words).toContain("Why is this button grey?  \n[image 1]\nAttached file shot.png (70 bytes): [image 2]");
  expect(asked.words).toContain(`Attached file notes.txt (22 bytes): "${path.join(f.project, "notes.txt")}"`);
  expect(asked.words).toContain(`[image 2] is the file ${shot}`);
  // The pasted picture was saved for the model to use as a file, in Casper's private folder.
  const saved = /\[image 1\] is the file (.+)$/m.exec(asked.words)?.[1];
  expect(saved).toBeDefined();
  expect(existsSync(saved!)).toBe(true);
  expect(chunks(client, sessionId).some((chunk) => chunk.startsWith("[image] "))).toBe(false);
  onlyProtocol(client);
  expect(await client.close()).toBe(0);
  await until(() => !existsSync(saved!), 10_000, "the saved picture to be deleted");
  // The person's own picture file stays.
  expect(existsSync(shot)).toBe(true);
}, childTestLimit(1));

test("with no model that can see pictures, a note goes to the app and the words still go; a HEIC photo gets a note", async () => {
  // The model's own words go to the app once, as its words, even when a line of them looks like Casper's note.
  const f = await fixture(() => ({ text: "[image] words the model wrote\nAnswered." }));
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  expect((await client.request("session/prompt", { sessionId, prompt: [words("What colour is the Save button?"), image()] })).stopReason).toBe("end_turn");
  const first = requestWith(f.payloads, "What colour is the Save button?")!;
  expect(lastAsk(first).pictures).toBe(0);
  expect(chunks(client, sessionId).filter((chunk) => chunk === "[image] words the model wrote\n")).toHaveLength(1);
  const note = chunks(client, sessionId).find((chunk) => chunk.startsWith("[image] ") && chunk.includes("can't see pictures"));
  expect(note).toMatch(/^\[image\] .+ can't see pictures, and no model you set up can; the request goes without it\. \/model picks one that can\.\n$/);
  expect(client.permissions).toEqual([]);

  expect((await client.request("session/prompt", { sessionId, prompt: [words("And this photo?"), image(HEIC, "image/heic")] })).stopReason).toBe("end_turn");
  expect(lastAsk(requestWith(f.payloads, "And this photo?")!).pictures).toBe(0);
  expect(chunks(client, sessionId)).toContain("[image] A picture sent with the request is not a PNG, JPEG, GIF or WebP (image/heic); it was not attached.\n");
  // A prompt with nothing Casper can read is refused, and says why.
  const refused = await client.request("session/prompt", { sessionId, prompt: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }] }).catch((error) => error);
  expect(refused).toMatchObject({ code: -32602, message: "Nothing in the prompt Casper can read.\nCasper takes no audio; the recording was not sent." });
  onlyProtocol(client);
}, childTestLimit(1));

test("a text-only model with a picture model set up asks once in the app: 1 sends no picture, 2 sends it to that model", async () => {
  const f = await fixture(() => ({ text: "Looked." }));
  await withEyes(f, "first", true);
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  let pick = "1";
  client.answerPermissions(() => ({ optionId: pick }));
  expect((await client.request("session/prompt", { sessionId, prompt: [words("Describe it, first try"), image()] })).stopReason).toBe("end_turn");
  expect(client.permissions).toHaveLength(1);
  const box = client.permissions[0]!;
  expect(box.toolCall.title).toContain("can't see pictures, and this request has one.");
  expect(box.options.map((option: { name: string }) => option.name)).toEqual(["Send without it", "Switch to fixture/eyes for this request"]);
  const without = requestWith(f.payloads, "first try")!;
  expect(without.model).toBe("first");
  expect(lastAsk(without).pictures).toBe(0);

  pick = "2";
  expect((await client.request("session/prompt", { sessionId, prompt: [words("Describe it, second try"), image()] })).stopReason).toBe("end_turn");
  expect(client.permissions).toHaveLength(2);
  const switched = requestWith(f.payloads, "second try")!;
  expect(switched.model).toBe("eyes");
  expect(lastAsk(switched).pictures).toBe(1);
  onlyProtocol(client);
}, childTestLimit(1));
