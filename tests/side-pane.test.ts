import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SidePane } from "../src/tui/side-pane";
import { hostCommand, type HostCommand } from "../src/tui/host-terminal";
import { privateTmux } from "./support/private-tmux";
import { run as runFixture } from "./support/run";

const mux = await privateTmux();
afterAll(async () => { await mux?.close(); });
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Stand-in user session on the private server, excluding its keepalive session from pane assertions. */
async function tmuxServer() {
  await mux!.run("new-session", "-d", "-s", "user", "-x", "200", "-y", "50", "sleep 600");
  cleanups.push(() => mux!.run("kill-session", "-t", "user"));
  const socket = (await mux!.run("display-message", "-p", "-t", "user", "#{socket_path}")).trim();
  const pid = (await mux!.run("display-message", "-p", "-t", "user", "#{pid}")).trim();
  const userPane = (await mux!.run("display-message", "-p", "-t", "user", "#{pane_id}")).trim();
  const env = { ...mux!.env, TMUX: `${socket},${pid},0`, TMUX_PANE: userPane };
  const panes = async () => (await mux!.run("list-panes", "-s", "-t", "user", "-F", "#{pane_id} #{pane_active} #{pane_input_off}")).trim().split("\n");
  // SidePane's public API is synchronous. Run it in a bounded standalone child, never in the parallel worker.
  const exercise = (mode: string, watchedPid?: number) => runFixture([process.execPath, path.join(import.meta.dir, "fixtures/side-pane-tmux.ts"), mode, mux!.server, ...(watchedPid ? [String(watchedPid)] : [])], { env, timeoutMs: 20_000 });
  return { userPane, panes, exercise };
}

test.skipIf(!mux)("inside tmux the steps pane opens beside Casper, view only, and closes at exit without touching the user's pane", async () => {
  const server = await tmuxServer();
  const result = await server.exercise("content");
  expect({ status: result.status, stderr: result.stderr, timedOut: result.timedOut }).toMatchObject({ status: 0, timedOut: false });
  const { opened, screen, afterKeys, remaining, fileExists } = JSON.parse(result.stdout);
  expect(opened).toHaveLength(2);
  const user = opened.find((line: string) => line.startsWith(`${server.userPane} `))!;
  const steps = opened.find((line: string) => !line.startsWith(`${server.userPane} `))!;
  expect(user).toBe(`${server.userPane} 1 0`);
  expect(steps.endsWith(" 0 1")).toBe(true);
  expect(screen).toContain("view only");
  expect(screen).toContain("• bash · npm test");
  expect(screen.match(/Waiting for model/g)).toHaveLength(1);
  expect(afterKeys).not.toContain("rm -rf");
  expect(remaining).toHaveLength(1);
  expect(remaining[0]).toStartWith(`${server.userPane} `);
  expect(fileExists).toBe(false);
});

test.skipIf(!mux)("a Casper that is killed outright still leaves no steps pane behind", async () => {
  const server = await tmuxServer();
  const child = Bun.spawn(["sleep", "600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  cleanups.push(async () => { child.kill(); await child.exited; });
  const result = await server.exercise("watch", child.pid);
  expect({ status: result.status, stderr: result.stderr, timedOut: result.timedOut }).toMatchObject({ status: 0, timedOut: false });
  const { opened, remaining } = JSON.parse(result.stdout);
  expect(opened).toHaveLength(2);
  expect(remaining).toHaveLength(1);
  expect(remaining[0]).toStartWith(`${server.userPane} `);
});

test.skipIf(!mux)("a Casper that crashes closes its steps pane on the way out", async () => {
  const server = await tmuxServer();
  const result = await server.exercise("crash");
  expect(result.timedOut).toBe(false);
  expect(result.status).not.toBe(0);
  expect(result.status).not.toBe(3);
  expect(result.stderr).toContain("error: crash");
  // Closed by the exit handler, not the once-a-second watch: gone as soon as the process is.
  expect(await server.panes()).toHaveLength(1);
  expect(existsSync(result.stdout.trim())).toBe(false);
});

test("outside tmux and iTerm2 there is no pane, and nothing is run", () => {
  const calls: string[][] = [];
  const run: HostCommand = argv => { calls.push([...argv]); return { status: 0, stdout: "%9\n" }; };
  expect(SidePane.open({ host: { tmux: false, iterm: false }, run })).toBeUndefined();
  // TERM says tmux, but this machine is not inside it (ssh from a tmux pane): no pane to split.
  expect(SidePane.open({ host: { tmux: true, iterm: false }, run })).toBeUndefined();
  // iTerm2 needs its session id and a Mac.
  expect(SidePane.open({ host: { tmux: false, iterm: true, itermSession: "ABCDEF12-3456" }, run, platform: "linux" })).toBeUndefined();
  expect(calls).toEqual([]);
});

test("in iTerm2 the pane is a split next to Casper's own session, closed by its own id", () => {
  const calls: string[][] = [];
  const run: HostCommand = argv => { calls.push([...argv]); return { status: 0, stdout: calls.length === 1 ? "11111111-2222-3333\n" : "" }; };
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "casper-iterm-"));
  cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
  const pane = SidePane.open({ host: { tmux: false, iterm: true, itermSession: "ABCDEF12-3456" }, run, platform: "darwin", tempDir })!;
  expect(pane).toBeDefined();
  expect(calls[0]![0]).toBe("osascript");
  expect(calls[0]!.join("\n")).toContain('unique id of s is "ABCDEF12-3456"');
  expect(calls[0]!.join("\n")).toContain("split vertically");
  pane.log("• bash · ls");
  expect(readFileSync(pane.file, "utf8")).toContain("• bash · ls");
  pane.close();
  expect(calls[1]!.join("\n")).toContain('unique id of s is "11111111-2222-3333" then close s');
  pane.close();
  expect(calls).toHaveLength(2);
});

