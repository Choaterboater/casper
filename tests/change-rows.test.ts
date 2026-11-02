import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mcpChangeRow, shellChanges } from "../src/app/changes";
import { remoteChanges } from "../src/task/remote-changes";

// A home with no ssh config: machines keep the names the commands give them.
const home = await mkdtemp(path.join(os.tmpdir(), "casper-change-rows-"));
const rows = (command: string, output = "", ok = true) => shellChanges(command, output, ok, home).map(change => change.row);

test("another machine: a change its words show is a row, with the commands sent; a look is none", () => {
  const [service] = shellChanges("ssh build-server 'sudo cp app.service /etc/systemd/system/app.service && sudo systemctl enable --now app'", "", true, home);
  expect(service!.row).toStartWith("Changed on build-server: installed a service");
  expect(service!.row).toContain("turned a service on or off at boot");
  expect(service!.sent).toEqual(["sudo cp app.service /etc/systemd/system/app.service", "sudo systemctl enable --now app"]);
  expect(rows("ssh build-server 'ls /var/log; uptime'")).toEqual([]);
  expect(rows("scp app.conf nas:/etc/app/app.conf")).toEqual(["Changed on nas: copied files to /etc/app/app.conf"]);
  // A failed command may still have changed the machine: the row shows, as on the receipt.
  expect(rows("ssh build-server 'sudo apt install nginx'", "E: lock held", false)).toEqual(["Changed on build-server: installed or removed packages (apt install nginx)"]);
});

test("a device: lines it takes as a change (config mode, commit, delete) are a row with every line sent; reads are none", () => {
  const [change] = shellChanges("ssh admin@sw1 'configure; set system host-name lab1; commit'", "", true, home);
  expect(change).toEqual({ row: "Changed on sw1: sent 3 config lines", sent: ["configure", "set system host-name lab1", "commit"] });
  expect(rows("ssh admin@sw1 'show version | match Junos'")).toEqual([]);
  expect(rows("ssh admin@sw1 'show interfaces terse; show route'")).toEqual([]);
});

test("plain server reads over ssh (with harmless redirects and pipes) are not config lines; a device change still is", () => {
  expect(rows("ssh admin@192.0.2.31 'hostname; uname -a; uptime; df -h' 2>&1")).toEqual([]);
  expect(rows("ssh admin@192.0.2.31 'df -h /volume1 2>/dev/null'")).toEqual([]);
  expect(rows("ssh nas 'docker ps -a | grep tunnel; docker logs --tail 50 app 2>&1 | tail -n 20; ip addr; systemctl status app >/dev/null'")).toEqual([]);
  expect(rows("ssh nas 'free -m; whoami; id; ls -la /opt; cat /etc/os-release | head -3; ps aux | sort | wc -l; journalctl -u app -n 20; date; pwd; lsblk; ss -tlnp; du -sh /opt'")).toEqual([]);
  // Reads that write or set something stay a change.
  expect(rows("ssh admin@sw1 'uptime; configure; set system host-name lab1; commit'")).toEqual(["Changed on sw1: sent 3 config lines"]);
  expect(rows("ssh nas 'df -h > /tmp/disk.txt'")).toEqual(["Changed on nas: ran 1 command that may change things"]);
});

test("what was sent keeps secrets hidden", () => {
  const [change] = shellChanges("ssh build-server 'echo password=hunter2 > /etc/app.conf'", "", true, home);
  expect(change!.sent!.join("\n")).not.toContain("hunter2");
  expect(change!.sent!.join("\n")).toContain("password=<redacted>");
});

