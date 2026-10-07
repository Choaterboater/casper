import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CasperApp } from "../src/app";
import { openProjectFolder } from "../src/app/workspace";
import { findProjectCandidates } from "../src/project/inspect";
import { isNoiseFolder } from "../src/project/noise";
import { orderProjectChoices, recentlyUsedProjects } from "../src/project/recent";
import { removeTempDir } from "./support/temp-dir";

const DAY = 24 * 60 * 60 * 1000;

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

/** A home with two real projects and the junk the lists used to show, all with saved conversations. */
async function homeWithJunk() {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-noise-")));
  const agentDir = path.join(home, ".casper", "agent");
  const tmp = path.join(home, "faketmp");
  const now = Date.now();
  const real = await project(path.join(home, "Documents", "bravo-real"), now - 5 * DAY);
  const second = await project(path.join(home, "Projects", "alpha-real"), now - 9 * DAY);
  // The rules of the platform running the test (the fixtures are real folders): macOS and Linux treat the cache
  // folders as junk, Windows treats AppData as junk.
  const cacheJunk = process.platform === "win32"
    ? [path.join(home, "AppData", "Local", "tool", "checkout")]
    : [path.join(home, ".cache", "tool", "checkout"), path.join(home, "Library", "Caches", "tool", "checkout")];
  const junk = [
    await project(path.join(home, "casper-bench-runs-v3", "a-casper-1", "app"), now - DAY),
    await project(path.join(tmp, "claude", "scratchpad", "smoke"), now - DAY),
    await project(path.join(tmp, "somerun"), now - DAY),
    ...(await Promise.all(cacheJunk.map(dir => project(dir, now - DAY)))),
    await project(path.join(home, "Documents", "app", "node_modules", "dep"), now - DAY),
    await project(path.join(home, "Documents", "scratchpad", "idea"), now - DAY),
  ];
  await savedConversation(agentDir, real, now - 2 * DAY);
  await savedConversation(agentDir, second, now - 3 * DAY);
  for (const dir of junk) await savedConversation(agentDir, dir, now - DAY / 2);
  return { home, agentDir, tmp, real, second, junk, noise: { platform: process.platform, tmpDirs: [tmp], homeDir: home } };
}

test("recent projects skip temp, cache, node_modules, benchmark and scratch folders; real ones keep their order", async () => {
  const { home, agentDir, real, second, noise } = await homeWithJunk();
  try {
    expect(await recentlyUsedProjects({ base: home, agentDir, noise })).toEqual([real, second]);
    expect(await orderProjectChoices([second, real], { base: home, agentDir, noise })).toEqual([real, second]);
  } finally { await removeTempDir(home); }
});

test("the folder scan skips the same places", async () => {
  const { home, tmp, noise } = await homeWithJunk();
  try {
    const found = await findProjectCandidates(home, { homeDir: home, noise });
    expect(found.map(dir => path.relative(home, dir)).sort()).toEqual([path.join("Documents", "bravo-real"), path.join("Projects", "alpha-real")]);
    // Opening a scratch folder on purpose still lists the projects inside it.
    expect(await findProjectCandidates(path.join(tmp, "claude"), { homeDir: home, noise })).toHaveLength(1);
  } finally { await removeTempDir(home); }
});

test("a project in a normal place stays, on every platform's rules", () => {
  const linux = { platform: "linux" as const, tmpDirs: ["/tmp"], homeDir: "/home/alex" };
  expect(isNoiseFolder("/home/alex/Projects/benchmark-tool", linux)).toBe(false);
  expect(isNoiseFolder("/home/alex/Documents/cache-viewer", linux)).toBe(false);
  expect(isNoiseFolder("/tmp-projects/app", linux)).toBe(false);
  expect(isNoiseFolder("/tmp/run1", linux)).toBe(true);
  expect(isNoiseFolder("/home/alex/.cache/x", linux)).toBe(true);
  const win = { platform: "win32" as const, tmpDirs: ["C:\\Users\\alex\\AppData\\Local\\Temp"], homeDir: "C:\\Users\\alex" };
  expect(isNoiseFolder("C:\\Users\\alex\\casper-bench-runs-v3\\a-casper-1\\app", win)).toBe(true);
  expect(isNoiseFolder("C:\\Users\\alex\\AppData\\Local\\Temp\\claude\\scratchpad\\smoke", win)).toBe(true);
  expect(isNoiseFolder("c:\\users\\ALEX\\appdata\\roaming\\x", win)).toBe(true);
  expect(isNoiseFolder("C:\\Users\\alex\\Projects\\myapp", win)).toBe(false);
  expect(isNoiseFolder("D:\\Claude\\ComfyUI", win)).toBe(false);
});

/** Just enough of the app for the start-up hint. Asking is never expected from home: a regression that asks fails. */
function fakeApp(home: string, rich: boolean) {
  const out: string[] = [];
  const app = {
    sessionHomeDir: home,
    output: { write: (text: string) => { out.push(text); } },
    terminal: {
      rich,
      ask: async () => { throw new Error("the home folder must not ask which project"); },
    },
  } as unknown as CasperApp;
  return { app, out };
}

test("the home-folder hint never names a junk folder, rich or not, and asks nothing", async () => {
  const { home, real, noise } = await homeWithJunk();
  try {
    for (const rich of [true, false]) {
      const { app, out } = fakeApp(home, rich);
      expect(await openProjectFolder(app, home, { platform: process.platform, noise })).toBe(home);
      const text = out.join("");
      // The most recently used real project is named; Windows shows the real path, elsewhere ~/.
      const shown = process.platform === "win32" ? real : `~/${path.relative(home, real)}`.split("/").join(path.sep);
      expect(text).toContain(`[folder] Opened in your home folder. To work in ${path.basename(real)}: casper ${shown}\n`);
      expect(text).not.toMatch(/bench|scratch|cache|node_modules|faketmp|somerun|smoke/i);
      expect(text).toContain("[folder] To start a new project instead: casper new\n");
    }
  } finally { await removeTempDir(home); }
});

test("with no recent project the example shows the real path on Windows, ~/Projects elsewhere", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-noise-empty-")));
  try {
    for (const rich of [true, false]) {
      const win = fakeApp(home, rich);
      await openProjectFolder(win.app, home, { platform: "win32" });
      expect(win.out.join("")).toContain(`To work in a project: casper ${path.win32.join(home, "Projects", "myapp")}\n`);
      expect(win.out.join("")).not.toContain("~/Projects");

      const mac = fakeApp(home, rich);
      await openProjectFolder(mac.app, home, { platform: "darwin" });
      expect(mac.out.join("")).toContain("To work in a project: casper ~/Projects/myapp\n");
    }
  } finally { await removeTempDir(home); }
});
