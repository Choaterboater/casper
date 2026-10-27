import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanUpAfterEach, fixture, type Step } from "./support/scripting";
import { childTestLimit } from "./support/limits";

/**
 * A conversation that outgrows the model's window, through the real CLI and engine: the engine compacts it and tries
 * again by itself, so Casper says that in one line. It used to print an error telling you to /compact, though the task
 * went on (a real Haiku 5.5 run on a Claude plan did this 3 times). src/runtime/pi.ts.
 */
cleanUpAfterEach();

const SUMMARY = "The messages above are a conversation to summarize";
const OVERFLOW: Step = { status: 400, error: "prompt is too long: 210000 tokens > 200000 maximum" };

/** About 48k tokens over three earlier requests: the engine keeps the newest ~20k word for word as it compacts, so it has
 * the oldest to summarize. Then `overflows` says which requests the provider refuses as too long. */
async function longConversation(overflows: (conversation: string) => boolean) {
  const f = await fixture((_, payload) => {
    if (JSON.stringify(payload.messages.at(-1)).includes(SUMMARY)) return { text: "CHECKPOINT_SUMMARY" };
    return overflows(JSON.stringify(payload.messages)) ? OVERFLOW : { text: "ANSWER_AFTER_COMPACTION" };
  });
  await writeFile(path.join(f.home, ".casper/agent/settings.json"), JSON.stringify({ retry: { enabled: false } }));
  for (const [mark, continued] of [["NOTES_A", false], ["NOTES_B", true], ["NOTES_C", true]] as const) {
    const run = await f.run(["--json", ...(continued ? ["--continue"] : []), "-"], f.project, {}, `${mark} `.repeat(8_000));
    expect(run.exit).toBe(0);
  }
  f.payloads.length = 0;
  return f;
}

test("a conversation that outgrows the model's window is compacted and the task goes on: one line says so, and no error tells you to /compact", async () => {
  const f = await longConversation((conversation) => conversation.includes("NEXT_STEP") && !conversation.includes("CHECKPOINT_SUMMARY"));
  const run = await f.run(["--continue", "NEXT_STEP"]);
  const said = run.stdout + run.stderr;
  // Refused as too long, summarized, then tried again with the summary.
  expect(f.payloads).toHaveLength(3);
  expect(run.exit).toBe(0);
  expect(said).toContain("ANSWER_AFTER_COMPACTION");
  expect(said).toContain("This conversation got too long for fixture/first, so Casper compacted it and is trying again.");
  expect(said).not.toContain("/compact");
  expect(said).not.toContain("[error]");
  // Scripts see no error event for it either.
  const json = await (await longConversation((conversation) => conversation.includes("NEXT_STEP") && !conversation.includes("CHECKPOINT_SUMMARY")))
    .run(["--json", "--continue", "NEXT_STEP"]);
  expect(json.exit).toBe(0);
  expect(json.stdout).not.toContain('"type":"error"');
}, childTestLimit(6));

test("when the compacted conversation still doesn't fit, the error and its /compact advice show as before", async () => {
  const f = await longConversation((conversation) => conversation.includes("NEXT_STEP"));
  const run = await f.run(["--continue", "NEXT_STEP"]);
  const said = run.stdout + run.stderr;
  expect(run.exit).not.toBe(0);
  expect(said).toContain("This conversation got too long for fixture/first, so Casper compacted it and is trying again.");
  expect(said).toContain("The conversation is too long for this model. Next: /compact, then ask again.");
}, childTestLimit(3));

test("when there is nothing older to compact, the error and its /compact advice show as before, and scripts get the error", async () => {
  const f = await fixture(() => OVERFLOW);
  await writeFile(path.join(f.home, ".casper/agent/settings.json"), JSON.stringify({ retry: { enabled: false } }));
  const run = await f.run(["FIRST_STEP"]);
  const said = run.stdout + run.stderr;
  expect(run.exit).not.toBe(0);
  expect(said).toContain("The conversation is too long for this model. Next: /compact, then ask again.");
  expect(said).not.toContain("compacted it");
  const json = await f.run(["--json", "FIRST_STEP"]);
  expect(json.exit).not.toBe(0);
  expect(json.stdout).toContain('"type":"error"');
}, childTestLimit(3));