test("this computer's setup: installs, removals, a commit, a push, a branch switch and deletions get named rows", () => {
  expect(rows("npm install left-pad")).toEqual(["installed left-pad"]);
  expect(rows("bun add zod react && bun remove lodash")).toEqual(["installed zod, react", "removed lodash"]);
  expect(rows("python3 -m pip install requests")).toEqual(["installed requests"]);
  expect(rows("pip install -r requirements.txt")).toEqual([]);
  expect(rows("npm install")).toEqual([]);
  expect(rows("git commit -m 'fix port'", "[fix-port a1b2c3d] fix port\n 1 file changed, 2 insertions(+)")).toEqual(['committed "fix port" (a1b2c3d)']);
  expect(rows("git push origin main", "To example.com:team/app.git\n   1111111..2222222  main -> main")).toEqual(["pushed main to origin"]);
  expect(rows("git push", "To example.com:team/app.git\n * [new branch]      fix-port -> fix-port")).toEqual(["pushed fix-port"]);
  expect(rows("git push origin main", "Everything up-to-date")).toEqual([]);
  expect(rows("git switch -c fix-port", "Switched to a new branch 'fix-port'")).toEqual(["switched to fix-port"]);
  expect(rows("git checkout src/a.ts", "Updated 1 path from the index")).toEqual([]);
  expect(rows("rm a.txt b.txt c.txt")).toEqual(["deleted 3 files: a.txt, b.txt, c.txt"]);
  expect(rows("rm -rf dist")).toEqual(["deleted dist"]);
  // Only when the command worked.
  expect(rows("npm install left-pad", "npm ERR! 404", false)).toEqual([]);
  expect(rows("git commit -m 'x'", "nothing to commit, working tree clean", false)).toEqual([]);
});

test("an MCP change row names the server, the real tool and what it acts on, when its arguments say", () => {
  expect(mcpChangeRow("mist", "update_site_setting", { site_id: "site-1", psk: "••••••••" })).toBe("Changed in mist: update_site_setting site-1");
  expect(mcpChangeRow("network", "set_port", { arguments: { device: "sw1", port: "ge-0/0/1" } })).toBe("Changed in network: set_port sw1");
  expect(mcpChangeRow("network", "set_ssid", { enabled: true })).toBe("Changed in network: set_ssid");
});

test("the same change said once: a command that removes its scratch folder at the start and again at the end", () => {
  // "◆ deleted /tmp/csmoke-proof" was printed twice for one step.
  const rows = shellChanges("rm -rf /tmp/csmoke-proof; mkdir /tmp/csmoke-proof; cp -r scripts /tmp/csmoke-proof; node --test; rm -rf /tmp/csmoke-proof", "", true)
    .map((change) => change.row);
  expect(rows).toEqual(["deleted /tmp/csmoke-proof"]);
});

// The owner's NAS session: plain looks over ssh showed "◆ Changed on 192.0.2.31 (nas): sent 3 config lines" with eight
// lines under it, and his Windows PC the same. A server's commands go through the read check Casper uses here.
const LOOKS = [
  "ssh -o BatchMode=yes -o ConnectTimeout=8 nas 'uname -m; (docker --version; sudo -n docker --version) 2>&1; docker compose version 2>&1; id; ls -d /volume*/ 2>&1; ls /volume1 2>&1 | head -30; ls /volume1/docker 2>&1 | head'",
  "ssh nas 'uname -m; docker --version 2>&1; docker compose version 2>&1; docker ps --format \"{{.Names}} {{.Ports}}\" 2>&1 | head -30; ss -ltn 2>/dev/null | grep -E \":800[01] \"; df -h /volume1 | tail -1 2>&1'",
  "ssh nas 'ls -la /volume1/docker | head -50; echo ---; ls /volume1/docker/app 2>&1; echo ---; cat /volume1/docker/app/docker-compose.y*ml /volume1/docker/app/compose.y*ml 2>/dev/null | head -40; echo --- PORTS; (ss -ltnH 2>/dev/null; netstat -ltn 2>/dev/null) | awk \"{print \\$4}\" | grep -E \":(800[0-9])$\"; echo; docker ps -a --format \"{{.Names}} {{.Ports}}\" | grep -E \"800[0-9]->\"; echo done 2>&1'",
  "ssh nas 'which rsync; id -u; getent group admin 2>&1'",
  "ssh pc 'ver 2>nul; uname -a 2>&1'",
  "ssh nas 'cd /volume1/docker/app; ls -la; echo REMOTE; du -sk data; find data -type f | wc -l 2>&1'",
  "ssh nas 'echo DH=$DOCKER_HOST; docker context ls 2>&1; ls -la /var/run/docker.sock; systemctl is-active docker 2>&1; docker ps --format \"{{.Names}}\" 2>&1 | head -3 2>&1'",
  "ssh nas 'systemctl is-active docker docker.socket 2>&1; docker ps --format \"{{.Names}}\" 2>&1 | wc -l; ps -eo pid,etime,cmd | grep -E \"dockerd|containerd\" | grep -v grep | head; sudo -n true 2>&1 | head -1 2>&1'",
  "ssh nas 'date +%T; systemctl is-active docker docker.socket 2>&1 | tr \"\\n\" \" \"; echo; docker ps --format \"{{.Names}} {{.Status}}\" 2>&1 | head -40'",
  "perl -e 'alarm 25; exec @ARGV' ssh nas 'systemctl is-active docker; docker ps -q | wc -l; uptime'",
];

