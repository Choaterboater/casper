import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { answer, calls, cleanUpAfterEach, cli, fixture, type Payload } from "./support/phase8-pi";
import { privateTmux } from "./support/private-tmux";
import { projectStateDirectory } from "../src/project/model";
import { processAlive, type JobRecord } from "../src/jobs/store";

/**
 * Decision 51 end to end, with the real CLI in a real terminal (a private tmux): a task starts, its terminal is killed
 * (tmux hangs up the pane, as a closed window or a dropped SSH does), the task carries on as a job, and a new Casper in
 * another terminal shows the result with its Undo. tmux is not on Windows, where a job can't outlive its window anyway.
 */
cleanUpAfterEach();
const mux = await privateTmux({ timeoutMs: 10_000 });
afterAll(async () => { await mux?.close(); });

const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;

async function setUp(respond: (payload: Payload) => Response | Promise<Response>) {
  const f = await fixture(respond);
  const home = path.join(path.dirname(f.project), "home");
  const root = await realpath(f.project);
  // Your own settings: no desktop notifications from a test, no auto-mode judge (no extra model call), no updates.
  await writeFile(path.join(home, ".casper", "config.yaml"), "notifications: off\nauto_mode: off\nupdates: off\n");
  // The folder is one you trusted, so no "Trust this folder?" box first.
  const state = projectStateDirectory(root, home);
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, "trust.json"), JSON.stringify({ trusted: true }));
  const env = { HOME: home, CASPER_AGENT_DIR: f.agent, PI_CODING_AGENT_DIR: f.agent, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0",
    CASPER_NO_UPDATE_CHECK: "1", TERM: "xterm-256color", PATH: process.env.PATH ?? "/usr/bin:/bin" };
  // exec: the pane's own process is Casper, so the test knows its pid.
  const command = `cd ${quote(root)} && exec env -u NO_COLOR -u TMUX -u TMUX_PANE ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" ")} ${quote(process.execPath)} ${quote(cli)}`;
  const jobs = async (): Promise<JobRecord[]> => {
    const directory = path.join(state, "jobs");
    const names = (await readdir(directory).catch(() => [] as string[])).filter((name) => /^[0-9a-f]{12}\.json$/.test(name));
    return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8")) as JobRecord));
  };
  return { ...f, home, root, command, jobs };
}

function screen(name: string) {
  const capture = () => mux!.run("capture-pane", "-p", "-t", name, "-S", "-400");
  return {
    start: (command: string) => mux!.run("new-session", "-d", "-s", name, "-x", "100", "-y", "50", command),
    capture,
    wait: async (match: (text: string) => boolean, what: string, ms = 30_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { const text = await capture(); if (match(text)) return text; await Bun.sleep(100); }
      throw new Error(`terminal never showed ${what}:\n${await capture()}`);
    },
    type: async (text: string) => { await mux!.run("send-keys", "-t", name, "-l", text); await mux!.run("send-keys", "-t", name, "Enter"); },
    key: (key: string) => mux!.run("send-keys", "-t", name, key),
    pid: async () => Number((await mux!.run("display-message", "-p", "-t", name, "#{pane_pid}")).trim()),
    kill: () => mux!.run("kill-session", "-t", name).catch(() => ""),
  };
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`never saw ${what}: ${JSON.stringify(value)}`);
    await Bun.sleep(100);
  }
}

