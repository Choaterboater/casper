import { expect, test } from "bun:test";
import { onlyLooksOrWaits, waitLabel } from "../src/sandbox/waits";

/**
 * A command that only waits or polls (sleeps, and checks that change nothing) is stopped when the person sends the AI a
 * line, so the AI reads it now (src/runtime/pi.ts). A command that may change something is never stopped this way.
 */

test("a sleep, a poll loop, ssh … sleep and timeout or perl alarm wrappers around reads only wait, each named in a few words", () => {
  const waits: Array<[string, string]> = [
    ["sleep 90", "sleep 90"],
    ["sleep 120", "sleep 120"],
    [`n=0; while [ "\${n% }" -lt 20 ]; do ssh nas 'docker ps --format "{{.Names}} {{.Status}}"'; sleep 15; n=$((n+1)); done`, "sleep 15 loop"],
    ["for n in 1 2 3; do echo $n; sleep 20; done", "sleep 20 loop"],
    ["until curl -sf http://localhost:3000/health; do sleep 2; done", "sleep 2 loop"],
    ["while ! nc -z 127.0.0.1 5432; do sleep 1; done; echo up", "sleep 1 loop"],
    ["ssh nas sleep 30", "sleep 30"],
    ["ssh -o ConnectTimeout=5 nas 'sleep 30; docker ps -a'", "sleep 30"],
    ["timeout 25 ssh nas 'systemctl is-active docker'", "timeout 25"],
    ["perl -e 'alarm 25; exec @ARGV' ssh nas 'docker ps'", "alarm 25"],
    [`for i in $(seq 1 10); do perl -e 'alarm 25; exec @ARGV' ssh nas "docker logs --tail 5 app 2>&1"; sleep 10; done`, "sleep 10 loop"],
    [`while true; do echo "$(date +%T) $(ssh nas 'cat /proc/loadavg')"; sleep 15; [ -f /dev/null ] && break; done`, "sleep 15 loop"],
    ["sleep 120; tail -n 20 compare.out", "sleep 120"],
    ["bash -c 'sleep 5; docker ps' 2>/dev/null", "sleep 5"],
    ["tail -f server.log", "tail -f"],
    ["while sleep 5; do docker compose ps; journalctl -u docker -n 5 --no-pager; done", "sleep 5 loop"],
  ];
  for (const [command, label] of waits) expect({ command, label: waitLabel(command) }).toEqual({ command, label });
});

test("a command that may change something, or one Casper can't read, is never a wait, whatever sleeps around it", () => {
  for (const command of [
    "sleep 5; docker restart app",
    "while true; do curl -X POST http://localhost/x; sleep 5; done",
    "sleep 5 && rm -rf build",
    "sleep 10; echo done > status.txt",
    "ssh nas 'sleep 5; docker compose up -d'",
    "while true; do sleep 1; done &",
    "sleep 5; $CMD",
    "eval 'sleep 5'",
    "sleep 5; npm install",
    "sleep $(touch x; echo 5)",
    "sleep `echo 5`",
    "timeout 25 docker compose up",
    "perl -e 'alarm 5; system(\"rm x\")'",
    "ssh -o LocalCommand=date nas sleep 5",
    "sleep 5; curl -o page.html http://localhost",
    "sed -i s/a/b/ f; sleep 1",
    "sleep 1; docker exec app sh -c 'ls'",
    "while true; do sleep 1; done | tee log.txt",
    "cat <<EOF\nsleep 1\nEOF",
    "PATH=/tmp/x sleep 1",
    "sleep 5; ssh nas",
    "sleep 5; hostname newname",
    "sleep 2; systemctl restart docker",
  ]) expect({ command, label: waitLabel(command) }).toEqual({ command, label: undefined });
});

test("a plain read is not a wait (it moves to the background as before), but it only looks", () => {
  for (const command of ["ls -la", "cat notes.txt", "ssh nas 'docker ps'", "grep -r foo src"]) {
    expect({ command, label: waitLabel(command) }).toEqual({ command, label: undefined });
    expect({ command, looks: onlyLooksOrWaits(command) }).toEqual({ command, looks: true });
  }
  for (const command of ["touch x", "npm test", "docker restart app", "echo hi > a.txt"]) expect({ command, looks: onlyLooksOrWaits(command) }).toEqual({ command, looks: false });
});
