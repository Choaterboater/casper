import { expect, test } from "bun:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { BackgroundCommands } from "../src/runtime/background-commands";
import { followLogHint, remoteLog, TIME_LIMIT_NOTE, wrapsTimeLimit } from "../src/runtime/command-hints";
import { casperBashOperations } from "../src/runtime/pi";

/** From a live session: with no `timeout` on macOS the AI wrapped each remote command in `perl -e 'alarm N; exec …'`, then
 * started a remote build into a log and polled it with `sleep 90; ssh … tail`, so the screen said only "Running sleep 90". */

const BUILD = "ssh nas 'cd /srv/app && nohup docker compose up -d --build > /tmp/app-build.log 2>&1 &'";

test("a command wrapped in its own time limit is told to use the bash tool's timeout", () => {
  for (const wrapped of [
    "perl -e 'alarm 25; exec @ARGV' ssh nas 'docker ps'",
    "timeout 30 ssh nas uptime",
    "gtimeout -s KILL 30 make test",
    "cd app && timeout 5s curl -s http://192.0.2.10/",
  ]) expect(wrapsTimeLimit(wrapped)).toBe(true);
  for (const plain of ["echo timeout", "ssh -o ConnectTimeout=5 nas uptime", "curl --max-time 5 http://192.0.2.10/", "grep timeout src/x.ts", "perl -e 'print 1'"])
    expect(wrapsTimeLimit(plain)).toBe(false);
  expect(TIME_LIMIT_NOTE).toContain("timeout");
});

test("a remote job that writes a log, or a wait-then-read of one, is told to follow the log in the background", () => {
  expect(remoteLog(BUILD)).toEqual({ host: "nas", log: "/tmp/app-build.log" });
  expect(remoteLog("perl -e 'alarm 25; exec @ARGV' ssh -p 2222 admin@nas 'docker compose build > /tmp/b.log 2>&1'")).toEqual({ host: "admin@nas", log: "/tmp/b.log" });
  expect(remoteLog("sleep 90; ssh nas 'tail -5 /tmp/app-build.log'")).toEqual({ host: "nas", log: "/tmp/app-build.log" });
  expect(remoteLog("while true; do sleep 30; ssh nas cat /tmp/app-build.log; done")).toEqual({ host: "nas", log: "/tmp/app-build.log" });
  // Reading a log once, a short wait, a local job, output thrown away: nothing to follow.
  for (const none of ["ssh nas 'tail -5 /tmp/app-build.log'", "sleep 2; ssh nas tail /tmp/x.log", "nohup make > build.log 2>&1 &",
    "ssh nas 'nohup ./run.sh > /dev/null 2>&1 &'", "ssh nas uptime", "sleep 90; tail -5 build.log"]) expect(remoteLog(none)).toBeUndefined();
  const hint = followLogHint({ host: "nas", log: "/tmp/app-build.log" });
  expect(hint).toContain("ssh nas tail -f /tmp/app-build.log");
  expect(hint).toContain("background: true");
  expect(hint.split("\n")).toHaveLength(1);
});

function shell() {
  const commands = new BackgroundCommands({ notify() {} });
  const local: BashOperations = { exec: async (_command, _cwd, options) => { options.onData(Buffer.from("ok\n")); return { exitCode: 0 }; } };
  const ops = casperBashOperations({ wrap: async (command) => ({ command }), background: () => commands }, local);
  return async (command: string, timeout?: number) => {
    let out = "";
    await ops.exec(command, process.cwd(), { onData: (data: Buffer) => { out += data.toString("utf8"); }, ...(timeout ? { timeout } : {}) });
    await commands.close();
    return out;
  };
}

test("the hints come in the command's own result, once each, never for a plain command", async () => {
  const wrapped = await shell()("perl -e 'alarm 25; exec @ARGV' ssh nas 'docker ps'", 30);
  expect(wrapped.split(TIME_LIMIT_NOTE)).toHaveLength(2);
  const build = await shell()(BUILD, 30);
  expect(build).toContain("ssh nas tail -f /tmp/app-build.log");
  const poll = await shell()("sleep 90; ssh nas 'tail -5 /tmp/app-build.log'", 120);
  expect(poll).toContain("ssh nas tail -f /tmp/app-build.log");
  const plain = await shell()("ssh nas uptime", 30);
  expect(plain).toBe("ok\n");
});
