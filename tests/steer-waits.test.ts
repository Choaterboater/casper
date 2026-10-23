import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { deliberateChoices } from "../tools/adr-index";
import { SteerWaits } from "../src/app/steer-waits";
import { BackgroundCommands } from "../src/runtime/background-commands";
import { casperBashOperations } from "../src/runtime/pi";
import type { RuntimeShell } from "../src/runtime/types";
import { ServiceManager } from "../src/services/manager";
import { serviceTool } from "../src/services/tool";
import { removeTempDir } from "./support/temp-dir";

/**
 * A line the person sends while the AI works reaches it only once every tool call of the step has ended (Pi's agent
 * loop). A step that only waits ends when the line comes, so the AI reads it now: a slow shell command moves to the
 * background and a service start stops waiting for readiness; both keep running. The browser's sign-in window is in
 * tests/browser-signin.test.ts, the app's hook and the model's next request in tests/steer.test.ts.
 */
const unix = process.platform !== "win32";
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Polls `check` until it is true; it may act (steered() ends the waits it finds), so it is never called again after. */
const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= end) return false;
    await Bun.sleep(50);
  }
};

test("a wait listens until it ends: a line ends every wait listening then, once each, and none after", () => {
  const waits = new SteerWaits();
  const ended: string[] = [];
  waits.listen(() => ended.push("sign-in"));
  const stop = waits.listen(() => ended.push("ended another way"));
  stop();
  waits.listen(() => { throw new Error("a wait that fails"); });
  waits.listen(() => ended.push("command"));
  expect(waits.steered()).toBe(3);
  expect(ended).toEqual(["sign-in", "command"]);
  expect(waits.steered()).toBe(0);
  expect(ended).toEqual(["sign-in", "command"]);
});

function shell(options: { max?: number; ssh?: boolean } = {}) {
  const notes: string[] = [];
  const waits = new SteerWaits();
  const commands = new BackgroundCommands({ notify: (note) => { notes.push(note); }, limitSeconds: 60, ...(options.max === undefined ? {} : { max: options.max }) });
  cleanups.push(() => commands.close());
  const held: RuntimeShell = { wrap: async (command) => ({ command, ...(options.ssh ? { ssh: {} } : {}) }), background: () => commands, whenSteered: waits.listen };
  const bash = createBashToolDefinition(process.cwd(), { operations: casperBashOperations(held) });
  const run = async (command: string, timeout?: number) => {
    try {
      const result = await bash.execute("call", { command, ...(timeout ? { timeout } : {}) }, new AbortController().signal, undefined, undefined as never);
      return result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
    } catch (error) { return `error: ${(error as Error).message}`; }
  };
  return { notes, commands, waits, run };
}

test.skipIf(!unix)("a line sent while a slow command runs moves it to the background at once; it keeps running and its note comes when it ends", async () => {
  const { notes, commands, waits, run } = shell();
  const call = run("echo started; sleep 3; echo finished");
  // The line comes while it runs, long before the 60 s limit.
  expect(await until(() => waits.steered() > 0)).toBe(true);
  const text = await call;
  expect(text).toContain("[The person sent you a message, so after ");
  expect(text).toContain(" s this moved to the background as cmd-1 (stdin closed). Casper adds a note when it ends.");
  expect(text).toContain("To stop it: the service tool (stop, service cmd-1) when you have it; the person can use /tasks.]");
  expect(text).not.toContain("finished");
  expect(commands.list().map((entry) => entry.id)).toEqual(["cmd-1"]);
  expect(await until(() => notes.length > 0)).toBe(true);
  expect(notes[0]).toContain("[Background command cmd-1 ended with exit code 0");
  expect(notes[0]).toContain("finished");
  // Nothing listens once it moved.
  expect(waits.steered()).toBe(0);
}, 30_000);

test.skipIf(!unix)("with no room in the background, on Casper's ssh login or with its own time limit, the command runs on and the line waits, as before", async () => {
  for (const way of ["no room", "ssh login", "own limit"] as const) {
    const { notes, commands, waits, run } = shell(way === "no room" ? { max: 0 } : way === "ssh login" ? { ssh: true } : {});
    let done = false, told = 0;
    const call = run("sleep 1; echo finished", way === "own limit" ? 30 : undefined).finally(() => { done = true; });
    while (!done) { told += waits.steered(); await Bun.sleep(50); }
    expect({ way, text: await call }).toEqual({ way, text: "finished\n" });
    expect(commands.list()).toEqual([]);
    expect(notes).toEqual([]);
    // Only a command that could have moved listened for the line.
    expect({ way, told }).toEqual({ way, told: way === "no room" ? 1 : 0 });
  }
}, 30_000);

