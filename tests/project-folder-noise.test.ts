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
  const junk = [
    await project(path.join(home, "casper-bench-runs-v3", "a-casper-1", "app"), now - DAY),
    await project(path.join(tmp, "claude", "scratchpad", "smoke"), now - DAY),
    await project(path.join(tmp, "somerun"), now - DAY),
    await project(path.join(home, ".cache", "tool", "checkout"), now - DAY),
    await project(path.join(home, "Library", "Caches", "tool", "checkout"), now - DAY),
    await project(path.join(home, "Documents", "app", "node_modules", "dep"), now - DAY),
    await project(path.join(home, "Documents", "scratchpad", "idea"), now - DAY),
  ];
  await savedConversation(agentDir, real, now - 2 * DAY);
  await savedConversation(agentDir, second, now - 3 * DAY);
  for (const dir of junk) await savedConversation(agentDir, dir, now - DAY / 2);
  return { home, agentDir, tmp, real, second, junk, noise: { platform: "linux" as const, tmpDirs: [tmp], homeDir: home } };
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

/** Just enough of the app for the start-up question. */
function fakeApp(home: string, rich: boolean) {
  const out: string[] = [];
  const asked: { question: string; labels: string[]; descriptions: string[] }[] = [];
  const app = {
    sessionHomeDir: home,
    output: { write: (text: string) => { out.push(text); } },
    terminal: {
      rich,
      ask: async (question: string, choices: { label: string; description?: string }[]) => {
        asked.push({ question, labels: choices.map(c => c.label), descriptions: choices.map(c => c.description ?? "") });
        return [choices.find(c => c.label === "New project")!.label];
      },
    },
  } as unknown as CasperApp;
  return { app, out, asked };
}

test("the question never lists the junk folders", async () => {
  const { home, real, second, noise } = await homeWithJunk();
  try {
    const { app, asked } = fakeApp(home, true);
    await openProjectFolder(app, home, { platform: "linux", noise });
    const label = (dir: string) => `~/${path.relative(home, dir)}`.split("/").join(path.sep);
    expect(asked[0]!.labels.slice(0, 2)).toEqual([label(real), label(second)]);
    expect(asked[0]!.labels.some(name => /bench|scratch|cache|node_modules|faketmp/i.test(name))).toBe(false);
  } finally { await removeTempDir(home); }
});

test("on Windows the question and the new-project line show the real path, elsewhere ~/Projects", async () => {
  const { home, noise } = await homeWithJunk();
  try {
    const win = fakeApp(home, true);
    await openProjectFolder(win.app, home, { platform: "win32", noise: { ...noise, platform: "linux" } });
    expect(win.asked[0]!.descriptions).toContain(`start one in ${path.win32.join(home, "Projects")}`);
    expect(win.asked[0]!.labels.filter(name => name.startsWith("~"))).toEqual([]);
    expect(win.out.join("")).toContain(`[new] Starting a new project in ${path.join(home, "Projects")}.`);
    expect(win.out.join("")).not.toContain("~/Projects");

    const mac = fakeApp(home, true);
    await openProjectFolder(mac.app, home, { platform: "darwin", noise });
    expect(mac.asked[0]!.descriptions).toContain("start one in ~/Projects");
    expect(mac.out.join("")).toContain("[new] Starting a new project in ~/Projects.");
  } finally { await removeTempDir(home); }
});
