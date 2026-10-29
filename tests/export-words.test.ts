import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportLine, exportRequest } from "../src/app/export-words";
import { knownFolder, knownFolderScript } from "../src/platform/known-folders";
import type { AgentRuntime } from "../src/runtime/types";
import { richApp } from "./support/app";
import { removeTempDir } from "./support/temp-dir";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

test("a typed line that only asks to save this conversation is read, typos and a place included", () => {
  expect(exportRequest("explort this session as well in a md and save to desktop")).toEqual({ folder: "desktop", jsonl: false });
  expect(exportRequest("export this session")).toEqual({ jsonl: false });
  expect(exportRequest("Save this conversation.")).toEqual({ jsonl: false });
  expect(exportRequest("please exprot the chat to my desktop")).toEqual({ folder: "desktop", jsonl: false });
  expect(exportRequest("can you save our conversation to the downloads folder?")).toEqual({ folder: "downloads", jsonl: false });
  expect(exportRequest("export the whole session as jsonl to documents")).toEqual({ folder: "documents", jsonl: true });
  expect(exportRequest("save this chat as notes.md")).toEqual({ file: "notes.md", jsonl: false });
  expect(exportRequest("dump the conversation to ~/logs/chat.jsonl")).toEqual({ file: "~/logs/chat.jsonl", jsonl: true });
  expect(exportRequest("export this session to the desktop as review.md")).toEqual({ folder: "desktop", file: "review.md", jsonl: false });
  expect(exportRequest("write out the transcript, and save it to desktop")).toEqual({ folder: "desktop", jsonl: false });
});

test("anything else is a request for the AI: code, a question, more words, or something pasted", () => {
  for (const line of [
    "export the CSV function",
    "how do I export a model",
    "how do I export this session?",
    "save this file",
    "save the session token",
    "save the session token to the desktop",
    "export this chat component to desktop",
    "save the conversation history to the database",
    "export session data",
    "export this session's messages to a database",
    "explain how to export this session",
    "export this session to desktop and then fix the login bug",
    "export this session to the desktop as ../x/notes.md",
  ]) expect([line, exportRequest(line)]).toEqual([line, undefined]);
  expect(exportRequest("export this session", ["pasted"])).toBeUndefined();
  expect(exportRequest("export this session\nand more")).toBeUndefined();
});

test("the /export line: a named folder with /export's own name, a file in it, a ~ file, and every message in /export's folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-export-words-"));
  try {
    const home = path.join(root, "home");
    const options = { home, sessionId: "abcdef0123456789", exportFolder: path.join(home, ".casper", "exports"),
      folderPath: async (name: string) => path.join(home, name === "desktop" ? "Desktop" : name) };
    expect(await exportLine({ jsonl: false }, options)).toBe("/export");
    expect(await exportLine({ folder: "desktop", jsonl: false }, options)).toBe(`/export ${path.join(home, "Desktop", "casper-conversation-abcdef01.md")}`);
    expect(await exportLine({ folder: "desktop", file: "review.md", jsonl: false }, options)).toBe(`/export ${path.join(home, "Desktop", "review.md")}`);
    expect(await exportLine({ file: "~/logs/chat.jsonl", jsonl: true }, options)).toBe(`/export ${path.join(home, "logs", "chat.jsonl")}`);
    expect(await exportLine({ file: "notes.md", jsonl: false }, options)).toBe("/export notes.md");
    expect(await exportLine({ jsonl: true }, options)).toBe(`/export ${path.join(home, ".casper", "exports", "casper-conversation-abcdef01.jsonl")}`);
    // /export makes its folder only when no file is named: the words make it for the .jsonl.
    expect(await Bun.file(path.join(home, ".casper", "exports")).stat().then((stat) => stat.isDirectory())).toBe(true);
  } finally { await removeTempDir(root); }
});

