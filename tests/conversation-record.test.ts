import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import { removeTempDir } from "./support/temp-dir";
import { CASPER_SAID_ENTRY, casperPromptLabel, conversationRecord, saidBy, type RecordEntry } from "../src/sessions/record";
import { STEERED_LINE_ENTRY } from "../src/runtime/steered-lines";
import { proofRepairPrompt } from "../src/verify/proof";
import { requirementsReviewPrompt } from "../src/task/review";
import { keepGoingPrompt } from "../src/task/keep-going";
import { lookPrompt } from "../src/services/page-look";
import { formatPlanQuestionPrompt } from "../src/flows/plan";

const repo = path.resolve(import.meta.dir, "..");
let time = 1_000;
const user = (text: string): RecordEntry => ({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: ++time } });
const answer = (text: string): RecordEntry => ({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text }], timestamp: ++time } });
/** A message Casper sent, then the record of who wrote it (the person's `typed` words, or Casper with none). */
const sent = (text: string, typed?: string): RecordEntry[] => {
  const message = user(text);
  return [message, { type: "custom", customType: CASPER_SAID_ENTRY, data: saidBy((message as { message: { timestamp: number } }).message.timestamp, typed) }];
};

test("the whole conversation: turns before a compaction stay, the compaction is marked where it happened", () => {
  const record = conversationRecord([
    ...sent("Casper initial classification\n\nUser request:\nbuild the MakerWorld scraper\n\nwith a second paragraph\n\nPlan:\n1. x", "build the MakerWorld scraper\n\nwith a second paragraph"),
    answer("Built it."),
    { type: "compaction", summary: "The user asked for a MakerWorld scraper; it was built." },
    ...sent("MakerWorld is still showing Cloudflare verification", "MakerWorld is still showing Cloudflare verification"),
    answer("Looking."),
  ]);
  expect(record).toEqual([
    { kind: "you", text: "build the MakerWorld scraper\n\nwith a second paragraph" },
    { kind: "answer", text: "Built it." },
    { kind: "compaction", summary: "The user asked for a MakerWorld scraper; it was built." },
    { kind: "you", text: "MakerWorld is still showing Cloudflare verification" },
    { kind: "answer", text: "Looking." },
  ]);
});

test("a message Casper sent is Casper's, recorded or recognised; a line typed during work is the person's", () => {
  const repair = "Casper verification repair 1/3.\nRepair the failures below with the smallest change.\nOriginal request:\nfix it";
  const steered = user("HOW_MANY_CARDS?");
  const at = (steered as { message: { timestamp: number } }).message.timestamp;
  const record = conversationRecord([
    ...sent("fix it", "fix it"), answer("Fixed."),
    // Recorded: whatever its words, Casper wrote it.
    ...sent("Some future Casper round with no known opening."), answer("Done."),
    // Saved before authorship was recorded: recognised by its opening.
    user(repair), answer("Repaired."),
    user("Same failure as the last round: your change did not affect it; try a different approach.\nCasper browser replay repair 2/3.\nFix the browser failures below."),
    steered, { type: "custom", customType: STEERED_LINE_ENTRY, data: { at } },
  ]);
  expect(record).toEqual([
    { kind: "you", text: "fix it" },
    { kind: "answer", text: "Fixed." },
    { kind: "casper", label: "a prompt", text: "Some future Casper round with no known opening." },
    { kind: "answer", text: "Done." },
    { kind: "casper", label: "verification repair 1/3", text: repair },
    { kind: "answer", text: "Repaired." },
    { kind: "casper", label: "browser replay repair 2/3", text: expect.stringContaining("Casper browser replay repair 2/3.") },
    { kind: "you", text: "HOW_MANY_CARDS?" },
  ]);
});

