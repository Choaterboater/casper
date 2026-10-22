import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mcpChangeRow, shellChanges } from "../src/app/changes";

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
