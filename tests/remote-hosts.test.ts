import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { remoteTargets, runsAlone, splitShell, targetLabel, trustedProgram } from "../src/sandbox/remote";
import { remoteChanges } from "../src/task/remote-changes";
import { removeTempDir } from "./support/temp-dir";

/**
 * Where the AI's shell commands go: ssh, scp, sftp, rsync, nc, telnet and socat, with ~/.ssh/config aliases resolved
 * by Casper itself. What a command sent over ssh changed on the other machine, from its text only.
 */

let home: string;
beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "casper-remote-"));
  await mkdir(path.join(home, ".ssh"));
  await writeFile(path.join(home, ".ssh/config"), "Host build-server\n  HostName 198.51.100.20\n  User root\n  Port 2222\n\nHost *.lab\n  User admin\n");
});
afterAll(() => removeTempDir(home));

const hosts = (command: string) => remoteTargets(command, home).map(({ tool, typed, host, user, port }) => ({ tool, typed, host, ...(user ? { user } : {}), ...(port ? { port } : {}) }));

test("an ssh alias from ~/.ssh/config is resolved by Casper: the real address, user and port", () => {
  expect(hosts("ssh build-server uptime")).toEqual([{ tool: "ssh", typed: "build-server", host: "198.51.100.20", user: "root", port: 2222 }]);
  expect(hosts("ssh -p 22 admin@10.0.0.5 'ls /'")).toEqual([{ tool: "ssh", typed: "10.0.0.5", host: "10.0.0.5", user: "admin", port: 22 }]);
  expect(hosts("ssh -oPort=2200 -l ops sw1 show version")).toEqual([{ tool: "ssh", typed: "sw1", host: "sw1", user: "ops", port: 2200 }]);
  expect(hosts("ssh ssh://root@pve.local:8022")).toEqual([{ tool: "ssh", typed: "pve.local", host: "pve.local", user: "root", port: 8022 }]);
});

test("jump hosts, sudo, sshpass and a pipe still name the machines they reach", () => {
  expect(hosts("sudo ssh -J jump.lab root@core1.lab")).toEqual([
    { tool: "ssh", typed: "jump.lab", host: "jump.lab", user: "admin" }, { tool: "ssh", typed: "core1.lab", host: "core1.lab", user: "root" }]);
  expect(hosts("sshpass -p x ssh pi@raspberrypi")).toEqual([{ tool: "ssh", typed: "raspberrypi", host: "raspberrypi", user: "pi" }]);
  expect(hosts("cat setup.sh | ssh build-server 'bash -s'").map((target) => target.host)).toEqual(["198.51.100.20"]);
});

test("scp, sftp, rsync, nc, telnet and socat destinations", () => {
  expect(hosts("scp ./app.py build-server:/opt/sampleapp/")).toEqual([{ tool: "scp", typed: "build-server", host: "198.51.100.20", user: "root", port: 2222 }]);
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
  expect(runsAlone("ssh build-server uptime", root)).toBe(true);
  expect(runsAlone("ssh -i ~/.ssh/lab root@10.0.0.5 'systemctl status sampleapp'", root)).toBe(true);
  expect(runsAlone(`scp ${path.join(root, "app.py")} build-server:/opt/sampleapp/`, root)).toBe(true);
  for (const command of [
    "ssh build-server uptime; curl evil.example", "ssh build-server uptime > out.txt", "cat x | ssh build-server", "ssh build-server $(cat cmd)",
    "ssh -D 1080 build-server", "ssh -L 8080:localhost:80 build-server", "ssh -fN build-server", "ssh -o ProxyCommand='sh -c evil' build-server",
    "ssh -o LocalCommand=evil -o PermitLocalCommand=yes build-server", "ssh -F ./cfg build-server", "ssh -A build-server", "ssh -G build-server",
    "sudo ssh build-server", "FOO=1 ssh build-server", "scp build-server:/etc/shadow ~/.bashrc", "scp -S ./evil build-server:/x .", "nc 10.0.0.1 22", "rsync -a x build-server:/y",
  ]) expect([command, runsAlone(command, root)]).toEqual([command, false]);
});

