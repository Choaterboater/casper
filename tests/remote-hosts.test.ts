import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { remoteTargets, runsAlone, splitShell, targetLabel } from "../src/sandbox/remote";
import { remoteChanges } from "../src/task/remote-changes";

/**
 * Where the AI's shell commands go: ssh, scp, sftp, rsync, nc, telnet and socat, with ~/.ssh/config aliases resolved
 * by Casper itself. What a command sent over ssh changed on the other machine, from its text only.
 */

let home: string;
beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "casper-remote-"));
  await mkdir(path.join(home, ".ssh"));
  await writeFile(path.join(home, ".ssh/config"), "Host lab-01\n  HostName 192.168.10.20\n  User root\n  Port 2222\n\nHost *.lab\n  User admin\n");
});
afterAll(() => rm(home, { recursive: true, force: true }));

const hosts = (command: string) => remoteTargets(command, home).map(({ tool, typed, host, user, port }) => ({ tool, typed, host, ...(user ? { user } : {}), ...(port ? { port } : {}) }));

test("an ssh alias from ~/.ssh/config is resolved by Casper: the real address, user and port", () => {
  expect(hosts("ssh lab-01 uptime")).toEqual([{ tool: "ssh", typed: "lab-01", host: "192.168.10.20", user: "root", port: 2222 }]);
  expect(hosts("ssh -p 22 admin@10.0.0.5 'ls /'")).toEqual([{ tool: "ssh", typed: "10.0.0.5", host: "10.0.0.5", user: "admin", port: 22 }]);
  expect(hosts("ssh -oPort=2200 -l ops sw1 show version")).toEqual([{ tool: "ssh", typed: "sw1", host: "sw1", user: "ops", port: 2200 }]);
  expect(hosts("ssh ssh://root@pve.local:8022")).toEqual([{ tool: "ssh", typed: "pve.local", host: "pve.local", user: "root", port: 8022 }]);
});

test("jump hosts, sudo, sshpass and a pipe still name the machines they reach", () => {
  expect(hosts("sudo ssh -J jump.lab root@core1.lab")).toEqual([
    { tool: "ssh", typed: "jump.lab", host: "jump.lab", user: "admin" }, { tool: "ssh", typed: "core1.lab", host: "core1.lab", user: "root" }]);
  expect(hosts("sshpass -p x ssh pi@raspberrypi")).toEqual([{ tool: "ssh", typed: "raspberrypi", host: "raspberrypi", user: "pi" }]);
  expect(hosts("cat setup.sh | ssh lab-01 'bash -s'").map((target) => target.host)).toEqual(["192.168.10.20"]);
});

test("scp, sftp, rsync, nc, telnet and socat destinations", () => {
  expect(hosts("scp ./app.py lab-01:/opt/demoapp/")).toEqual([{ tool: "scp", typed: "lab-01", host: "192.168.10.20", user: "root", port: 2222 }]);
  expect(hosts("sftp -P 2022 backup@nas1")).toEqual([{ tool: "sftp", typed: "nas1", host: "nas1", user: "backup", port: 2022 }]);
  expect(hosts("rsync -av -e 'ssh -p 2200' dist/ deploy@web1:/srv/")).toEqual([{ tool: "rsync", typed: "web1", host: "web1", user: "deploy", port: 2200 }]);
  expect(hosts("nc -zv 10.0.0.1 22")).toEqual([{ tool: "nc", typed: "10.0.0.1", host: "10.0.0.1", port: 22 }]);
  expect(hosts("telnet sw1 23")).toEqual([{ tool: "telnet", typed: "sw1", host: "sw1", port: 23 }]);
  expect(hosts("socat - TCP:10.0.0.9:830")).toEqual([{ tool: "socat", typed: "10.0.0.9", host: "10.0.0.9", port: 830 }]);
});

test("commands that don't reach another machine name none", () => {
  for (const command of ["nc -l 8080", "echo ssh is fun", "git push", "npm test", "cp a.txt b:c", "cat C:\\notes.txt", "grep -r 'ssh ' ."]) expect([command, hosts(command)]).toEqual([command, []]);
});

test("only a plain ssh or scp with no local side effects runs outside the sandbox", () => {
  const root = path.join(home, "project");
  expect(runsAlone("ssh lab-01 uptime", root)).toBe(true);
  expect(runsAlone("ssh -i ~/.ssh/lab root@10.0.0.5 'systemctl status demoapp'", root)).toBe(true);
  expect(runsAlone(`scp ${path.join(root, "app.py")} lab-01:/opt/demoapp/`, root)).toBe(true);
  for (const command of [
    "ssh lab-01 uptime; curl evil.example", "ssh lab-01 uptime > out.txt", "cat x | ssh lab-01", "ssh lab-01 $(cat cmd)",
    "ssh -D 1080 lab-01", "ssh -L 8080:localhost:80 lab-01", "ssh -fN lab-01", "ssh -o ProxyCommand='sh -c evil' lab-01",
    "ssh -o LocalCommand=evil -o PermitLocalCommand=yes lab-01", "ssh -F ./cfg lab-01", "ssh -A lab-01", "ssh -G lab-01",
    "sudo ssh lab-01", "FOO=1 ssh lab-01", "scp lab-01:/etc/shadow ~/.bashrc", "scp -S ./evil lab-01:/x .", "nc 10.0.0.1 22", "rsync -a x lab-01:/y",
  ]) expect([command, runsAlone(command, root)]).toEqual([command, false]);
});

