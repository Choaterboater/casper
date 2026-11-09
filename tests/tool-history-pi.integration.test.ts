import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { answer, calls, cleanUpAfterEach, fixture, type Payload } from "./support/phase8-pi";
import { childTestLimit } from "./support/limits";
import { ELISION_NOTE } from "../src/runtime/elision";

cleanUpAfterEach();

/** A 12k window: each 500-line fixture read (about 2,900 tokens) passes the 20% share on its own. */
async function smallWindow(agent: string, compaction: Record<string, unknown>): Promise<void> {
  const file = path.join(agent, "models.json");
  const models = JSON.parse(await readFile(file, "utf8"));
  models.providers.fixture.models[0].contextWindow = 12_000;
  await writeFile(file, JSON.stringify(models));
  const settingsPath = path.join(agent, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  await writeFile(settingsPath, JSON.stringify({ ...settings, compaction }));
}
/** The requests that do not repeat the one before them byte for byte (system prompt, tools, every earlier message). */
const extends_ = (payload: Payload, before: Payload) => JSON.stringify(payload.tools) === JSON.stringify(before.tools)
  && JSON.stringify(payload.messages.slice(0, before.messages.length)) === JSON.stringify(before.messages);
function prefixBreaks(payloads: Payload[]): number[] {
  return payloads.flatMap((payload, index) => index > 0 && !extends_(payload, payloads[index - 1]!) ? [index] : []);
}

test("real Pi compaction persists a new epoch and its eight-round checkpoint across restart", async () => {
  let requests = 0;
  const f = await fixture(() => requests++ === 0 ? calls([{ name: "read", args: { path: "fixture.txt" } }]) : answer("Synthetic task summary."));
  await writeFile(path.join(f.project, "fixture.txt"), "SYNTHETIC_HISTORY_LINE\n".repeat(500));
  await smallWindow(f.agent, { enabled: true, keepRecentTokens: 1 });
  const run = await f.run([path.join(import.meta.dir, "fixtures/pi-tool-history-compaction.ts"), f.project]);
  expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
  const result = JSON.parse(run.stdout.split("COMPACTION_RESULT=")[1]!);
  expect(result.before.map((record: { turns: number }) => record.turns)).toEqual([8, 0]);
  expect(result.before[0].epoch).not.toBe(result.before[1].epoch);
  expect(result.after).toEqual(result.before);
  expect(f.payloads.slice(12).every((payload) => payload.messages.every((message) => message.role !== "tool"))).toBe(true);
  // Requests 11 and 12 write the summary; after it every request extends the one before (restart included).
  expect(prefixBreaks(f.payloads.slice(13))).toEqual([]);
}, childTestLimit(3));
for (const mode of ["on", "off"]) test(`Pi sends the history projection (${mode}), preserves raw output, and restores branch-local masks`, async () => {
  let requests = 0;
  const f = await fixture(() => {
    const step = requests++;
    return step === 0 || step === 11 ? calls([{ name: "read", args: { path: step === 0 ? "fixture.txt" : "live.txt" } }]) : answer("Continue the task.");
  });
  await writeFile(path.join(f.project, "fixture.txt"), "SYNTHETIC_HISTORY_LINE\n".repeat(500));
  await writeFile(path.join(f.project, "live.txt"), "SYNTHETIC_LIVE_OUTPUT\n".repeat(500));
  // Hiding alone: these requests are counted by index, and a 12k window holding these reads would compact among them.
  await smallWindow(f.agent, { enabled: false });
  const run = await f.run([path.join(import.meta.dir, "fixtures/pi-tool-history.ts"), f.project, mode]);
  expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
  const result = JSON.parse(run.stdout.split("HISTORY_RESULT=")[1]!);
  expect(result).toEqual({ rawHasOriginal: true, rawHasMasks: mode === "on", forked: true, rewound: true });
  const tool = (index: number) => f.payloads[index]!.messages.find((message) => message.role === "tool")!;
  expect(JSON.stringify(tool(7))).toContain("SYNTHETIC_HISTORY_LINE");
  if (mode === "on") {
    expect(tool(8).content).toBe("[output of read fixture.txt hidden, re-run to see it]");
    expect(JSON.stringify(f.payloads[9]!.messages.slice(0, f.payloads[8]!.messages.length))).toBe(JSON.stringify(f.payloads[8]!.messages));
    // Off, fork, resume and fresh runtime retain precisely the same stub.
    for (const index of [11, 17, 18, 19]) expect(tool(index)).toEqual(tool(8));
  } else for (const index of [8, 11, 17, 18, 19]) expect(JSON.stringify(tool(index))).toContain("SYNTHETIC_HISTORY_LINE");
  // A second bulky read ages past another checkpoint while off; it must never be newly hidden.
  for (const index of [16, 17, 18, 19]) expect(JSON.stringify(f.payloads[index]!.messages)).toContain("SYNTHETIC_LIVE_OUTPUT");
  // Every request repeats the one before byte for byte (the fork and a restart included), except the
  // checkpoint (8), the resume of the original after the fork (18, which repeats 16) and the rewind (20).
  expect(prefixBreaks(f.payloads)).toEqual(mode === "on" ? [8, 18, 20] : [18, 20]);
  expect(extends_(f.payloads[18]!, f.payloads[16]!)).toBe(true);
  // Rewinding before the checkpoint does not inherit masks from a different branch.
  expect(JSON.stringify(tool(20))).toContain("SYNTHETIC_HISTORY_LINE");
}, childTestLimit(3));
for (const mode of ["follow-up", "plain"]) test(`Pi hides an old file body at the first request of a round Casper starts (${mode})`, async () => {
  let requests = 0;
  // About 2,000 tokens of body: under a fifth of the 12k window, over the 5% a follow-up round needs.
  const f = await fixture(() => requests++ === 0
    ? calls([{ name: "write", args: { path: "built.txt", content: "SYNTHETIC_BODY_LINE\n".repeat(400) } }]) : answer("Continue the task."));
  await smallWindow(f.agent, { enabled: false });
  const run = await f.run([path.join(import.meta.dir, "fixtures/pi-tool-history-follow-up.ts"), f.project, mode]);
  expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(await readFile(path.join(f.project, "built.txt"), "utf8")).toContain("SYNTHETIC_BODY_LINE");
  const sent = (index: number) => JSON.stringify(f.payloads[index]!.messages);
  // Requests 0-6 build; 7 is the review round's first request; 8 comes after it.
  expect(f.payloads).toHaveLength(9);
  expect(sent(6)).toContain("SYNTHETIC_BODY_LINE");
  for (const index of [7, 8]) {
    if (mode === "follow-up") {
      expect(sent(index)).not.toContain("SYNTHETIC_BODY_LINE");
      expect(sent(index)).toContain("[content of write built.txt (400 lines) hidden, read the file before judging or editing it]");
    } else expect(sent(index)).toContain("SYNTHETIC_BODY_LINE");
  }
  // The cache is rebuilt once, at the round's first request, and never again.
  expect(prefixBreaks(f.payloads)).toEqual(mode === "follow-up" ? [7] : []);
}, childTestLimit(3));
test("after its body is hidden, an edit made from the stub is refused and a stub written back gets the placeholder note", async () => {
  let requests = 0;
  const stub = "[content of write built.txt (400 lines) hidden, read the file before judging or editing it]";
  const f = await fixture(() => {
    const step = requests++;
    if (step === 0) return calls([{ name: "write", args: { path: "built.txt", content: "SYNTHETIC_BODY_LINE\n".repeat(400) } }]);
    // The review round's first request sees only the stub; the model edits from it, then writes it back.
    if (step === 7) return calls([{ name: "edit", args: { path: "built.txt", edits: [{ oldText: "[hidden]", newText: "changed" }] } }]);
    if (step === 8) return calls([{ name: "write", args: { path: "built.txt", content: `${stub}\n` } }]);
    return answer("Continue the task.");
  });
  await smallWindow(f.agent, { enabled: false });
  const run = await f.run([path.join(import.meta.dir, "fixtures/pi-tool-history-follow-up.ts"), f.project, "imitate"]);
  expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
  const lastTool = (index: number) => JSON.stringify(f.payloads[index]!.messages.filter((message) => message.role === "tool").at(-1));
  expect(JSON.stringify(f.payloads[7]!.messages)).toContain(stub);
  // The edit's old text is not in the file: refused, nothing changed, and the model reads that it failed.
  expect(lastTool(8)).toMatch(/could not find|not found/i);
  expect(lastTool(8)).not.toContain(ELISION_NOTE);
  expect(lastTool(9)).toContain(ELISION_NOTE);
}, childTestLimit(3));
