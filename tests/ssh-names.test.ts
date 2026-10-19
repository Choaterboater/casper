import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileToolGate, privatePathCommand } from "../src/platform/project-paths";
import { sshHostNames, sshHostsLine, sshNameLine } from "../src/sandbox/remote";
import { removeTempDir } from "./support/temp-dir";

/**
 * A NAS set up as `Host nas` in ~/.ssh/config: the AI, kept out of ~/.ssh, typed its address, so ssh used no key and the
 * wrong user, and the person was asked for a username and a password. The AI now reads the names the config gives (name,
 * user, address, port), never a key, a key's path or another setting. Documentation addresses (192.0.2.x) only.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

async function home(config?: string) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-ssh-names-")));
  roots.push(base);
  await mkdir(path.join(base, "project"));
  if (config !== undefined) { await mkdir(path.join(base, ".ssh")); await writeFile(path.join(base, ".ssh", "config"), config); }
  return base;
}

// ssh takes the first value it meets, so defaults (Host *) go last, as in a real config.
const CONFIG = [
  "Host nas storage", "  HostName 192.0.2.31", "  User admin", "  IdentityFile ~/.ssh/id_fixture_nas", "  ProxyCommand fixture-proxy %h",
  "Host lab-*", "  User lab",
  "Host router", "  HostName 192.0.2.1", "  Port 2222",
  "Host github.com", "  User git",
  "Match host 192.0.2.99", "  User matched",
  "Host *", "  ServerAliveInterval 30", "  User everyone",
  "",
].join("\n");

test("the names a config gives are read as ssh reads them; patterns, keys and other settings are left out", async () => {
  const where = await home(CONFIG);
  expect(sshHostNames(where)).toEqual([
    { name: "nas", hostName: "192.0.2.31", user: "admin" },
    { name: "storage", hostName: "192.0.2.31", user: "admin" },
    { name: "router", hostName: "192.0.2.1", user: "everyone", port: 2222 },
    { name: "github.com", hostName: "github.com", user: "git" },
  ]);
  const line = sshHostsLine(where)!;
  expect(line).toBe("Their ssh config names these machines: nas (admin@192.0.2.31), storage (admin@192.0.2.31), router (everyone@192.0.2.1 port 2222), "
    + "github.com (git@github.com). Use `ssh <name>` and `scp <file> <name>:<path>`: ssh then brings that machine's user and key.");
  for (const hidden of ["id_fixture_nas", "fixture-proxy", "ServerAlive", "lab-", "matched"]) expect(line).not.toContain(hidden);
  expect(sshHostsLine(await home())).toBeUndefined();
  expect(sshHostsLine(await home(""))).toBeUndefined();
});

test("a look into ~/.ssh is still refused, and the refusal names the machines; a write or another private place gets no names", async () => {
  const where = await home(CONFIG);
  const context = { root: path.join(where, "project"), home: where };
  for (const command of ["ls ~/.ssh", "cat ~/.ssh/config", "grep -i host ~/.ssh/config", "cd ~ && cat .ssh/config"]) {
    const refusal = privatePathCommand(command, context)!;
    expect([command, refusal]).toEqual([command, expect.stringMatching(/^Not run: this command reads ~\/\.ssh(?:\/config)?, which is private \(keys and logins\)\. Casper keeps it from the AI\. Their ssh config names these machines: nas \(admin@192\.0\.2\.31\)/)]);
    expect(refusal).toEndWith("ssh then brings that machine's user and key. Otherwise ask the user.");
    expect(refusal).not.toContain("id_fixture_nas");
  }
  expect(fileToolGate("read", { path: "~/.ssh/config" }, context)).toContain("Their ssh config names these machines: nas");
  expect(fileToolGate("read", { path: "~/.ssh/id_fixture_nas" }, context)).toContain("names these machines");
  expect(fileToolGate("write", { path: "~/.ssh/config", content: "x" }, context)).not.toContain("names these machines");
  expect(privatePathCommand("cat ~/.aws/credentials", context)).toBe("Not run: this command reads ~/.aws, which is private (keys and logins). Casper keeps it from the AI. Ask the user instead.");
  // Without a config the refusal is as before.
  const bare = await home();
  expect(privatePathCommand("ls ~/.ssh", { root: path.join(bare, "project"), home: bare })).toBe("Not run: this command reads ~/.ssh, which is private (keys and logins). Casper keeps it from the AI. Ask the user instead.");
});

test("a machine typed by its address gets the name the config gives it; typed by that name, another user, or unknown, it gets none", async () => {
  const where = await home(CONFIG);
  const hint = "[ssh] Their ssh config names this machine nas (admin@192.0.2.31): run `ssh nas …` or `scp … nas:…`, which brings its own user and key.";
  expect(sshNameLine([{ typed: "192.0.2.31", host: "192.0.2.31" }], where)).toBe(hint);
  expect(sshNameLine([{ typed: "admin@192.0.2.31", host: "192.0.2.31", user: "admin" }], where)).toBe(hint);
  expect(sshNameLine([{ typed: "nas", host: "192.0.2.31", user: "admin" }], where)).toBeUndefined();
  expect(sshNameLine([{ typed: "root@192.0.2.31", host: "192.0.2.31", user: "root" }], where)).toBeUndefined();
  expect(sshNameLine([{ typed: "192.0.2.77", host: "192.0.2.77" }], where)).toBeUndefined();
  // A refused login names it whatever user was typed: a wrong user (your own login name) is often why.
  expect(sshNameLine([{ typed: "root@192.0.2.31", host: "192.0.2.31", user: "root" }], where, true)).toBe(hint);
  expect(sshNameLine([{ typed: "nas", host: "192.0.2.31", user: "admin" }], where, true)).toBeUndefined();
});