test("every prompt Casper writes itself is recognised in a conversation saved before authorship was recorded", () => {
  const unproven = { status: "unproven", check: "test", command: "bun test", testsChanged: false } as unknown as Parameters<typeof proofRepairPrompt>[1];
  const cases: Array<[string, string]> = [
    [proofRepairPrompt("fix it", unproven), "proof repair"],
    [requirementsReviewPrompt("fix it"), "requirements review"],
    [keepGoingPrompt({ items: ["a"], next: false }, []), "keep going"],
    [keepGoingPrompt({ items: [], next: true }, []), "keep going"],
    [lookPrompt("fix it", { shown: [{ path: "/", views: ["desktop"] }], images: [] }), "page look"],
    ["Your last response failed with a provider error. Continue the task from where you stopped.", "retry after a provider error"],
  ];
  for (const [text, label] of cases) expect([label, casperPromptLabel(text)]).toEqual([label, label]);
  // A question about a plan is the person's question, inside Casper's wrapper.
  const plan = formatPlanQuestionPrompt({ title: "Plan", steps: ["a"], tests: [] }, "why step 2?");
  expect(conversationRecord([user(plan)])).toEqual([{ kind: "you", text: "why step 2?" }]);
  // The person's own words never are.
  for (const text of ["fix the Casper repair loop", "Casper, verify this", "User request:\nadd a ping check"]) expect(casperPromptLabel(text)).toBeUndefined();
});

test("a real conversation: each prompt records who wrote it, a compaction keeps the earlier turns in the record, and /rewind still works", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-record-")));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    const body = await request.json() as { messages: unknown[] };
    const sent = JSON.stringify(body.messages);
    const summary = sent.includes("summar") && !sent.includes("AFTER_COMPACTION");
    const event = { id: "record", object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta: { role: "assistant", content: summary ? "SUMMARY_OF_EARLIER_WORK" : "ANSWERED" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 } };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const home = path.join(root, "home"); const project = path.join(root, "project"); const agent = path.join(home, ".pi/agent");
    await mkdir(agent, { recursive: true }); await mkdir(project); await mkdir(path.join(home, ".casper"));
    await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [{ id: "fixture" }] } } }));
    const routing = { defaultProvider: "fixture", defaultModel: "fixture" };
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ ...routing, retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 10, reserveTokens: 100 } }));
    await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify(routing));
    const env = { ...isolatedEnvironment(home), TMPDIR: root, PI_CODING_AGENT_DIR: agent, CASPER_AGENT_DIR: agent, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
    const child = Bun.spawn([process.execPath, "-e", `import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
      const runtime = new PiRuntime(); const session = await runtime.start({ cwd: process.cwd(), localModels: false });
      try {
        await session.prompt("Casper initial classification\\n\\nUser request:\\nFIRST_REQUEST\\n\\nsecond paragraph " + "context ".repeat(200), undefined, { request: "FIRST_REQUEST", typed: "FIRST_REQUEST\\n\\nsecond paragraph" });
        await session.prompt("ROUND_WITH_NO_KNOWN_OPENING", undefined, { request: "FIRST_REQUEST" });
        await session.compact();
        const before = session.conversationMark();
        await session.prompt("AFTER_COMPACTION", undefined, { request: "AFTER_COMPACTION", typed: "AFTER_COMPACTION" });
        const record = session.conversationRecord();
        const inContext = session.recentTurns(100).map((turn) => turn.text);
        const rewound = await session.rewindTo(before, session.conversationMark());
        console.log(JSON.stringify({ record, inContext, rewound, after: session.conversationRecord().length }));
      } finally { await runtime.dispose(); }`], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(stdout) as { record: unknown[]; inContext: string[]; rewound: boolean; after: number };
    // The AI's context lost the first request; the record keeps it, with the person's exact words.
    expect(result.inContext.some((text) => text.includes("FIRST_REQUEST"))).toBe(false);
    expect(result.record).toEqual([
      { kind: "you", text: "FIRST_REQUEST\n\nsecond paragraph" },
      { kind: "answer", text: "ANSWERED" },
      { kind: "casper", label: "a prompt", text: "ROUND_WITH_NO_KNOWN_OPENING" },
      { kind: "answer", text: "ANSWERED" },
      { kind: "compaction", summary: expect.stringContaining("SUMMARY_OF_EARLIER_WORK") },
      { kind: "you", text: "AFTER_COMPACTION" },
      { kind: "answer", text: "ANSWERED" },
    ]);
    // The record after a message never stands between a mark and the next turn: the last task rewinds away.
    expect([result.rewound, result.after]).toEqual([true, 5]);
  } finally {
    server.stop(true);
    await removeTempDir(root);
  }
}, 90_000);