test("a server's looks over ssh are no change, whatever their redirects, subshells, globs and variables; the receipt says looked only", () => {
  for (const command of LOOKS) expect([command, rows(command)]).toEqual([command, []]);
  for (const command of LOOKS) expect([command, remoteChanges(command, home).map(({ host, changes, looked }) => ({ host, changes, looked }))])
    .toEqual([command, [{ host: command.includes(" pc ") ? "pc" : "nas", changes: [], looked: true }]]);
});

test("a server's commands that change things are a row with an accurate count, and only those lines in its box", () => {
  expect(shellChanges("ssh nas 'mkdir -p /volume1/docker/app 2>&1'", "", true, home))
    .toEqual([{ row: "Changed on nas: ran 1 command that may change things", sent: ["mkdir -p /volume1/docker/app 2>&1"] }]);
  const build = "ssh nas 'sha256sum /volume1/docker/app/data/app.db | cut -c1-16; cd /volume1/docker/app; docker compose up -d --build 2>&1 | tail -15; sleep 4; docker ps --filter name=^app$ --format \"{{.Names}} {{.Status}}\"; docker logs app 2>&1 | tail -10'";
  expect(shellChanges(build, "", true, home)).toEqual([{ row: "Changed on nas: ran 1 command that may change things", sent: ["docker compose up -d --build 2>&1 | tail -15"] }]);
  expect(rows("tar -cf - data | ssh nas 'tar -xf - -C /volume1/docker/app 2>&1'")).toEqual(["Changed on nas: ran 1 command that may change things"]);
  expect(remoteChanges(build, home)[0]!.looked).toBe(false);
  // A device keeps its words, and its box holds the lines counted.
  expect(shellChanges("ssh admin@sw1 'show version; configure; set system host-name lab1; commit'", "", true, home))
    .toEqual([{ row: "Changed on sw1: sent 3 config lines", sent: ["configure", "set system host-name lab1", "commit"] }]);
});

test("wrappers are seen through: perl's alarm, timeout, gtimeout, env, nohup and sh -c name the ssh inside", () => {
  const inner = "ssh nas 'cd /volume1/docker/app && docker compose up -d --build 2>&1 | tail -15'";
  for (const command of [`perl -e 'alarm 25; exec @ARGV' ${inner}`, `perl -e 'alarm shift; exec @ARGV' 25 ${inner}`, `timeout 30 ${inner}`, `gtimeout -k 5 30 ${inner}`,
    `env LC_ALL=C ${inner}`, `nohup ${inner} > /tmp/build.log 2>&1`, `sh -c "${inner}"`,
    `perl -e 'alarm 25; exec "ssh", "nas", "cd /volume1/docker/app && docker compose up -d --build"'`]) {
    expect([command, rows(command)]).toEqual([command, ["Changed on nas: ran 1 command that may change things"]]);
  }
});

test("an MCP change behind a router names the real tool once and what it acts on from inside its arguments", () => {
  const sent = { name: "mist_create_org_rf_template", arguments: { org_id: "00000000-0000-0000-0000-000000000000", body: { name: "Standard-RF-80MHz", country_code: "US" } } };
  expect(mcpChangeRow("network", "mist_create_org_rf_template", sent)).toBe("Changed in network: mist_create_org_rf_template Standard-RF-80MHz");
  const site = { name: "mist_optimize_site_rrm", arguments: { site_id: "00000000-0000-0000-0000-000000000001", body: { bands: ["5"] } } };
  expect(mcpChangeRow("network", "mist_optimize_site_rrm", site)).toBe("Changed in network: mist_optimize_site_rrm 00000000-0000-0000-0000-000000000001");
  // Plain words when Casper has them, with the undo.
  expect(mcpChangeRow("network", "mist_update_site_info", sent, { product: "Mist", box: "x",
    after: "site Lab-Site now uses RF template Standard-RF-80MHz (was Standard-RF)", undo: "set it back to Standard-RF" }))
    .toBe("Changed in Mist: site Lab-Site now uses RF template Standard-RF-80MHz (was Standard-RF). To undo: set it back to Standard-RF");
});