test("secrets in a step never reach the pane's log", () => {
  const run: HostCommand = () => ({ status: 0, stdout: "%7\n" });
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "casper-pane-"));
  cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
  const pane = SidePane.open({ host: { tmux: true, tmuxPane: "%1", iterm: false }, run, tempDir })!;
  cleanups.push(() => pane.close());
  pane.log("• bash · curl -H 'Authorization: PVEAPIToken=root@pam!lab=0f6c1a52-8e0f-4a57-9d4e-3b3f2b1c9a77' https://pve:8006");
  const text = readFileSync(pane.file, "utf8");
  expect(text).not.toContain("0f6c1a52-8e0f-4a57-9d4e-3b3f2b1c9a77");
  // A helper's goal is the model's own words: a lab login written as prose, an sshpass password.
  pane.log("helper explorer started: log in to the lab as root / Example-Pass-2024! and list the VMs");
  pane.log("helper explorer started: run sshpass -p Hunter-22x ssh root@10.0.0.5 uptime");
  const after = readFileSync(pane.file, "utf8");
  expect(after).not.toContain("Example-Pass-2024");
  expect(after).not.toContain("Hunter-22x");
  expect(after).toContain("root / <secret hidden>");
});

test("the host command runner never goes through a shell", () => {
  // The runtime echoes its last argument (Windows has no printf program); a shell would expand it.
  const out = hostCommand()([process.execPath, "-e", "process.stdout.write(process.argv.at(-1))", "$HOME;echo x %PATH%"]);
  expect(out.stdout).toBe("$HOME;echo x %PATH%");
});

test("the pane logs each step once: a growing size, a timer or an output line that comes back is not a new line", () => {
  const run: HostCommand = () => ({ status: 0, stdout: "%7\n" });
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "casper-pane-"));
  cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
  let second = 0;
  const pane = SidePane.open({ host: { tmux: true, tmuxPane: "%1", iterm: false }, run, tempDir, now: () => new Date(2026, 0, 1, 12, 0, ++second) })!;
  cleanups.push(() => pane.close());
  // Working-box frames as Casper draws them during one task.
  const ping = "• bash · ping 15 …";
  const less = "↳ Reply from 127.0.0.1: bytes=32 time<1ms TTL=128", one = "↳ Reply from 127.0.0.1: bytes=32 time=1ms TTL=128";
  for (const frame of [["Reasoning"], ["Reasoning · 1.5k chars"], ["Reasoning · 3.0k chars"], ["Preparing write · 4.0k chars"], ["Preparing write · 512 chars"],
    [ping], [ping, less], [`${ping} · 11s`, one], [`${ping} · 12s`, less], [`${ping} · 1m05s`, one], ["Waiting for fixture/fixture · 14s"]]) pane.show(frame);
  const lines = readFileSync(pane.file, "utf8").trim().split("\n").slice(1).map(line => line.slice(9));
  expect(lines).toEqual(["Reasoning", "Preparing write", ping, less, one, "Waiting for fixture/fixture"]);
});
