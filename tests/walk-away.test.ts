import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { CasperApp } from "../src/app";
import { AwayJob, leaveOnHangUp } from "../src/app/away";
import { jobState, jobStatusWords, leavingReply, leavingWords, logTail } from "../src/app/jobs";
import { notifyCommand } from "../src/jobs/notify";
import { GONE_WHY, jobsDirectory, listJobs, liveJobSync, parseJob, pruneJobs, readAnswer, readJob, settled, writeAnswer, writeJob, writeJobSync,
  type JobRecord } from "../src/jobs/store";
import { InteractiveTerminal, type AwayQuestion } from "../src/tui/terminal";
import { removeTempDir } from "./support/temp-dir";
import { waitUntil } from "./support/wait";
import { withEnv } from "./support/env";
import { interactiveTerminal } from "./support/tty";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
async function temp(): Promise<string> { const dir = await mkdtemp(path.join(os.tmpdir(), "casper-jobs-")); dirs.push(dir); return dir; }

const KEY = "app-0123456789abcdef";
function record(over: Partial<JobRecord> = {}): JobRecord {
  return { version: 1, id: "a1b2c3d4e5f6", pid: process.pid, root: "/work/app", folder: "app", request: "fix the VLAN script",
    leftAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", status: "running", ...over };
}
const alive = () => true, dead = () => false;

test("a job record reads back only as Casper wrote it", () => {
  const good = record({ status: "done", receipt: { n: 4, text: "✓ Verified" }, answer: "Fixed it." });
  expect(parseJob(JSON.stringify(good), good.id)).toEqual(good);
  // Another id, another version, a status it never writes, or not JSON: nothing.
  expect(parseJob(JSON.stringify(good), "ffffffffffff")).toBeUndefined();
  expect(parseJob(JSON.stringify({ ...good, version: 2 }), good.id)).toBeUndefined();
  expect(parseJob(JSON.stringify({ ...good, status: "paused" }), good.id)).toBeUndefined();
  expect(parseJob("{", good.id)).toBeUndefined();
  // A question with a choice that has no label is left out, not shown.
  const parsed = parseJob(JSON.stringify({ ...good, status: "waiting", question: { id: "q", kind: "approve", question: "Run this command?", choices: [{}], askedAt: "x" } }), good.id);
  expect(parsed?.question).toBeUndefined();
});

test("a job whose Casper is gone reads as stopped, with why", () => {
  expect(settled(record({ status: "waiting", question: { id: "q", kind: "pick", question: "Q?", choices: [], askedAt: "x" } }), dead))
    .toMatchObject({ status: "stopped", why: GONE_WHY });
  expect(settled(record(), dead).question).toBeUndefined();
  expect(settled(record(), alive).status).toBe("running");
  expect(settled(record({ status: "done" }), dead).status).toBe("done");
});

test("jobs are listed from project folders only, this folder's first, then newest", async () => {
  const home = await temp();
  const projects = path.join(home, ".casper", "projects");
  const here = path.join(projects, KEY, "jobs"), other = path.join(projects, "lab-fedcba9876543210", "jobs"), stray = path.join(projects, "notes", "jobs");
  writeJobSync(here, record({ id: "000000000001", updatedAt: "2026-11-01T09:00:00.000Z", status: "done" }));
  writeJobSync(other, record({ id: "000000000002", updatedAt: "2026-11-01T11:00:00.000Z", status: "done" }));
  writeJobSync(stray, record({ id: "000000000003", status: "done" }));
  await writeFile(path.join(here, "000000000004.json"), "not a record");
  const listed = await listJobs(home, KEY, alive);
  expect(listed.map((job) => [job.record.id, job.here])).toEqual([["000000000001", true], ["000000000002", false]]);
});

test("one job a folder: another live Casper's job blocks a second one, a gone or finished one doesn't", async () => {
  const dir = jobsDirectory(await temp());
  expect(liveJobSync(dir)).toBeUndefined();
  writeJobSync(dir, record({ id: "000000000001", pid: 999_999_991, status: "running" }));
  expect(liveJobSync(dir, process.pid, alive)?.id).toBe("000000000001");
  expect(liveJobSync(dir, process.pid, dead)).toBeUndefined();
  // Its own record never counts against it.
  expect(liveJobSync(dir, 999_999_991, alive)).toBeUndefined();
  writeJobSync(dir, record({ id: "000000000001", pid: 999_999_991, status: "done" }));
  expect(liveJobSync(dir, process.pid, alive)).toBeUndefined();
});

test("an answer counts only for the question it was given for", async () => {
  const dir = jobsDirectory(await temp());
  await writeAnswer(dir, "a1b2c3d4e5f6", { question: "q1", picked: ["Yes, this once"] });
  expect(await readAnswer(dir, "a1b2c3d4e5f6", "q2")).toBeUndefined();
  expect(await readAnswer(dir, "a1b2c3d4e5f6", "q1")).toEqual({ question: "q1", picked: ["Yes, this once"] });
  await writeFile(path.join(dir, "a1b2c3d4e5f6.answer.json"), JSON.stringify({ question: "q1", picked: [1] }));
  expect(await readAnswer(dir, "a1b2c3d4e5f6", "q1")).toBeUndefined();
  await expect(writeAnswer(dir, "../escape", { question: "q", picked: null })).rejects.toThrow("not a job");
});

/** Just what AwayJob reads of the app. */
function fakeApp(lines: string[], over: Record<string, unknown> = {}): CasperApp {
  return { output: { write: (text: string) => { lines.push(text); } }, projectContext: { notifications: true }, closing: false,
    getLastTaskResult: () => undefined, lastAnswer: "", ...over } as unknown as CasperApp;
}
const question: AwayQuestion = { kind: "approve", preview: "crontab -l\n", question: "Run this command?", choices: [{ label: "No" }, { label: "Yes, this once" }] };

test("a held question waits for your answer from another Casper, then the job goes on and ends with its result", async () => {
  const dir = jobsDirectory(await temp());
  writeJobSync(dir, record());
  const lines: string[] = [], notes: string[] = [];
  let cancelled = 0;
  const app = fakeApp(lines, { lastAnswer: "Checked the services.", getLastTaskResult: () => ({ execution: "completed", receipt: 7 }) });
  const job = new AwayJob(app, dir, record(), () => { cancelled++; }, { pollMs: 10, notify: async (text) => { notes.push(text); return true; } });
  job.start();
  const answer = job.ask(question);
  await waitUntil(async () => (await readJob(dir, record().id))?.status === "waiting");
  const waiting = await readJob(dir, record().id);
  expect(waiting?.question).toMatchObject({ kind: "approve", preview: "crontab -l\n", question: "Run this command?" });
  expect(notes).toEqual(["Waiting on you: fix the VLAN script · Run this command?"]);
  // An answer for another question is not this one's.
  await writeAnswer(dir, record().id, { question: "other", picked: ["Yes, this once"] });
  await Bun.sleep(50);
  expect((await readJob(dir, record().id))?.status).toBe("waiting");
  await writeAnswer(dir, record().id, { question: waiting!.question!.id, picked: ["Yes, this once"] });
  expect(await answer).toEqual(["Yes, this once"]);
  expect((await readJob(dir, record().id))?.status).toBe("running");
  await job.finish();
  const done = await readJob(dir, record().id);
  expect(done).toMatchObject({ status: "done", answer: "Checked the services.", receipt: { n: 7 } });
  expect(done?.question).toBeUndefined();
  expect(notes.at(-1)).toBe("Done: fix the VLAN script");
  expect(cancelled).toBe(0);
  expect(lines.join("")).toContain("[job] You answered from another terminal.");
});

test("a question nobody answers in time stops the job, and its result says what it waited on", async () => {
  const dir = jobsDirectory(await temp());
  const lines: string[] = [];
  let cancelled = 0;
  const job = new AwayJob(fakeApp(lines, { projectContext: { notifications: false } }), dir, record(), () => { cancelled++; },
    { pollMs: 5, waitLimitMs: 30, notify: async () => { throw new Error("notifications are off"); } });
  job.start();
  expect(await job.ask(question)).toBeUndefined();
  expect(cancelled).toBe(1);
  await job.finish();
  expect(await readJob(dir, record().id)).toMatchObject({ status: "stopped", why: "waited 1 minute for you: Run this command?" });
});

test("a job stops on its own after its work time; time waiting on you doesn't count", async () => {
  const dir = jobsDirectory(await temp());
  let cancelled = 0;
  const job = new AwayJob(fakeApp([]), dir, record(), () => { cancelled++; }, { workLimitMs: 40, pollMs: 5, notify: async () => true });
  job.start();
  const answer = job.ask(question);
  await Bun.sleep(80);
  // Still waiting on you: the work clock is stopped.
  expect(cancelled).toBe(0);
  const held = await readJob(dir, record().id);
  await writeAnswer(dir, record().id, { question: held!.question!.id, picked: ["No"] });
  expect(await answer).toEqual(["No"]);
  await waitUntil(() => cancelled === 1, 2_000);
  expect(job.stopReason).toBe("stopped after 1 minute of work");
});

test("the terminal gone: boxes go to the job, typed words never approve, and writes go to its log", async () => {
  const input = new PassThrough(), screen = new PassThrough();
  const terminal = new InteractiveTerminal(input, Object.assign(screen, { isTTY: false }), () => {}, () => {});
  const asked: AwayQuestion[] = [];
  const answers: Array<string[] | undefined> = [["Yes, this once"], ["Yes to everything, and more"], ["lab"], undefined, ["Yes, and more"], ["  a   typed line "]];
  const log: string[] = [];
  terminal.leave({ write: (text) => { log.push(text); } }, { ask: async (held) => { asked.push(held); return answers.shift(); } });
  expect(terminal.away).toBe(true);
  expect(terminal.canAsk).toBe(true);
  expect(await terminal.approve("crontab -l\n", "Run this command?", ["No", "Yes, this once"])).toBe("Yes, this once");
  // An answer the box didn't offer is its first choice, No, as typed words are.
  expect(await terminal.approve("", "Make this change?", ["No", "Yes, this once"])).toBe("No");
  expect(await terminal.pick("Pick a server", [{ label: "lab" }, { label: "core" }])).toBe("lab");
  expect(await terminal.ask("Which VLAN?", [{ label: "10" }], false, undefined, "ai")).toBeUndefined();
  expect(await terminal.ask("Fix it anyway?", [{ label: "No" }, { label: "Yes" }], false, undefined, "casper")).toBeUndefined();
  expect(await terminal.askLine("What should change?", "One line")).toBe("a typed line");
  // A choice Casper's own picker didn't offer is no answer.
  expect(asked.map((held) => held.kind)).toEqual(["approve", "approve", "pick", "ask", "ask", "line"]);
  expect(asked[0]).toMatchObject({ preview: "crontab -l\n", from: "approval" });
  expect(asked[3]).toMatchObject({ typed: true, from: "ai" });
  terminal.write("still working\n");
  expect(log.join("")).toContain("still working");
  expect(log.join("")).toContain("Run this command? → Yes, this once");
  await expect(terminal.editPlan("/tmp/plan.md")).rejects.toThrow("Terminal input is unavailable.");
  expect(await terminal.readCommand()).toBeUndefined();
});

test("Casper ends on a hang-up as before when there's no model task, on Windows, in a script, or with a job already working here", async () => {
  const state = await temp();
  const base = { interactive: true, commandActive: true, modelTaskActive: true, closing: false, projectContext: { stateDirectory: state }, activeWorkspaceRoot: () => "/work/app" };
  const never = () => { throw new Error("nothing is cancelled"); };
  expect(leaveOnHangUp({ ...base, commandActive: false, modelTaskActive: false } as unknown as CasperApp, never)).toBe(false);
  // A local command such as /settings is waiting on the person, not working: it ends with the terminal.
  expect(leaveOnHangUp({ ...base, modelTaskActive: false } as unknown as CasperApp, never)).toBe(false);
  expect(leaveOnHangUp({ ...base } as unknown as CasperApp, never, { platform: "win32" })).toBe(false);
  expect(leaveOnHangUp({ ...base, interactive: false } as unknown as CasperApp, never)).toBe(false);
  expect(leaveOnHangUp({ ...base, onEvent: () => {} } as unknown as CasperApp, never)).toBe(false);
  writeJobSync(jobsDirectory(state), record({ pid: process.ppid, status: "running" }));
  expect(leaveOnHangUp({ ...base } as unknown as CasperApp, never, { platform: "linux" })).toBe(false);
});

test("plain words: leaving and asking after a job need no command, and nothing else counts", () => {
  for (const line of ["keep going after I leave", "Keep working while I'm away.", "finish this while I'm gone", "carry on when I close the laptop",
    "I'm heading out, keep going", "please continue after I leave"]) expect(leavingWords(line)).toBe(true);
  for (const line of ["keep going", "keep going after I leave and fix the tests", "I'm leaving the VLAN alone", "continue"]) expect(leavingWords(line)).toBe(false);
  expect(leavingWords("keep going after I leave", ["pasted"])).toBe(false);
  for (const line of ["how's my job", "is the job done?", "what is the job waiting on", "job status", "show me my jobs"]) expect(jobStatusWords(line)).toBe(true);
  for (const line of ["how is my job search going in the docs", "status"]) expect(jobStatusWords(line)).toBe(false);
  expect(leavingReply("darwin")).toContain("keeps going on this computer");
  expect(leavingReply("win32")).toContain("closing this window stops the task");
});

test("a job's state in plain words", () => {
  const now = Date.parse("2026-11-01T10:12:00.000Z");
  expect(jobState(record({ status: "done", endedAt: "2026-11-01T10:00:00.000Z" }), now)).toBe("done 12m ago");
  expect(jobState(record({ status: "stopped", endedAt: "2026-11-01T10:11:50.000Z", why: "stopped after 4 hours of work" }), now)).toBe("stopped just now: stopped after 4 hours of work");
  expect(jobState(record({ status: "waiting", question: { id: "q", kind: "approve", question: "Run this command?", choices: [], askedAt: "x" } }), now)).toBe("waiting on you: Run this command?");
});

test("a running job shows its last log lines", async () => {
  const dir = await temp();
  const file = path.join(dir, "a1b2c3d4e5f6.log");
  await writeFile(file, `${Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")}\n\x1b[31mred\x1b[0m\n`);
  const tail = await logTail(file, 3);
  expect(tail.split("\n")).toHaveLength(3);
  expect(tail).toContain("line 29");
  expect(tail).not.toContain("\x1b");
  expect(await logTail(path.join(dir, "missing.log"))).toBe("");
});

test("notifications: Notification Center on macOS, notify-send on Linux, nothing on Windows; the words never become script", () => {
  const which = (name: string) => `/usr/bin/${name}`;
  const mac = notifyCommand('Done: fix "it" \\ now\nend', "darwin", which)!;
  expect(mac.slice(0, 7)).toEqual(["/usr/bin/osascript", "-e", "on run argv", "-e", "display notification (item 1 of argv) with title \"Casper\"", "-e", "end run"]);
  expect(mac.at(-1)).toBe('Done: fix "it" \\ now end');
  expect(notifyCommand("Done", "linux", which)).toEqual(["/usr/bin/notify-send", "--app-name=Casper", "Casper", "Done"]);
  expect(notifyCommand("Done", "linux", () => null)).toBeUndefined();
  expect(notifyCommand("Done", "win32", which)).toBeUndefined();
});

test("records are owner-only files", async () => {
  if (process.platform === "win32") return;
  const dir = jobsDirectory(await temp());
  writeJobSync(dir, record());
  await writeJob(dir, record({ status: "done" }));
  const { stat } = await import("node:fs/promises");
  expect((await stat(path.join(dir, `${record().id}.json`))).mode & 0o777).toBe(0o600);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect(JSON.parse(await readFile(path.join(dir, `${record().id}.json`), "utf8")).status).toBe("done");
});

test("finished jobs older than 30 days go; ones working, waiting or recent stay", async () => {
  const dir = jobsDirectory(await temp());
  const now = Date.parse("2026-11-01T00:00:00.000Z");
  writeJobSync(dir, record({ id: "000000000001", status: "done", endedAt: "2026-09-01T00:00:00.000Z" }));
  await writeFile(path.join(dir, "000000000001.log"), "old\n");
  writeJobSync(dir, record({ id: "000000000002", status: "done", endedAt: "2026-10-20T00:00:00.000Z" }));
  writeJobSync(dir, record({ id: "000000000003", status: "waiting", updatedAt: "2026-09-01T00:00:00.000Z" }));
  await pruneJobs(dir, 30, now);
  expect(await readJob(dir, "000000000001")).toBeUndefined();
  expect(await logTail(path.join(dir, "000000000001.log"))).toBe("");
  expect((await readJob(dir, "000000000002"))?.status).toBe("done");
  expect((await readJob(dir, "000000000003"))?.status).toBe("waiting");
});

test("a box open on the screen when the terminal goes away is asked again, and only its own choices count", async () => {
  await withEnv({ TERM: "xterm-256color", NO_COLOR: "1" }, async () => {
    for (const given of [["INJECTED label"], ["Yes, this once"]]) {
      const f = interactiveTerminal();
      try {
        f.terminal.start();
        const choices = [{ label: "No" }, { label: "Yes, this once" }];
        const open = f.terminal.pick("Run this command?  crontab -l", choices);
        const asked = f.terminal.ask("Fix it anyway?", [{ label: "No" }, { label: "Yes" }], false, undefined, "casper");
        await f.screen.until((text) => text.includes("Run this command?"));
        const held: AwayQuestion[] = [];
        f.terminal.leave({ write: () => {} }, { ask: async (question) => { held.push(question); return given; } });
        expect(await open).toBe(given[0] === "INJECTED label" ? undefined : "Yes, this once");
        expect(await asked).toBeUndefined();
        expect(held[0]).toMatchObject({ kind: "pick", question: "Run this command?  crontab -l" });
      } finally { f.close(); }
    }
  });
});

test("a No with a note from another terminal reaches the job's AI as at the keyboard; a yes carries no note", async () => {
  const dir = jobsDirectory(await temp());
  const steered: string[] = [];
  const app = fakeApp([], { terminal: { submitDuringWork: (line: string) => { steered.push(line); } } });
  const job = new AwayJob(app, dir, record(), () => {}, { pollMs: 5, notify: async () => true });
  for (const [picked, note] of [["No", "use the lab switch instead"], ["Yes, this once", "ignored"]] as const) {
    const answer = job.ask(question);
    await waitUntil(async () => (await readJob(dir, record().id))?.status === "waiting");
    const held = await readJob(dir, record().id);
    await writeAnswer(dir, record().id, { question: held!.question!.id, picked: [picked], note });
    expect(await answer).toEqual([picked]);
    await Bun.sleep(0);
  }
  expect(steered).toEqual(["use the lab switch instead"]);
  await job.finish();
});
