import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { orderProjectChoices, recentlyUsedProjects } from "../src/project/recent";
import { cleanEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";

const DAY = 24 * 60 * 60 * 1000;

/** A saved conversation the way the engine stores it: one folder per working folder, a header line naming it. */
async function savedConversation(agentDir: string, cwd: string, when: number): Promise<void> {
  const folder = path.join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  await mkdir(folder, { recursive: true });
  const stamp = new Date(when).toISOString();
  const file = path.join(folder, `${stamp.replace(/[:.]/g, "-")}_fixture.jsonl`);
  await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: "fixture", timestamp: stamp, cwd })}\n`);
  await utimes(file, new Date(when), new Date(when));
}

async function project(dir: string, changed: number): Promise<string> {
  await mkdir(path.join(dir, ".git"), { recursive: true });
  await utimes(path.join(dir, ".git"), new Date(changed), new Date(changed));
  await utimes(dir, new Date(changed), new Date(changed));
  return dir;
}

/** Three projects whose alphabetical order is the reverse of the right one. */
async function threeProjects(home: string) {
  const now = Date.now();
  const documents = path.join(home, "Documents");
  const old = await project(path.join(documents, "alpha-old"), now - 300 * DAY);
  const changed = await project(path.join(documents, "bravo-changed"), now - DAY);
  // Used yesterday-ish but untouched on disk for a long time: use beats a changed folder.
  const used = await project(path.join(documents, "charlie-used"), now - 400 * DAY);
  await savedConversation(path.join(home, ".casper", "agent"), used, now - 2 * DAY);
  return { old, changed, used };
}

test("recently used projects come first, then the most recently changed, and alphabetical order no longer wins", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-recent-order-")));
  try {
    const { old, changed, used } = await threeProjects(home);
    const ordered = await orderProjectChoices([old, changed, used], { base: home, agentDir: path.join(home, ".casper", "agent") });
    expect(ordered).toEqual([used, changed, old]);
  } finally { await removeTempDir(home); }
});

test("a recorded project that no longer exists, sits outside the opened folder, or is the folder itself is skipped", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-recent-skip-")));
  const home = path.join(root, "home");
  const agentDir = path.join(home, ".casper", "agent");
  try {
    const now = Date.now();
    const kept = await project(path.join(home, "Projects", "delta-kept"), now - 50 * DAY);
    const outside = await project(path.join(root, "elsewhere", "echo-outside"), now - 50 * DAY);
    await savedConversation(agentDir, kept, now - 3 * DAY);
    await savedConversation(agentDir, path.join(home, "Projects", "foxtrot-gone"), now - DAY);
    await savedConversation(agentDir, outside, now - DAY);
    await savedConversation(agentDir, home, now);
    // A sibling that only shares the prefix is outside too.
    const sibling = await project(path.join(root, "home-other"), now - 50 * DAY);
    await savedConversation(agentDir, sibling, now);
    expect(await recentlyUsedProjects({ base: home, agentDir })).toEqual([kept]);
    expect(await orderProjectChoices([], { base: home, agentDir })).toEqual([kept]);
  } finally { await removeTempDir(root); }
});

test("no saved conversations: the scan's projects in order of last change", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-recent-none-")));
  try {
    const now = Date.now();
    const a = await project(path.join(home, "Documents", "golf-a"), now - 9 * DAY);
    const b = await project(path.join(home, "Documents", "hotel-b"), now - 2 * DAY);
    expect(await orderProjectChoices([a, b], { base: home, agentDir: path.join(home, ".casper", "agent") })).toEqual([b, a]);
  } finally { await removeTempDir(home); }
});

test("without a rich terminal the home-folder hint names the most recently used project", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-recent-plain-")));
  try {
    await threeProjects(home);
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/cli.ts")], {
      cwd: home, env: cleanEnv({ HOME: home, CASPER_PROFILE: "default" }), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    // Windows shows the real path; elsewhere the home folder is ~.
    const shown = process.platform === "win32" ? path.join(home, "Documents", "charlie-used") : "~/Documents/charlie-used";
    expect(stdout).toContain(`[folder] Opened in your home folder. To work in charlie-used: casper ${shown}`);
  } finally { await removeTempDir(home); }
});