test.skipIf(!mux)("a task outlives its killed terminal; Casper in a new terminal shows the result, and Undo still works", async () => {
  const release = Promise.withResolvers<void>();
  let step = 0;
  const f = await setUp(async () => {
    const now = step++;
    if (now === 0) { await release.promise; return calls([{ name: "write", args: { path: "made.txt", content: "made while you were away\n" } }]); }
    return answer("Made made.txt while you were away.");
  });
  const first = screen("left"), back = screen("back");
  try {
    await first.start(f.command);
    await first.wait((text) => text.includes("idle"), "the idle prompt");
    await first.type("make the file");
    await until(async () => f.payloads.length, (count) => count === 1, "the model asked");
    const pid = await first.pid();
    // The terminal goes away mid-task.
    await first.kill();
    release.resolve();
    const [job] = await until(f.jobs, (list) => list[0]?.status === "done", "the job done");
    // The same Casper carried on: no new process, so this session's answers, servers and slow commands came with it.
    expect(job!.pid).toBe(pid);
    expect(job!.request).toBe("make the file");
    expect(job!.answer).toContain("Made made.txt while you were away.");
    expect(job!.receipt?.n).toBeGreaterThan(0);
    expect(await readFile(path.join(f.root, "made.txt"), "utf8")).toBe("made while you were away\n");
    // The job's Casper ends on its own once its result is saved.
    await until(async () => processAlive(job!.pid), (alive) => !alive, "the job's Casper end", 20_000);

    // From another terminal: the start's row offers the result; 1 shows it, and its row's Undo takes the file back.
    await back.start(f.command);
    const row = await back.wait((text) => /Next:.*See the job's result/.test(text.replace(/\s+/g, " ")), "the job's row");
    expect(row).toContain("make the file");
    // A row's key is one key press, no Enter.
    await back.key("1");
    // The row's keys work at the idle prompt, once the result is shown.
    const idle = (text: string) => /^idle /m.test(text.trimEnd().split("\n").at(-1) ?? "");
    const shown = await back.wait((text) => text.includes("Made made.txt while you were away.")
      && /Show diff\s+2\s+Undo/.test(text.split("Made made.txt while you were away.").at(-1)!) && idle(text), "the result and its Undo");
    expect(shown).toContain("made.txt");
    await back.key("2");
    await until(async () => existsSync(path.join(f.root, "made.txt")), (exists) => !exists, "the undo")
      .catch(async (error: Error) => { throw new Error(`${error.message}\n${await back.capture()}`); });
    expect((await f.jobs())[0]!.seen).toBe(true);
  } finally { await first.kill(); await back.kill(); }
}, 150_000);

test.skipIf(!mux)("a job holds a box for you; Casper in another terminal shows it, and the job carries on after your answer", async () => {
  const release = Promise.withResolvers<void>();
  let step = 0;
  const f = await setUp(async () => {
    const now = step++;
    if (now === 0) { await release.promise; return calls([{ name: "bash", args: { command: "crontab -l || true" } }]); }
    return answer("Checked the services after you said yes.");
  });
  const first = screen("away"), back = screen("answer");
  try {
    await first.start(f.command);
    await first.wait((text) => text.includes("idle"), "the idle prompt");
    await first.type("check the services");
    await until(async () => f.payloads.length, (count) => count === 1, "the model asked");
    await first.kill();
    release.resolve();
    const [waiting] = await until(f.jobs, (list) => list[0]?.status === "waiting", "the job waiting on you");
    expect(waiting!.question?.question).toStartWith("Run this command?");
    expect(`${waiting!.question?.preview}${waiting!.question?.question}`).toContain("crontab -l");
    // Nothing ran without you.
    expect(f.payloads).toHaveLength(1);

    await back.start(f.command);
    await back.wait((text) => /Next:.*Answer the job's question/.test(text.replace(/\s+/g, " ")), "the job's question on the row");
    await back.key("1");
    await back.wait((text) => text.includes("crontab -l") && text.includes("Yes, this once"), "the same box");
    // A box ignores keys for its first 300 ms (askDefaults.guardMs): they were typed before it appeared.
    await Bun.sleep(400);
    await back.key("2");
    await back.wait((text) => text.includes("[jobs] Sent."), "the answer sent");
    const [done] = await until(f.jobs, (list) => list[0]?.status === "done", "the job done after the answer")
      .catch(async (error: Error) => { throw new Error(`${error.message}\n${await back.capture()}`); });
    expect(done!.answer).toContain("Checked the services after you said yes.");
    // Your yes ran it: the AI got its output, not a refusal.
    expect(JSON.stringify(f.payloads[1]!.messages.at(-1))).not.toContain("Not run");
  } finally { await first.kill(); await back.kill(); }
}, 150_000);

test.skipIf(!mux)("with no task running, a closed terminal ends Casper as it always did, and leaves no job", async () => {
  const f = await setUp(() => answer("unused"));
  const idle = screen("idle");
  try {
    await idle.start(f.command);
    await idle.wait((text) => text.includes("idle"), "the idle prompt");
    const pid = await idle.pid();
    expect(processAlive(pid)).toBe(true);
    await idle.kill();
    await until(async () => processAlive(pid), (alive) => !alive, "Casper end", 20_000);
    expect(await f.jobs()).toEqual([]);
    expect(f.payloads).toHaveLength(0);
  } finally { await idle.kill(); }
}, 60_000);

test.skipIf(!mux)("SSH drops while a box is on the screen: the job keeps that box for you, and nothing ran", async () => {
  let step = 0;
  const f = await setUp(async () => {
    const now = step++;
    if (now === 0) return calls([{ name: "bash", args: { command: "crontab -l || true" } }]);
    return answer("Left the services alone.");
  });
  const first = screen("dropped"), back = screen("later");
  try {
    await first.start(f.command);
    await first.wait((text) => text.includes("idle"), "the idle prompt");
    await first.type("check the services");
    await first.wait((text) => text.includes("crontab -l") && text.includes("Yes, this once"), "the box on the screen");
    await first.kill();
    const [waiting] = await until(f.jobs, (list) => list[0]?.status === "waiting", "the job keeping the box");
    expect(`${waiting!.question?.preview}${waiting!.question?.question}`).toContain("crontab -l");
    expect(f.payloads).toHaveLength(1);

    await back.start(f.command);
    await back.wait((text) => /Next:.*Answer the job's question/.test(text.replace(/\s+/g, " ")), "the job's question on the row");
    await back.key("1");
    await back.wait((text) => text.includes("crontab -l") && text.includes("Yes, this once"), "the same box");
    // A box ignores keys for its first 300 ms (askDefaults.guardMs). 1 is No: it opens a line for a note to the AI,
    // and Enter on it empty sends a plain No (decision 45).
    await Bun.sleep(400);
    await back.key("1");
    await back.wait((text) => text.includes("Enter sends No"), "No's note line");
    await back.key("Enter");
    const [done] = await until(f.jobs, (list) => list[0]?.status === "done", "the job done after the No")
      .catch(async (error: Error) => { throw new Error(`${error.message}\n${await back.capture()}`); });
    expect(done!.answer).toContain("Left the services alone.");
    expect(JSON.stringify(f.payloads[1]!.messages.at(-1))).toContain("Not run: the user said no to this command.");
  } finally { await first.kill(); await back.kill(); }
}, 150_000);