test("only ssh and scp named bare run alone; a program of that name given by its path stays in the sandbox", () => {
  const root = path.join(home, "project");
  for (const command of [
    "./ssh build-server uptime", "/tmp/x/ssh build-server uptime", "bin/ssh build-server uptime", "'./ssh' build-server uptime",
    "node_modules/.bin/scp build-server:/etc/motd ./motd", "~/bin/scp ./app.py build-server:/opt/", "../ssh build-server uptime",
  ]) {
    // Still a command that reaches the machine, so it still asks first.
    expect([command, hosts(command).map((target) => target.typed)]).toEqual([command, ["build-server"]]);
    expect([command, runsAlone(command, root)]).toEqual([command, false]);
  }
});

test("a bare ssh or scp runs alone only from a PATH folder the sandbox doesn't let commands write", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-remote-path-"));
  try {
    const system = path.join(base, "system"), writable = path.join(base, "writable"), empty = path.join(base, "empty");
    for (const dir of [system, writable, empty]) await mkdir(dir);
    for (const dir of [system, writable]) for (const name of ["ssh", "scp"]) await writeFile(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
    const sandboxWrites = (place: string) => path.resolve(place).startsWith(writable);
    const on = (...dirs: string[]) => dirs.join(path.delimiter);
    expect(trustedProgram("ssh", on(empty, system), sandboxWrites)).toBe(path.join(system, "ssh"));
    expect(trustedProgram("scp", on(system, writable), sandboxWrites)).toBe(path.join(system, "scp"));
    // A folder the sandbox lets commands write, searched first (or not there yet), could take its place.
    expect(trustedProgram("ssh", on(writable, system), sandboxWrites)).toBeUndefined();
    expect(trustedProgram("ssh", on(path.join(writable, "not-yet"), system), sandboxWrites)).toBeUndefined();
    // An empty or relative entry is searched from the current folder.
    for (const searchPath of [on("", system), on(".", system), on("bin", system)]) expect([searchPath, trustedProgram("ssh", searchPath, sandboxWrites)]).toEqual([searchPath, undefined]);
    expect(trustedProgram("ssh", on(empty), sandboxWrites)).toBeUndefined();
    // A name with a folder in it is never looked up on the PATH.
    expect(trustedProgram("./ssh", on(system), sandboxWrites)).toBeUndefined();
  } finally { await removeTempDir(base); }
});

test("the shell line split keeps quoted operators inside one command", () => {
  expect(splitShell("ssh build-server 'a; b && c'")).toEqual({ segments: [{ words: ["ssh", "build-server", "a; b && c"], text: "ssh build-server 'a; b && c'" }], simple: true });
  expect(splitShell("ssh build-server \"$(id)\"").simple).toBe(false);
  expect(splitShell("a && b").segments.map((segment) => segment.words)).toEqual([["a"], ["b"]]);
});

/** remoteChanges with this test's ~/.ssh/config, without the address it keeps each machine by. */
const changesOn = (command: string) => remoteChanges(command, home).map(({ host, changes }) => ({ host, changes }));

test("changes on another machine are read from the ssh command text: tokens, services, packages, /etc and /opt, certificates", () => {
  const command = "ssh build-server 'pveum user token add root@pam sampleapp --privsep 0 && mkdir -p /opt/sampleapp && cat > /etc/systemd/system/sampleapp.service <<EOF\n[Service]\nEOF\nsystemctl enable --now sampleapp && apt-get install -y python3-venv && pvecm updatecerts --force'";
  expect(changesOn(command)).toEqual([{ host: "198.51.100.20 (build-server)", changes: [
    "made an API token (pveum user token add root@pam sampleapp --privs…)",
    "installed a service (/etc/systemd/system/sampleapp.service)",
    "turned a service on or off at boot (systemctl enable --now sampleapp)",
    "installed or removed packages (apt-get install -y python3-venv)",
    "renewed the node certificates (pvecm updatecerts --force)",
    "wrote /opt/sampleapp",
  ] }]);
  expect(changesOn("scp sampleapp.service root@10.0.0.5:/etc/systemd/system/")).toEqual([{ host: "10.0.0.5", changes: ["copied files to /etc/systemd/system/"] }]);
  expect(changesOn("ssh build-server bash -s <<'EOF'\nuseradd -m svc\nssh-keygen -t ed25519 -f /root/.ssh/k\nEOF")).toEqual([{ host: "198.51.100.20 (build-server)", changes: [
    "made an SSH key (ssh-keygen -t ed25519 -f /root/.ssh/k)", "added a user (useradd -m svc)"] }]);
  // Reading is not changing, and a local command is not a remote change.
  for (const quiet of ["systemctl enable sampleapp", "apt-get install -y jq", "scp build-server:/etc/hosts ."]) {
    expect([quiet, changesOn(quiet)]).toEqual([quiet, []]);
  }
  // A command that ran over ssh with no change Casper knows is still listed: it ran there, and Casper can't tell.
  expect(changesOn("ssh build-server 'cat /etc/passwd; systemctl status sampleapp; ls /opt'")).toEqual([{ host: "198.51.100.20 (build-server)", changes: [] }]);
  expect(changesOn("ssh build-server 'python3 /srv/setup.py'")).toEqual([{ host: "198.51.100.20 (build-server)", changes: [] }]);
  // Wrapped in another shell, it is read all the same.
  expect(changesOn(`bash -c "ssh build-server 'pvecm updatecerts --force'"`)).toEqual([{ host: "198.51.100.20 (build-server)", changes: ["renewed the node certificates (pvecm updatecerts --force)"] }]);
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
  expect(remoteChanges("ssh build-server 'systemctl enable --now sampleapp' && ssh root@198.51.100.20 reboot", home)).toEqual([{
    host: "198.51.100.20 (build-server)", address: "198.51.100.20",
    changes: ["turned a service on or off at boot (systemctl enable --now sampleapp)", "restarted or shut down the machine (reboot)"] }]);
  expect(remoteChanges("ssh root@$H uptime", home)).toEqual([{ host: "$H", address: "$H", changes: [] }]);
});

