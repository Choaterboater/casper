import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { deliberateChoices } from "../tools/adr-index";
import { changedSoFar, endingLine, mustStand, quietReceipt, taskEnding, withEarlierChanges } from "../src/task/ending";
import { receiptView, shortReceiptText, type TaskResult } from "../src/task/result";
import { receiptCard } from "../src/tui/receipt-card";

/**
 * The receipt card came right after a reply that asked the person something or said what the AI does next, so a
 * task that waited for them looked finished, and the card's numbered keys looked like the options the AI had just
 * offered. taskEnding reads the reply's closing words to tell those endings apart from a finished task.
 */
test("a reply that ends asking you something is waiting for your answer", () => {
  for (const reply of [
    "The plugin loads fine. Want me to read its settings file, list the other plugins, or check the recent log for errors?",
    "Fixed the parser.\n\nShould I also update the README? I can keep it short.",
    "**Want me to deploy it now?** 🙂",
    "Which one should I use:\n\n1. Postgres\n2. SQLite",
    "Pick a port:\n- 8080\n- 8443",
    "The new settings are in example-site/app.yaml. Type \"done\" once the file is on the server, and I'll run the check.",
    "Let me know which port you want.",
    "Tell me whether the old service should stay.",
    "Once you've restarted it, I'll check the logs.",
    "Please confirm the address 192.0.2.10 before I write it.",
    "Let me know if you'd like me to add tests too.",
    "Run this on the server and paste what it prints?\n\n```\nsystemctl status app\n```",
    // Its open items are a report, never the options: the question above them still counts.
    "Fixed the parser. Should I also update the docs?\n\nStill not done: docs — not asked for",
  ]) expect({ reply, ending: taskEnding(reply) }).toEqual({ reply, ending: "question" });
});

test("a reply that ends saying what the AI does next, then stops, is paused", () => {
  for (const reply of [
    "The service is not set up yet. Next I'll write its unit file, then start it.",
    "The test fails because of the timezone. Let me check the logs.",
    "I'll now run the tests.",
    "Now I'll update the service file. Then it restarts.",
    "I'm going to rewrite the parser next.",
  ]) expect({ reply, ending: taskEnding(reply) }).toEqual({ reply, ending: "next" });
});

test("a finished reply, a closing pleasantry, a summary list or the open items alone is no ending to wait on", () => {
  for (const reply of [
    "Added the sum function and a test; both pass.",
    "Done. Let me know if you need anything else.",
    "Changed the greeting. Anything else?",
    "Is there anything else you'd like me to change?",
    "Changed:\n- src/a.ts\n- src/b.ts",
    "Run this to start it:\n```\nbun run dev\n```",
    "Fixed the parser.\n\nStill not done: handshake timeout — node:tls has no option",
    // A question earlier in the reply is not how it ends.
    "Why did it fail? The cache was stale. I cleared it and the tests pass now.",
    "Let me be clear: the change is in and the tests pass.",
    "",
  ]) expect({ reply, ending: taskEnding(reply) }).toEqual({ reply, ending: undefined });
});

const task = (fields: Partial<TaskResult> = {}): TaskResult => ({ execution: "completed", observedEdits: [], ...fields } as TaskResult);

test("the line names where the changes so far are, and says nothing about changes when there are none", () => {
  expect(endingLine("question", task({ changedPaths: [] }))).toBe("? Waiting for your answer");
  expect(endingLine("question", task({ changedPaths: ["a.ts", "b.ts"], receipt: 7 }))).toBe("? Waiting for your answer · /receipt 7 shows the 2 files changed so far");
  expect(endingLine("next", task({ changedPaths: ["a.ts"], receipt: 3 })))
    .toBe("Paused — the AI said what it does next; say go, or tell it what to change · /receipt 3 shows the 1 file changed so far");
  expect(changedSoFar(task({ changedPaths: [], remoteChanges: [{ host: "lab-switch", changes: ["set a vlan"] }] }))).toBe("changes so far");
  expect(changedSoFar(task({ changedPaths: [] }))).toBeUndefined();
});

