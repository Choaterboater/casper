import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SidePane } from "../src/tui/side-pane";
import { hostCommand, type HostCommand } from "../src/tui/host-terminal";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function until(condition: () => boolean, deadline = 8000): Promise<void> {
  const limit = performance.now() + deadline;
  while (performance.now() < limit) { if (condition()) return; await Bun.sleep(25); }
  throw new Error("Condition was not reached before its deadline");
}

/** A private tmux server with one pane that stands for the user's own: never the developer's tmux. */
function tmuxServer() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "casper-tmux-"));
  const socket = path.join(dir, "sock");
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });
  expect(tmux("new-session", "-d", "-s", "user", "-x", "200", "-y", "50", "sleep 600").status).toBe(0);
  const pid = tmux("display-message", "-p", "#{pid}").stdout.trim();
  const userPane = tmux("display-message", "-p", "-t", "user", "#{pane_id}").stdout.trim();
  cleanups.push(() => { tmux("kill-server"); rmSync(dir, { recursive: true, force: true }); });
  const env = { ...process.env, TMUX: `${socket},${pid},0`, TMUX_PANE: userPane };
  const panes = () => tmux("list-panes", "-a", "-F", "#{pane_id} #{pane_active} #{pane_input_off}").stdout.trim().split("\n");
  const capture = (pane: string) => tmux("capture-pane", "-p", "-t", pane).stdout;
  return { env, userPane, panes, capture, tmux };
}

test.skipIf(!hasTmux)("inside tmux the steps pane opens beside Casper, view only, and closes at exit without touching the user's pane", async () => {
  const server = tmuxServer();
  const pane = SidePane.open({ host: { tmux: true, tmuxPane: server.userPane, iterm: false }, env: server.env })!;
  expect(pane).toBeDefined();
  cleanups.push(() => pane.close());
  const panes = server.panes();
  expect(panes).toHaveLength(2);
  const [user, steps] = [panes.find(line => line.startsWith(`${server.userPane} `))!, panes.find(line => !line.startsWith(`${server.userPane} `))!];
  // The user's pane keeps focus; the steps pane takes no input.
  expect(user).toBe(`${server.userPane} 1 0`);
  expect(steps.endsWith(" 0 1")).toBe(true);
  const id = steps.split(" ")[0]!;
  pane.show(["• bash · npm test", "Waiting for model · 3s"]);
  pane.show(["• bash · npm test", "Waiting for model · 4s"]);
  pane.log("helper explorer · ✓ read · src/app.ts");
  await until(() => server.capture(id).includes("helper explorer"));
  const screen = server.capture(id);
  expect(screen).toContain("view only");
  expect(screen).toContain("• bash · npm test");
  // The running timer is not a new line.
  expect(screen.match(/Waiting for model/g)).toHaveLength(1);
  // Keys sent to it go nowhere.
  server.tmux("send-keys", "-t", id, "rm -rf /tmp/x", "Enter");
  expect(server.capture(id)).not.toContain("rm -rf");
  pane.close();
  await until(() => server.panes().length === 1);
  expect(server.panes()[0]).toStartWith(`${server.userPane} `);
  expect(existsSync(pane.file)).toBe(false);
});

test.skipIf(!hasTmux)("a Casper that is killed outright still leaves no steps pane behind", async () => {
  const server = tmuxServer();
  const child = Bun.spawn(["sleep", "600"]);
  cleanups.push(() => child.kill());
  const pane = SidePane.open({ host: { tmux: true, tmuxPane: server.userPane, iterm: false }, env: server.env, pid: child.pid })!;
  cleanups.push(() => pane.close());
  // The process it watches is not this one, so only the watch can close it.
  expect(server.panes()).toHaveLength(2);
  child.kill("SIGKILL");
  await until(() => server.panes().length === 1);
  expect(server.panes()[0]).toStartWith(`${server.userPane} `);
});

test.skipIf(!hasTmux)("a Casper that crashes closes its steps pane on the way out", async () => {
  const server = tmuxServer();
  const script = `
    import { SidePane } from ${JSON.stringify(path.join(import.meta.dir, "..", "src", "tui", "side-pane.ts"))};
    const pane = SidePane.open({ host: { tmux: true, tmuxPane: process.env.TMUX_PANE, iterm: false } });
    if (!pane) process.exit(3);
    console.log(pane.file);
    throw new Error("crash");`;
  const result = spawnSync(process.execPath, ["-e", script], { env: server.env, encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.status).not.toBe(3);
  // Closed by the exit handler, not the once-a-second watch: gone as soon as the process is.
  expect(server.panes()).toHaveLength(1);
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
