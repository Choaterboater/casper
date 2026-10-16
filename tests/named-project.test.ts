import { expect, test } from "bun:test";
import { mkdir, realpath, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { namedProject } from "../src/app/workspace";
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
  expect(namedProject("tidy Notes before Friday", folders, "/home/me/Documents/mcp")).toBe(notes);
  // A plain word counts only as typed; a short name never does; a longer name or file isn't the folder.
  expect(namedProject("tidy my notes", folders, "/home/me/Documents/mcp")).toBeUndefined();
  expect(namedProject("fix the app", folders, "/home/me/Documents/mcp")).toBeUndefined();
  expect(namedProject("see casper-tools-old and casper-tools.md", folders, "/home/me/Documents/mcp")).toBeUndefined();
  // The open folder, or a folder inside the named one, is already there.
  expect(namedProject("improve casper-tools", folders, tools)).toBeUndefined();
  expect(namedProject("improve casper-tools", folders, path.join(tools, "src"))).toBeUndefined();
});

/** A saved conversation the way the engine stores it: one folder per working folder, a header line naming it. */
async function savedConversation(home: string, cwd: string): Promise<void> {
  const folder = path.join(home, ".casper", "agent", "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, "2026-01-01T00-00-00-000Z_fixture.jsonl");
  await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: "fixture", timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`);
  await utimes(file, new Date(), new Date());
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
