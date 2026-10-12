import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { answer, calls, cleanUpAfterEach, fixture, type Payload } from "./support/phase8-pi";
import { childTestLimit } from "./support/limits";

cleanUpAfterEach();

/** A 12k window: each 500-line fixture read (about 2,900 tokens) passes the 20% share on its own. */
async function smallWindow(agent: string): Promise<void> {
  const file = path.join(agent, "models.json");
  const models = JSON.parse(await readFile(file, "utf8"));
  models.providers.fixture.models[0].contextWindow = 12_000;
  await writeFile(file, JSON.stringify(models));
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
  await smallWindow(f.agent);
  const settingsPath = path.join(f.agent, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  settings.compaction = { enabled: true, keepRecentTokens: 1 };
  await writeFile(settingsPath, JSON.stringify(settings));
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
  await smallWindow(f.agent);
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