test("the Desktop, Documents and Downloads on each system: the known folder, the XDG folder, WSL's Windows folder, else the plain one", async () => {
  const calls: string[] = [];
  const run = (answers: Record<string, string | undefined>) => async (file: string, args: readonly string[]) => {
    calls.push(`${file} ${args.at(-1)}`);
    return answers[file];
  };
  const none = async () => undefined;
  // macOS: in the home folder, with nothing run.
  expect(await knownFolder("desktop", { home: "/Users/someone", platform: "darwin", env: {}, run: run({}), read: none })).toBe("/Users/someone/Desktop");
  // Windows: the known folder (here moved to OneDrive), asked of Windows PowerShell by its full path.
  const windowsPowerShell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  expect(await knownFolder("desktop", { home: "C:\\Users\\someone", platform: "win32", env: { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\someone" },
    run: run({ [windowsPowerShell]: "C:\\Users\\someone\\OneDrive\\Desktop" }), read: none })).toBe("C:\\Users\\someone\\OneDrive\\Desktop");
  expect(calls.at(-1)).toBe(`${windowsPowerShell} ${knownFolderScript("desktop")}`);
  expect(knownFolderScript("documents")).toContain("shell:Personal");
  // No answer: the plain folder in the profile.
  expect(await knownFolder("downloads", { home: "C:\\Users\\someone", platform: "win32", env: { USERPROFILE: "C:\\Users\\someone" }, run: run({}), read: none }))
    .toBe("C:\\Users\\someone\\Downloads");
  // Linux: the XDG folder, with $HOME read; none set, the plain one.
  const dirs = async (file: string) => file === "/home/someone/.config/user-dirs.dirs" ? 'XDG_DESKTOP_DIR="$HOME/Schreibtisch"\nXDG_DOWNLOAD_DIR="$HOME/"\n' : undefined;
  expect(await knownFolder("desktop", { home: "/home/someone", platform: "linux", env: {}, kernel: "", run: run({}), read: dirs })).toBe("/home/someone/Schreibtisch");
  expect(await knownFolder("downloads", { home: "/home/someone", platform: "linux", env: {}, kernel: "", run: run({}), read: dirs })).toBe("/home/someone/Downloads");
  expect(await knownFolder("documents", { home: "/home/someone", platform: "linux", env: {}, kernel: "", run: run({}), read: none })).toBe("/home/someone/Documents");
  // WSL: Windows' Desktop, through Windows' own PowerShell and wslpath.
  const wslPowerShell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  expect(await knownFolder("desktop", { home: "/home/someone", platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, read: none,
    run: run({ [wslPowerShell]: "C:\\Users\\someone\\Desktop", "/usr/bin/wslpath": "/mnt/c/Users/someone/Desktop" }) })).toBe("/mnt/c/Users/someone/Desktop");
  expect(calls.at(-1)).toBe("/usr/bin/wslpath C:\\Users\\someone\\Desktop");
  // WSL found by its kernel; Windows unreachable: the Linux folder.
  calls.length = 0;
  expect(await knownFolder("desktop", { home: "/home/someone", platform: "linux", env: {}, kernel: "Linux version 5.15.0-microsoft-standard-WSL2", run: run({}), read: none }))
    .toBe("/home/someone/Desktop");
  expect(calls).toEqual([`${wslPowerShell} ${knownFolderScript("desktop")}`]);
});

/** The screen wraps long lines (a temp folder's path): compared without any spaces or breaks. */
const squashed = (text: string) => text.replace(/\s+/g, "");
const shows = (expected: string) => (text: string) => squashed(text).includes(squashed(expected));

function exportRuntime(cwd: string, working?: Promise<void>) {
  const prompts: string[] = [];
  const started = Promise.withResolvers<void>();
  const runtime: AgentRuntime = {
    async start() {
      return {
        setTools: () => {},
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd, isStreaming: working !== undefined }),
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async (text: string) => { prompts.push(text); started.resolve(); await working; },
        recentTurns: () => [{ role: "user" as const, text: "add a ping check" }, { role: "assistant" as const, text: "Added it." }],
        getSessionInfo: () => ({ cwd, sessionId: "abcdef0123456789", sessionFile: "unused" }),
      };
    },
    async dispose() {},
  };
  return { runtime, prompts, started: started.promise };
}

test("on the screen: the owner's words save the conversation to the Desktop with no model call; during a task too", async () => {
  const desktop = await mkdtemp(path.join(os.tmpdir(), "casper-desktop-"));
  const gate = Promise.withResolvers<void>();
  let fake: ReturnType<typeof exportRuntime> | undefined;
  const app = await richApp((project) => (fake = exportRuntime(project, gate.promise)).runtime, { knownFolder: async () => desktop });
  try {
    const saved = path.join(desktop, "casper-conversation-abcdef01.md");
    await app.until((text) => text.includes("idle"));
    app.input.write("write a poem\r");
    await fake!.started;
    // During the task: saved now, never sent to the AI.
    app.input.write("explort this session as well in a md and save to desktop\r");
    await app.until(shows(`[export] Saved 2 messages to ${saved}.`));
    expect(shows(`[export] Handled here, no model call: /export ${saved} does the same.`)(app.screen())).toBe(true);
    expect(fake!.prompts).toHaveLength(1);
    expect(app.app.queuedLines).toEqual([]);
    expect(app.screen()).not.toMatch(/sent to Casper|queued · runs when/);
    expect(await readFile(saved, "utf8")).toContain("## You\n\nadd a ping check");
    gate.resolve();
    await app.until((text) => text.includes("idle"));
    // At the prompt: never over the file that is there; a request about exporting code goes to the AI.
    app.input.write("save this conversation to the desktop\r");
    await app.until(shows("is already there; nothing was changed."));
    app.input.write("export the CSV function\r");
    await app.until(() => fake!.prompts.length === 2);
    expect(fake!.prompts[1]).toContain("export the CSV function");
    expect(app.screen().match(/\[export\] Handled here/g)).toHaveLength(2);
  } finally { gate.resolve(); await app.close(); await removeTempDir(desktop); }
}, 30_000);

test("a Desktop that isn't there: nothing is saved, and the line says so", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-desktop-"));
  let fake: ReturnType<typeof exportRuntime> | undefined;
  const app = await richApp((project) => (fake = exportRuntime(project)).runtime, { knownFolder: async () => path.join(root, "no-desktop") });
  try {
    await mkdir(root, { recursive: true });
    await app.until((text) => text.includes("idle"));
    app.input.write("write a poem\r");
    await fake!.started;
    await app.until((text) => text.includes("idle"));
    app.input.write("export this session to my desktop\r");
    await app.until(shows("[export] Not saved: that folder doesn't exist."));
    expect(fake!.prompts).toHaveLength(1);
  } finally { await app.close(); await removeTempDir(root); }
}, 30_000);