const SERVER = path.join(import.meta.dir, "fixtures", "service-server.ts");
const COMMAND = `"${process.execPath}" "${SERVER}"`;

/** A declared service that is ready only once `gate` exists (it listens first, then logs "listening"). */
async function service() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-steer-service-")));
  cleanups.push(() => removeTempDir(root));
  const gate = path.join(root, "release");
  const manager = new ServiceManager({ projectRoot: root, services: {
    api: { command: COMMAND, port: "auto", ready: { log: "listening" }, timeoutMs: 60_000, env: { READY_LOG_GATE: gate } },
  } });
  cleanups.push(() => manager.close().catch(() => {}));
  const waits = new SteerWaits();
  const tool = serviceTool(() => manager, undefined, undefined, undefined, undefined, waits.listen);
  const call = async (args: Record<string, unknown>, signal = new AbortController().signal) => {
    const result = await tool.execute(args, signal);
    const envelope = JSON.parse(result.text);
    return { isError: result.isError === true, data: envelope.data ?? envelope };
  };
  const state = (name: string) => manager.status().find((entry) => entry.name === name)?.state;
  return { gate, manager, waits, call, state };
}

test("a line sent while a service starts ends the wait, not the start: the call says it is starting, the turn's stop no longer reaches it, and it gets ready", async () => {
  const f = await service();
  const turn = new AbortController();
  const start = f.call({ action: "start", service: "api" }, turn.signal);
  expect(await until(() => f.waits.steered() > 0)).toBe(true);
  const started = await start;
  expect(started.isError).toBe(false);
  expect(started.data.service).toMatchObject({ name: "api", state: "starting" });
  expect(started.data.guidance).toBe("The person sent you a message, so this stopped waiting for the service to be ready. It keeps starting: read the message; status or logs show when it is ready.");
  // Esc after the call has returned: the service goes on starting, as one already ready would stay.
  turn.abort();
  await writeFile(f.gate, "");
  expect(await until(() => f.state("api") === "ready", 15_000)).toBe(true);
  // A restart's wait ends the same way, even while it still stops the old run.
  await rm(f.gate);
  const restart = f.call({ action: "restart", service: "api" });
  expect(await until(() => f.waits.steered() > 0)).toBe(true);
  expect((await restart).data.service).toMatchObject({ name: "api", state: "starting" });
  await writeFile(f.gate, "");
  expect(await until(() => f.state("api") === "ready", 15_000)).toBe(true);
  // With no line, a start waits for readiness as before, and nothing listens once it is ready.
  expect((await f.call({ action: "start", service: "api" })).data.service).toMatchObject({ name: "api", state: "ready" });
  expect(f.waits.steered()).toBe(0);
}, 60_000);

test("an ad-hoc start the line ends is reported under its own name, still starting", async () => {
  const f = await service();
  const start = f.call({ action: "start", command: COMMAND, ready: { log: "a line it never prints" }, timeoutMs: 60_000 });
  expect(await until(() => f.waits.steered() > 0)).toBe(true);
  const started = await start;
  expect(started.data.service).toMatchObject({ name: "adhoc-1", state: "starting" });
  expect(started.data.guidance).toContain("The person sent you a message");
  expect(f.state("adhoc-1")).toBe("starting");
}, 30_000);

test("the docs say which waits a line ends, that nothing is stopped, and which steps finish first", async () => {
  const read = async (name: string) => (await readFile(path.join(import.meta.dir, "..", name), "utf8")).replace(/\s+/g, " ");
  const terminal = await read("docs/TERMINAL_UX.md");
  for (const text of ["A line you send while the AI's step only waits ends that wait, so the AI reads the line now.",
    "moves to the background and keeps running", "`[browser] Closing the sign-in window so Casper reads your line; …`",
    "A service start stops waiting for readiness and keeps starting.", "a command with its own time limit or on Casper's ssh login",
    "a slow command when 4 already run in the background, MCP calls, helpers (`delegate`) and checks (`casper_check`)"]) expect(terminal).toContain(text);
  expect(await read("docs/CONFIGURATION.md")).toContain("A line you send the AI while one runs moves it to the background at once (when there is room)");
  const browser = await read("docs/BROWSER.md");
  expect(browser).toContain("A line you send the AI while the window is open closes it as if you had");
  expect(browser).toContain("(`window closed`, `cancelled`, `timed out` or `person wrote`)");
  expect(await read("docs/SERVICES.md")).toContain("ends the wait, not the start: the call says the service is `starting`");
  const choices = await deliberateChoices();
  expect(choices).toContain("# 26. A line you send ends a step that only waits");
  expect(choices).toContain("A finding: a line that stops work instead of ending a wait");
});
