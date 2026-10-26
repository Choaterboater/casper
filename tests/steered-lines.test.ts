import { expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { STEERED_NOTE, SteeredLines, steeredAt } from "../src/runtime/steered-lines";

const user = (text: string, timestamp: number): Message => ({ role: "user", content: [{ type: "text", text }], timestamp });
const reply = (timestamp: number) => ({ role: "assistant", content: [{ type: "text", text: "Working on it" }], timestamp } as unknown as Message);
const words = (message: Message) => typeof message.content === "string" ? [message.content]
  : message.content.map(part => part.type === "text" ? part.text : part.type);

test("a line typed during work reaches the model after a note to carry on with its task; other messages are untouched", () => {
  const lines = new SteeredLines();
  const messages = [user("Build the card list", 100), reply(200), user("how many cards do I have?", 300)];
  const before = JSON.stringify(messages);
  lines.sent("how many cards do I have?", 250);
  const recorded: number[] = [];
  const sent = lines.project(messages, new Set(), at => recorded.push(at));
  expect(words(sent[2]!)).toEqual([STEERED_NOTE, "how many cards do I have?"]);
  expect(sent[0]).toBe(messages[0]!);
  expect(sent[1]).toBe(messages[1]!);
  expect(recorded).toEqual([300]);
  // The conversation keeps the person's words: only the provider's copy has the note.
  expect(JSON.stringify(messages)).toBe(before);
});

test("an earlier message with the same words is not the typed line, and a line taken back before it arrived is never marked", () => {
  const lines = new SteeredLines();
  lines.sent("yes", 250);
  const sent = lines.project([user("yes", 100), reply(200), user("yes", 300)], new Set(), () => {});
  expect(words(sent[0]!)).toEqual(["yes"]);
  expect(words(sent[2]!)).toEqual([STEERED_NOTE, "yes"]);

  const taken = new SteeredLines();
  taken.sent("also add tests", 250);
  taken.cleared();
  const recorded: number[] = [];
  expect(words(taken.project([user("also add tests", 400)], new Set(), at => recorded.push(at))[0]!)).toEqual(["also add tests"]);
  expect(recorded).toEqual([]);
});

test("a line marked earlier in the conversation gets the same bytes in every later request, and its pictures stay with it", () => {
  const messages: Message[] = [user("Build it", 100), reply(200),
    { role: "user", content: [{ type: "text", text: "use this logo" }, { type: "image", data: "aGk=", mimeType: "image/png" }], timestamp: 300 }];
  const first = new SteeredLines();
  first.sent("use this logo", 250);
  const once = first.project(messages, new Set(), () => {});
  // A later request, or the next task, knows the line from the saved conversation, not from Pi's queue.
  const recorded: number[] = [];
  const later = new SteeredLines().project(messages, new Set([300]), at => recorded.push(at));
  expect(JSON.stringify(later)).toBe(JSON.stringify(once));
  expect(words(later[2]!)).toEqual([STEERED_NOTE, "use this logo", "image"]);
  expect(recorded).toEqual([]);
  expect(new SteeredLines().project(messages, new Set(), () => {})).toEqual(messages);
});

test("only a saved record with a time marks a line", () => {
  expect(steeredAt({ at: 1_700_000_000_000 })).toBe(1_700_000_000_000);
  for (const data of [undefined, null, 5, "300", {}, { at: "300" }, { at: Number.NaN }, { at: -1 }]) expect(steeredAt(data)).toBeUndefined();
});