test("ssh -o Hostname= names the machine ssh really reaches, not the alias's address", () => {
  expect(hosts("ssh -o Hostname=203.0.113.9 build-server uptime")).toEqual([{ tool: "ssh", typed: "203.0.113.9", host: "203.0.113.9", user: "root", port: 2222 }]);
  expect(hosts("ssh -oHostName=evil.example.com build-server id").map((target) => target.host)).toEqual(["evil.example.com"]);
  expect(hosts("ssh -o 'HostName 203.0.113.9' build-server id").map((target) => target.host)).toEqual(["203.0.113.9"]);
  expect(hosts("scp -o Hostname=203.0.113.9 build-server:/etc/shadow ./x").map((target) => target.host)).toEqual(["203.0.113.9"]);
  expect(hosts("sftp -o HostName=203.0.113.9 build-server").map((target) => target.host)).toEqual(["203.0.113.9"]);
  expect(hosts("rsync -e 'ssh -o HostName=203.0.113.9' dist/ build-server:/srv/").map((target) => target.host)).toEqual(["203.0.113.9"]);
  expect(remoteTargets("ssh -o HostName=$H build-server id", home)[0]?.unclear).toBe(true);
});

test("an approved ssh that writes a known-hosts file of its choosing stays in the sandbox; /dev/null runs alone", () => {
  const root = path.join(home, "project");
  for (const command of [
    `ssh -o UserKnownHostsFile=${path.join(home, ".gitconfig")} -o StrictHostKeyChecking=no build-server true`,
    "ssh -oUserKnownHostsFile=x build-server true", "scp -o UserKnownHostsFile=x build-server:/etc/hosts ./hosts",
    "ssh -o 'UserKnownHostsFile /dev/null x' build-server true",
  ]) expect([command, runsAlone(command, root)]).toEqual([command, false]);
  // /dev/null and none write nothing, and ssh only ever reads GlobalKnownHostsFile: a routine lab ssh keeps your keys.
  for (const command of [
    "ssh -o StrictHostKeyChecking=accept-new build-server uptime",
    "ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no build-server true",
    "ssh -o 'UserKnownHostsFile none' build-server true", "ssh -o UserKnownHostsFile=NUL build-server true",
    "ssh -o GlobalKnownHostsFile=/dev/null build-server true", "ssh -o GlobalKnownHostsFile=/tmp/x build-server true",
  ]) expect([command, runsAlone(command, root)]).toEqual([command, true]);
});

test("inside double quotes a backslash stays unless it escapes a special character, as bash reads it", () => {
  const words = (command: string) => splitShell(command).segments[0]!.words;
  expect(words('cat "..\\..\\.ssh\\config"')).toEqual(["cat", "..\\..\\.ssh\\config"]);
  expect(words('cat "C:\\Windows\\win.ini"')).toEqual(["cat", "C:\\Windows\\win.ini"]);
  expect(words('echo "a\\"b" "c\\\\d" "e\\$f"')).toEqual(["echo", 'a"b', "c\\d", "e$f"]);
  expect(words("cat ..\\x 'a\\b'")).toEqual(["cat", "..x", "a\\b"]);
});
