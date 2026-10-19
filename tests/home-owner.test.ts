import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { giveBack, homeFiles, returnClaudeFiles, rootInOthersHome, rootOwnedNote } from "../src/platform/home-owner";
import { removeTempDir } from "./support/temp-dir";

/**
 * `sudo casper` keeps your home, so what it and Claude Code write there belongs to root; Claude Code then took 6 s to
 * give up on a root-owned ~/.claude.json, the first /model took 19 s and the plan login looked missing. Tests can't
 * make root-owned files, so `rootUid` names the test's own account as the one whose files are given back.
 */

const posix = process.platform !== "win32";
const me = process.getuid?.() ?? -1;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

async function home() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-home-owner-")));
  roots.push(base);
  const files = [".claude.json", ".claude.json.backup", ".claude/settings.json", ".claude/backups/.claude.json.backup.1",
    ".claude/projects/p/s.jsonl", ".casper/agent/auth.json", ".casper/agent/sessions/one/s.jsonl", ".casper/projects/p/undo/x", "notes.txt"];
  for (const file of files) { await mkdir(path.dirname(path.join(base, file)), { recursive: true }); await writeFile(path.join(base, file), "x"); }
  return base;
}

const recorder = () => {
  const changed: string[] = [];
  return { changed, chown: async (file: string, uid: number, gid: number) => { changed.push(file); expect([uid, gid]).toEqual([4242, 4343]); } };
};

test.skipIf(!posix)("only a Casper running as root in a home that isn't root's gives files back, to that home's owner", async () => {
  const where = await home();
  const owner = await stat(where);
  expect(await rootInOthersHome(where, { uid: () => 0 })).toEqual({ uid: owner.uid, gid: owner.gid });
  expect(await rootInOthersHome(where, { uid: () => me === 0 ? 1 : me })).toBeUndefined();
  expect(await rootInOthersHome(path.join(where, "missing"), { uid: () => 0 })).toBeUndefined();
});

test.skipIf(!posix)("at start and exit everything in ~/.casper, ~/.claude and Claude Code's settings files goes back, nothing else", async () => {
  const where = await home();
  await symlink("/etc", path.join(where, ".casper", "link"));
  const { changed, chown } = recorder();
  const count = await giveBack(await homeFiles(where), { uid: 4242, gid: 4343 }, { chown, rootUid: me });
  const relative = changed.map((file) => path.relative(where, file)).sort();
  expect(relative).toContain(".claude.json");
  expect(relative).toContain(".claude.json.backup");
  expect(relative).toContain(path.join(".casper", "projects", "p", "undo", "x"));
  expect(relative).toContain(path.join(".claude", "projects", "p", "s.jsonl"));
  // The link itself, never what it points to.
  expect(relative).toContain(path.join(".casper", "link"));
  expect(relative.some((file) => file.startsWith(".."))).toBe(false);
  expect(relative).not.toContain("notes.txt");
  expect(count).toBe(changed.length);
  // Another account's files are never touched.
  const other = recorder();
  expect(await giveBack(await homeFiles(where), { uid: 4242, gid: 4343 }, { chown: other.chown, rootUid: me + 100_000 })).toBe(0);
});

test.skipIf(!posix)("after Claude Code runs, only its settings files and backups go back; running as yourself changes nothing", async () => {
  const where = await home();
  const { changed, chown } = recorder();
  const owner = await stat(where);
  await returnClaudeFiles(where, { uid: () => 0, rootUid: me, chown: async (file, uid, gid) => {
    expect([uid, gid]).toEqual([owner.uid, owner.gid]); await chown(file, 4242, 4343); } });
  expect(changed.map((file) => path.relative(where, file)).sort()).toEqual([".claude", ".claude.json", ".claude.json.backup",
    path.join(".claude", "backups"), path.join(".claude", "backups", ".claude.json.backup.1"), path.join(".claude", "projects"),
    path.join(".claude", "settings.json")].sort());
  const yourself = recorder();
  await returnClaudeFiles(where, { uid: () => (me === 0 ? 1 : me), rootUid: me, chown: yourself.chown });
  expect(yourself.changed).toEqual([]);
});

test.skipIf(!posix)("running as you, files root left say so once, with the one command that gives them back", async () => {
  const where = await home();
  const user = { name: "someone", gid: 20 };
  const note = await rootOwnedNote(where, { uid: () => 4242, rootUid: me, user });
  expect(note).toStartWith("Some of your Casper and Claude Code files belong to root, so they can't be read or updated (an earlier sudo casper or sudo claude left them): ");
  // A folder already named covers what is in it.
  expect(note).toContain("Give them back: sudo chown -R someone:20 ~/.claude.json ~/.claude.json.backup ~/.claude ~/.casper");
  expect(note).not.toContain("~/.claude/settings.json");
  expect(await rootOwnedNote(where, { uid: () => 0, rootUid: me, user })).toBeUndefined();
  expect(await rootOwnedNote(where, { uid: () => 4242, rootUid: me + 100_000, user })).toBeUndefined();
});

test.skipIf(!posix)("a name with spaces is quoted after ~/ so the shell still expands it", async () => {
  const where = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-home-owner-")));
  roots.push(where);
  await writeFile(path.join(where, ".claude.json.my copy"), "x");
  const note = await rootOwnedNote(where, { uid: () => 4242, rootUid: me, user: { name: "someone", gid: 20 } });
  expect(note).toEndWith("sudo chown -R someone:20 ~/'.claude.json.my copy'");
});