test("the shell line split keeps quoted operators inside one command", () => {
  expect(splitShell("ssh lab-01 'a; b && c'")).toEqual({ segments: [{ words: ["ssh", "lab-01", "a; b && c"], text: "ssh lab-01 'a; b && c'" }], simple: true });
  expect(splitShell("ssh lab-01 \"$(id)\"").simple).toBe(false);
  expect(splitShell("a && b").segments.map((segment) => segment.words)).toEqual([["a"], ["b"]]);
});

/** remoteChanges with this test's ~/.ssh/config, without the address it keeps each machine by. */
const changesOn = (command: string) => remoteChanges(command, home).map(({ host, changes }) => ({ host, changes }));

test("changes on another machine are read from the ssh command text: tokens, services, packages, /etc and /opt, certificates", () => {
  const command = "ssh lab-01 'pveum user token add root@pam demoapp --privsep 0 && mkdir -p /opt/demoapp && cat > /etc/systemd/system/demoapp.service <<EOF\n[Service]\nEOF\nsystemctl enable --now demoapp && apt-get install -y python3-venv && pvecm updatecerts --force'";
  expect(changesOn(command)).toEqual([{ host: "192.168.10.20 (lab-01)", changes: [
    "made an API token (pveum user token add root@pam demoapp --privse…)",
    "installed a service (/etc/systemd/system/demoapp.service)",
    "turned a service on or off at boot (systemctl enable --now demoapp)",
    "installed or removed packages (apt-get install -y python3-venv)",
    "renewed the node certificates (pvecm updatecerts --force)",
    "wrote /opt/demoapp",
  ] }]);
  expect(changesOn("scp demoapp.service root@10.0.0.5:/etc/systemd/system/")).toEqual([{ host: "10.0.0.5", changes: ["copied files to /etc/systemd/system/"] }]);
  expect(changesOn("ssh lab-01 bash -s <<'EOF'\nuseradd -m svc\nssh-keygen -t ed25519 -f /root/.ssh/k\nEOF")).toEqual([{ host: "192.168.10.20 (lab-01)", changes: [
    "made an SSH key (ssh-keygen -t ed25519 -f /root/.ssh/k)", "added a user (useradd -m svc)"] }]);
  // Reading is not changing, and a local command is not a remote change.
  for (const quiet of ["systemctl enable demoapp", "apt-get install -y jq", "scp lab-01:/etc/hosts ."]) {
    expect([quiet, changesOn(quiet)]).toEqual([quiet, []]);
  }
  // A command that ran over ssh with no change Casper knows is still listed: it ran there, and Casper can't tell.
  expect(changesOn("ssh lab-01 'cat /etc/passwd; systemctl status demoapp; ls /opt'")).toEqual([{ host: "192.168.10.20 (lab-01)", changes: [] }]);
  expect(changesOn("ssh lab-01 'python3 /srv/setup.py'")).toEqual([{ host: "192.168.10.20 (lab-01)", changes: [] }]);
  // Wrapped in another shell, it is read all the same.
  expect(changesOn(`bash -c "ssh lab-01 'pvecm updatecerts --force'"`)).toEqual([{ host: "192.168.10.20 (lab-01)", changes: ["renewed the node certificates (pvecm updatecerts --force)"] }]);
});

test("ssh wrapped in another shell, a subshell, a loop or xargs is still found; a host in a variable still counts", () => {
  for (const command of [
    "bash -c 'ssh root@10.0.0.5 uptime'", "sh -c \"ssh 10.0.0.5 id\"", "(ssh 10.0.0.5 id)", "echo $(ssh 10.0.0.5 id)", "echo \"$(ssh 10.0.0.5 id)\"",
    "echo `ssh 10.0.0.5 id`", "if true; then ssh 10.0.0.5 id; fi", "{ ssh 10.0.0.5 id; }", "! ssh 10.0.0.5 id", "watch -n 5 ssh 10.0.0.5 uptime",
    "eval ssh 10.0.0.5 id", "SSHPASS=x sshpass -e ssh root@10.0.0.5 id", "ssh-copy-id root@10.0.0.5", "busybox nc 10.0.0.5 22",
  ]) expect([command, hosts(command).map((target) => target.host)]).toEqual([command, ["10.0.0.5"]]);
  // $HOST, ${HOST}, a loop variable, xargs' {}: Casper can't read the machine, so it counts as one it can't name.
  for (const [command, typed] of [["H=10.0.0.5; ssh root@$H uptime", "$H"], ["ssh ${HOST} id", "${HOST}"], ["for h in a b; do ssh $h uptime; done", "$h"],
    ["xargs -I{} ssh {} id < hosts", "{}"], ["nc $IP 22", "$IP"], ["scp app.py $DEST", "$DEST"]] as const) {
    const found = remoteTargets(command, home);
    expect([command, found.map((target) => ({ typed: target.typed, unclear: target.unclear }))]).toEqual([command, [{ typed, unclear: true }]]);
    expect(targetLabel(found[0]!)).toBe(`another machine (${typed})`);
    expect(runsAlone(command, path.join(home, "project"))).toBe(false);
  }
});

test("an alias and its address are one machine on the receipt, named by both", () => {
  expect(remoteChanges("ssh lab-01 'systemctl enable --now demoapp' && ssh root@192.168.10.20 reboot", home)).toEqual([{
    host: "192.168.10.20 (lab-01)", address: "192.168.10.20",
    changes: ["turned a service on or off at boot (systemctl enable --now demoapp)", "restarted or shut down the machine (reboot)"] }]);
  expect(remoteChanges("ssh root@$H uptime", home)).toEqual([{ host: "$H", address: "$H", changes: [] }]);
});
