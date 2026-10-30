import { expect, test } from "bun:test";
import { mkdir, realpath, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { namedProject, projectWords } from "../src/app/workspace";
import type { AgentRuntime, RuntimeEventListener, RuntimeSession } from "../src/runtime/types";
import { richApp } from "./support/app";
import { withEnv } from "./support/env";

test("a request names a project by its folder name, a link's last part, or exact case for a plain word", () => {
  // Resolved, as the folders are: on Windows "/home/me" is on the current drive.
  const tools = path.resolve("/home/me/Documents/casper-tools");
  const notes = path.resolve("/home/me/Documents/Notes");
  const app = path.resolve("/home/me/app");
  const folders = [tools, notes, app];
  expect(namedProject("improve find_tool in casper-tools", folders, "/home/me/Documents/mcp")).toBe(tools);
  expect(namedProject("review github.com/someone/Casper-Tools/pull/11", folders, "/home/me/Documents/mcp")).toBe(tools);
  // A plain word is an ordinary word too: it counts only where the request points at a folder.
  for (const request of ["move to Notes", "switch to notes", "open the Notes project", "look in the notes folder"]) {
    expect([request, namedProject(request, folders, "/home/me/Documents/mcp")]).toEqual([request, notes]);
  }
  for (const request of ["tidy Notes before Friday", "tidy my notes", "the notes are in review", "add notes-v2 support"]) {
    expect([request, namedProject(request, folders, "/home/me/Documents/mcp")]).toEqual([request, undefined]);
  }
  const review = path.resolve("/home/me/Projects/review");
  expect(namedProject("can you do the same review on the mist side as well", [review], "/home/me/Documents/mcp")).toBeUndefined();
  expect(namedProject("move to review", [review], "/home/me/Documents/mcp")).toBe(review);
  // A short name never counts; a longer name or file isn't the folder.
  expect(namedProject("fix the app", folders, "/home/me/Documents/mcp")).toBeUndefined();
  expect(namedProject("see casper-tools-old and casper-tools.md", folders, "/home/me/Documents/mcp")).toBeUndefined();
  // The open folder, or a folder inside the named one, is already there.
  expect(namedProject("improve casper-tools", folders, tools)).toBeUndefined();
  expect(namedProject("improve casper-tools", folders, path.join(tools, "src"))).toBeUndefined();
});

/** A saved conversation the way the engine stores it: one folder per working folder, a header line naming it. */
async function savedConversation(home: string, cwd: string, when = new Date()): Promise<void> {
  const folder = path.join(home, ".casper", "agent", "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, "2026-01-01T00-00-00-000Z_fixture.jsonl");
  await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: "fixture", timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`);
  await utimes(file, when, when);
  await utimes(folder, when, when);
}

function recordingRuntime(starts: string[], prompts: string[]): AgentRuntime {
  return {
    async start(options): Promise<RuntimeSession> {
      starts.push(options.cwd);
      const listeners = new Set<RuntimeEventListener>();
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: options.cwd, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async (text: string) => { prompts.push(text); },
      };
    },
    async dispose() {},
  };
}

async function namedFixture() {
  const starts: string[] = [];
  const prompts: string[] = [];
  const f = await richApp(() => recordingRuntime(starts, prompts));
  await f.until(screen => screen.includes("idle"));
  const tools = path.join(await realpath(f.home), "Documents", "casper-tools");
  await mkdir(path.join(tools, ".git"), { recursive: true });
  await savedConversation(f.home, tools);
  return { ...f, tools, starts, prompts };
}

test("a request naming another project asks 1 Stay here · 2 Move there; Move runs it there", () => withEnv({ TERM: "xterm-256color" }, async () => {
  const f = await namedFixture();
  try {
    f.input.write("improve find_tool in casper-tools\r");
    await f.until(screen => screen.includes("This request names casper-tools, in ~/Documents/casper-tools."));
    expect(f.screen()).toContain("1. Stay here");
    expect(f.screen()).toContain("2. Move there");
    f.input.write("2");
    await f.until(screen => screen.includes("[folder] Working in ~/Documents/casper-tools"));
    await f.until(() => f.prompts.length === 1);
    expect(await Promise.all(f.starts.map(dir => realpath(dir)))).toEqual([f.tools]);
    expect(f.prompts[0]).toContain("improve find_tool in casper-tools");
  } finally { await f.close(); }
}), 30_000);

test("Enter stays: the request runs here, and the same project is not offered again", () => withEnv({ TERM: "xterm-256color" }, async () => {
  const f = await namedFixture();
  try {
    f.input.write("improve find_tool in casper-tools\r");
    await f.until(screen => screen.includes("This request names casper-tools"));
    f.input.write("\r");
    await f.until(() => f.prompts.length === 1);
    expect(await Promise.all(f.starts.map(dir => realpath(dir)))).toEqual([await realpath(f.project)]);
    await f.until(screen => /\bidle\b/.test(screen.split("This request names").at(-1) ?? ""));
    const asked = f.screen().split("This request names casper-tools").length;
    f.input.write("and the casper-tools docs\r");
    await f.until(() => f.prompts.length === 2);
    expect(f.screen().split("This request names casper-tools").length).toBe(asked);
  } finally { await f.close(); }
}), 30_000);

test("after the conversation started, Move keeps it in /resume and runs the request in a new one there", () => withEnv({ TERM: "xterm-256color" }, async () => {
  const f = await namedFixture();
  try {
    f.input.write("say hello\r");
    await f.until(() => f.prompts.length === 1);
    await f.until(screen => /\bidle\b/.test(screen.split("say hello").at(-1) ?? ""));
    f.input.write("improve find_tool in casper-tools\r");
    await f.until(screen => screen.includes("This request names casper-tools"));
    f.input.write("2");
    await f.until(screen => screen.includes("the one here stays in /resume in the old folder"));
    await f.until(() => f.prompts.length === 2);
    expect(await Promise.all(f.starts.map(dir => realpath(dir)))).toEqual([await realpath(f.project), f.tools]);
    expect(f.prompts[1]).toContain("improve find_tool in casper-tools");
  } finally { await f.close(); }
}), 30_000);

test("a project used long ago, behind more than 30 newer ones, is still offered by name", () => withEnv({ TERM: "xterm-256color" }, async () => {
  const starts: string[] = [];
  const prompts: string[] = [];
  const f = await richApp(() => recordingRuntime(starts, prompts));
  try {
    await f.until(screen => screen.includes("idle"));
    const documents = path.join(await realpath(f.home), "Documents");
    const tools = path.join(documents, "casper-tools");
    await mkdir(path.join(tools, ".git"), { recursive: true });
    await savedConversation(f.home, tools, new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
    for (let index = 0; index < 35; index++) {
      const other = path.join(documents, `project-${index}`);
      await mkdir(other, { recursive: true });
      await savedConversation(f.home, other);
    }
    f.input.write("what is the folder casper-tools about\r");
    await f.until(screen => screen.includes("This request names casper-tools, in ~/Documents/casper-tools."));
  } finally { await f.close(); }
}), 30_000);

/** A whole terminal screen pasted into a request: zsh history and Casper's own folder line, which names projects. */
const PASTED_SCREEN = [
  "Last login: Tue Oct 28 09:12:44 on ttys003",
  "user@mac ~ % cd ~/Documents",
  "user@mac Documents % casper",
  "[folder] This folder holds 64 projects (photo-site, notes-sync, casper-tools, lab-b3 and 60 more). To work in one: casper photo-site",
  "user@mac Documents % cd casper-tools && git status",
  "On branch main",
  "user@mac Documents % docker ps",
].join("\n");

test("a project is named only in typed words: a pasted screen and Casper's own folder line never name one; a one-line paste does", () => {
  // Resolved, as the folders are: on Windows "/home/me" is on the current drive.
  const folders = [path.resolve("/home/me/Documents/casper-tools")];
  const request = `${PASTED_SCREEN}\nwhy is the tunnel container not starting`;
  expect(namedProject(projectWords(request, [PASTED_SCREEN]), folders, "/home/me/Documents")).toBeUndefined();
  // Casper's own folder line, even when the paste was not seen as one.
  expect(projectWords("[folder] This folder holds 3 projects (a, casper-tools, b). To work in one: casper a\nhi")).toBe("hi");
  expect(projectWords("To work in one: casper casper-tools")).toBe("");
  // A pasted link or path of one line is still the person's own pointer.
  expect(namedProject(projectWords("fix the readme in ~/Documents/casper-tools", ["~/Documents/casper-tools"]), folders, "/home/me/Documents")).toBe(folders[0]);
});

test("a pasted terminal screen that names another project runs here with no question", () => withEnv({ TERM: "xterm-256color" }, async () => {
  const f = await namedFixture();
  try {
    f.input.write(`\x1b[200~${PASTED_SCREEN}\x1b[201~ why is the tunnel container not starting\r`);
    await f.until(() => f.prompts.length === 1);
    expect(f.prompts[0]).toContain("why is the tunnel container not starting");
    expect(f.screen()).not.toContain("This request names");
    expect(await Promise.all(f.starts.map(dir => realpath(dir)))).toEqual([await realpath(f.project)]);
  } finally { await f.close(); }
}), 30_000);