test("a failure, a stop, a secret or a risky config line keeps its card under a question", () => {
  const failed = { status: "fail" as const, repairAttempts: 0, results: [{ name: "test", status: "fail" as const, command: "bun test", exitCode: 1, durationMs: 10 }] };
  expect(mustStand(task({ changedPaths: ["a.ts"], verification: failed } as Partial<TaskResult>))).toBe(true);
  expect(mustStand(task({ execution: "cancelled" }))).toBe(true);
  expect(mustStand(task({ changedPaths: [], secretInCommand: true }))).toBe(true);
  expect(mustStand(task({ changedPaths: ["a.ts"], autoSkipped: "no-checks" }))).toBe(false);
  expect(mustStand(task({ changedPaths: [], autoSkipped: "no-changes" }))).toBe(false);
});

test("a receipt is quiet only when it would say nothing but that nothing changed", () => {
  const quiet = (fields: Partial<TaskResult>) => { const done = task(fields); return quietReceipt(receiptView(done, { surface: "interactive" }), done); };
  expect(quiet({ changedPaths: [], autoSkipped: "no-changes" })).toBe(true);
  expect(quiet({ changedPaths: [], autoSkipped: "no-changes", sandbox: { held: false, reason: "no sandbox here" } } as Partial<TaskResult>)).toBe(true);
  // Something ran, changed somewhere, or moved: the card says so.
  expect(quiet({ changedPaths: ["a.ts"], autoSkipped: "no-checks" })).toBe(false);
  expect(quiet({ changedPaths: [], autoSkipped: "no-changes", remoteChanges: [{ host: "lab-switch", changes: ["set a vlan"] }] })).toBe(false);
  expect(quiet({ changedPaths: [], autoSkipped: "no-changes", outsideWrites: ["~/example-site"] })).toBe(false);
  expect(quiet({ changedPaths: [], autoSkipped: "no-changes", observedChecks: [{ name: "test", command: "bun test", toolStatus: "success", output: "", truncated: false }] } as Partial<TaskResult>)).toBe(false);
  expect(quiet({ changedPaths: [], autoSkipped: "no-changes", branchMoved: true })).toBe(false);
});

test("the card that ends the work names what changed before your answers, in its Changed row", () => {
  const done = task({ changedPaths: ["README.md"], autoSkipped: "no-checks" });
  const view = withEarlierChanges(receiptView(done, { surface: "interactive" }),
    [task({ changedPaths: ["a.ts", "b.ts"], receipt: 4 }), task({ changedPaths: ["b.ts", "c.ts"], receipt: 5 })]);
  expect(shortReceiptText(view)).toContain("– Also changed before your answers: 3 files (/receipt 4, /receipt 5)");
  const card = receiptCard(view, false)!;
  expect(card.rows.find((row) => row.label === "Changed")!.values).toEqual(["README.md", "Also changed before your answers: 3 files (/receipt 4, /receipt 5)"]);
  // Nothing held: the view is as it was.
  const plain = receiptView(done, { surface: "interactive" });
  expect(withEarlierChanges(plain, [])).toBe(plain);
});

test("the docs say how a task that is not done ends, what stays the same, and what a wrong guess does", async () => {
  const read = async (name: string) => (await readFile(path.join(import.meta.dir, "..", name), "utf8")).replace(/\s+/g, " ");
  const verification = await read("docs/VERIFICATION.md");
  for (const text of ["### When a task is not done yet", "? Waiting for your answer · /receipt 12 shows the 2 files changed so far",
    "Paused — the AI said what it does next; say go, or tell it what to change", "The receipt is saved as always, so `/receipt`, `/undo` and `/diff` work.",
    "– Also changed before your answer: 2 files (/receipt 12)", "always keep their card, with the line under it and no keys",
    "there is no card at all: the AI's message is the whole result", "A guess the wrong way shows the line after a finished task",
    "`Still not done: requirement — why not done`"]) expect(verification).toContain(text);
  expect(verification).not.toContain("- [ ] requirement");
  expect(await read("docs/TERMINAL_UX.md")).toContain("No row comes after a task that ends asking you something or paused");
  expect(await read("site/tour.html")).toContain("<code>? Waiting for your answer</code> or <code>Paused</code>");
  const choices = await deliberateChoices();
  expect(choices).toContain("# 33. No receipt card until the task is done");
  expect(choices).toContain("A finding: a card hidden for a failure, a stop or a secret");
});
