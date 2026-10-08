import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeImage, RuntimeSession } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { readClipboardFiles } from "../src/tui/clipboard-files";
import { clipboardDefaults, PASTE_IMAGE_KEY } from "../src/tui/surface";
import { removeTempDir } from "./support/temp-dir";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function plainScreen() {
  let output = "";
  const waiters: Array<{ test: (output: string) => boolean; resolve: () => void }> = [];
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 30, write(text: string) {
    output += Bun.stripANSI(text);
    for (const waiter of [...waiters]) if (waiter.test(output)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
  } });
  return {
    writer,
    get output() { return output; },
    until(test: (output: string) => boolean): Promise<void> {
      if (test(output)) return Promise.resolve();
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const timer = setTimeout(() => reject(new Error(`screen did not match; it ends with:\n${output.slice(-2500)}`)), 20_000);
      waiters.push({ test, resolve: () => { clearTimeout(timer); resolve(); } });
      return promise;
    },
  };
}

/** A project with no checks and a model that sees pictures (`vision`) or not; `big` is a role that can. */
async function fixture(options: { vision: boolean; big?: string }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-images-app-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper/project.yaml"), "verification:\n  mode: off\n");
  const shot = path.join(root, "shot.png");
  await writeFile(shot, PNG);
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  let current = "fixture/text";
  const prompts: Array<{ model: string; text: string; images?: readonly RuntimeImage[] }> = [];
  const selections: string[] = [];
  const session: RuntimeSession = {
    getStatus: () => ({ provider: "fixture", model: current.split("/")[1], auth: "configured", images: current === options.big || options.vision }),
    getState: () => ({ cwd: project, isStreaming: false }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    abort: async () => {}, setTools: () => {},
    visionModel: () => options.big ? { provider: "fixture", id: options.big.split("/")[1]!, images: true } : undefined,
    selectModel: async (selection) => {
      selections.push(selection.query!);
      current = selection.query!;
      return { status: session.getStatus!(), selected: true, savedDefault: false };
    },
    prompt: async (text, _signal, promptOptions) => {
      prompts.push({ model: current, text, ...(promptOptions?.images ? { images: promptOptions.images } : {}) });
      emit({ type: "assistant_response_start", provider: "fixture", model: current });
      emit({ type: "assistant_text_delta", delta: "Looked.\n" });
      emit({ type: "assistant_response_end", stopReason: "stop" });
    },
  };
  const runtime: AgentRuntime = { start: async () => session, dispose: async () => {} };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = plainScreen();
  let plainOutput = "";
  const make = (tty: boolean) => new CasperApp({
    ...(tty ? { input, output: screen.writer } : { output: { write: (text: string) => { plainOutput += text; } } }),
    runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  return { project, shot, prompts, selections, model: () => current, input, screen, make, plain: () => plainOutput, cleanup: async () => { input.destroy(); await removeTempDir(root); } };
}

/** Idle again after `marker`: the task is over and the prompt takes a command. */
const idleAfter = (marker: string) => (output: string) => output.includes(marker) && output.slice(output.lastIndexOf(marker)).includes("idle");
const waiting = (question: string) => (output: string) => output.includes(question) && output.slice(output.lastIndexOf(question)).includes("? waiting for you");

test("a model that sees pictures gets a dropped image file as [image 1]", async () => {
  const f = await fixture({ vision: true });
  const app = f.make(false);
  try {
    await app.runOnce(`what is wrong with ${f.shot}`, f.project);
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]!.text).toContain("what is wrong with [image 1]");
    expect(f.prompts[0]!.text).toContain(`[image 1] is the file ${f.shot}`);
    expect(f.prompts[0]!.images).toEqual([{ data: PNG.toString("base64"), mimeType: "image/png" }]);
    expect(f.selections).toEqual([]);
  } finally { await app.close(); await f.cleanup(); }
});

test("a text-only model asks: 2 switches for this request and goes back after it", async () => {
  const f = await fixture({ vision: false, big: "fixture/eyes" });
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write(`make the page look like ${f.shot}\r`);
    await f.screen.until(waiting("can't see pictures"));
    expect(f.screen.output).toContain("text can't see pictures, and this request has one.");
    expect(f.screen.output).toContain("Switch to fixture/eyes for this request");
    expect(f.screen.output).toContain("Send without it");
    f.input.write("2");
    await f.screen.until(idleAfter("Back on fixture/text"));
    expect(f.prompts[0]!.model).toBe("fixture/eyes");
    expect(f.prompts[0]!.images).toHaveLength(1);
    expect(f.selections).toEqual(["fixture/eyes", "fixture/text"]);
  } finally {
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
});

test("2 then /plan that stops at the plan: the plan runs on your model, and no switch is left behind", async () => {
  const f = await fixture({ vision: false, big: "fixture/eyes" });
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write(`/plan make the page look like ${f.shot}\r`);
    await f.screen.until(waiting("can't see pictures"));
    f.input.write("2");
    // The fixture's answer has no Plan: steps, so the plan turn stops before any build.
    await f.screen.until(idleAfter("nothing was built"));
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]!.model).toBe("fixture/text");
    expect(f.selections).toEqual([]);
    expect(f.model()).toBe("fixture/text");
  } finally {
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
});

test("2 then 1 Plan first at the panel, and the plan stops: still on your model", async () => {
  const f = await fixture({ vision: false, big: "fixture/eyes" });
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write(`add a login page like ${f.shot}, then add a signup page, then add a logout button, and also add a help page\r`);
    await f.screen.until(waiting("can't see pictures"));
    f.input.write("2");
    await f.screen.until(waiting("Suggested: plan first"));
    f.input.write("1");
    await f.screen.until(idleAfter("nothing was built"));
    expect(f.prompts.map((prompt) => prompt.model)).toEqual(["fixture/text"]);
    expect(f.selections).toEqual([]);
    expect(f.model()).toBe("fixture/text");
  } finally {
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
});

test("a picture file dropped at the start of the line is a request, not a command", async () => {
  const f = await fixture({ vision: true });
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write(`${f.shot} why is this broken?\r`);
    await f.screen.until(idleAfter("Looked."));
    expect(f.screen.output).not.toContain("Unknown command");
    expect(f.prompts[0]!.text).toContain("[image 1] why is this broken?");
    expect(f.prompts[0]!.images).toHaveLength(1);
  } finally {
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
});

test("1 sends the request without the picture, on the same model", async () => {
  const f = await fixture({ vision: false, big: "fixture/eyes" });
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write(`make the page look like ${f.shot}\r`);
    await f.screen.until(waiting("can't see pictures"));
    f.input.write("1");
    await f.screen.until(idleAfter("Looked."));
    expect(f.prompts[0]!.model).toBe("fixture/text");
    expect(f.prompts[0]!.images).toBeUndefined();
    expect(f.selections).toEqual([]);
  } finally {
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
});

test("one-shot on a text-only model says so in one line and never switches", async () => {
  const f = await fixture({ vision: false, big: "fixture/eyes" });
  const app = f.make(false);
  try {
    await app.runOnce(`look at ${f.shot}`, f.project);
    expect(f.plain()).toContain("[image] text can't see pictures; the request goes without it. fixture/eyes can see them (/model fixture/eyes).");
    expect(f.prompts[0]!.images).toBeUndefined();
    expect(f.selections).toEqual([]);
  } finally { await app.close(); await f.cleanup(); }
});

test(`${PASTE_IMAGE_KEY} pastes the clipboard's picture as [image 1] and it goes with the request`, async () => {
  const f = await fixture({ vision: true });
  const previous = { ...clipboardDefaults };
  clipboardDefaults.image = async () => new Uint8Array(PNG);
  clipboardDefaults.files = async () => null;
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write("fix this ");
    f.input.write(PASTE_IMAGE_KEY === "ctrl+v" ? "\x16" : "\x1bv");
    await f.screen.until((output) => output.includes("fix this [image 1]"));
    f.input.write("\r");
    await f.screen.until(idleAfter("Looked."));
    expect(f.prompts[0]!.text).toContain("fix this [image 1]");
    expect(f.prompts[0]!.images).toEqual([{ data: PNG.toString("base64"), mimeType: "image/png" }]);
    const saved = /\n\[image 1\] is the file (.+pasted-image-1-[0-9a-f]{8}\.png)$/.exec(f.prompts[0]!.text)?.[1];
    expect(saved).toBeDefined();
    expect(await Bun.file(saved!).bytes()).toEqual(new Uint8Array(PNG));
    f.input.write("/exit\r"); await interactive; await app.close();
    expect(await Bun.file(saved!).exists()).toBe(false);
  } finally {
    Object.assign(clipboardDefaults, previous);
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
});

test(`${PASTE_IMAGE_KEY} with only text on the clipboard pastes it without terminal control codes`, async () => {
  const f = await fixture({ vision: true });
  const previous = { ...clipboardDefaults };
  clipboardDefaults.image = async () => null;
  clipboardDefaults.files = async () => null;
  clipboardDefaults.text = async () => "fix the header\x1b]0;PWNED\x07\x1b[2J\x1b[31m red\x1b[201~ done";
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write(PASTE_IMAGE_KEY === "ctrl+v" ? "\x16" : "\x1bv");
    await f.screen.until((output) => output.includes("done"));
    f.input.write("\r");
    await f.screen.until(idleAfter("Looked."));
    expect(f.prompts[0]!.text).toContain("fix the header");
    expect(f.prompts[0]!.text).toContain("done");
    expect(f.prompts[0]!.text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  } finally {
    Object.assign(clipboardDefaults, previous);
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
});

test(`${PASTE_IMAGE_KEY} refuses a clipboard picture over 20 MB, like a picture file`, async () => {
  const f = await fixture({ vision: true });
  const previous = { ...clipboardDefaults };
  const big = new Uint8Array(21 * 1024 * 1024);
  big.set(PNG);
  clipboardDefaults.image = async () => big;
  clipboardDefaults.files = async () => null;
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write("fix this ");
    f.input.write(PASTE_IMAGE_KEY === "ctrl+v" ? "\x16" : "\x1bv");
    await f.screen.until((output) => output.includes("over 20 MB; not attached"));
    f.input.write("\r");
    await f.screen.until(idleAfter("Looked."));
    expect(f.prompts[0]!.images).toBeUndefined();
  } finally {
    Object.assign(clipboardDefaults, previous);
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
});

const PASTE = PASTE_IMAGE_KEY === "ctrl+v" ? "\x16" : "\x1bv";

test(`${PASTE_IMAGE_KEY} with a picture file copied in a file manager attaches it like a dropped file`, async () => {
  const f = await fixture({ vision: true });
  const previous = { ...clipboardDefaults };
  let textRead = false;
  clipboardDefaults.image = async () => null;
  clipboardDefaults.files = async () => [f.shot];
  clipboardDefaults.text = async () => { textRead = true; return "shot.png"; };
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write("fix this ");
    f.input.write(PASTE);
    await f.screen.until((output) => output.includes('shot.png"'));
    f.input.write("\r");
    await f.screen.until(idleAfter("Looked."));
    expect(f.prompts[0]!.text).toContain("User request:\nfix this [image 1]\n");
    expect(f.prompts[0]!.text).toContain(`\n[image 1] is the file ${f.shot}`);
    expect(f.prompts[0]!.images).toEqual([{ data: PNG.toString("base64"), mimeType: "image/png" }]);
    expect(f.screen.output).not.toContain("no picture on the clipboard");
    expect(textRead).toBe(false);
  } finally {
    Object.assign(clipboardDefaults, previous);
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
});

test(`${PASTE_IMAGE_KEY} with several files copied: the pictures go with the request, any other file stays as its path`, async () => {
  const f = await fixture({ vision: true });
  const second = path.join(path.dirname(f.shot), "second shot.png");
  const notes = path.join(path.dirname(f.shot), "notes.txt");
  await writeFile(second, PNG);
  await writeFile(notes, "not a picture");
  const previous = { ...clipboardDefaults };
  clipboardDefaults.image = async () => null;
  clipboardDefaults.files = async () => [f.shot, second, notes];
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write(PASTE);
    await f.screen.until((output) => output.includes('notes.txt"'));
    f.input.write("\r");
    await f.screen.until(idleAfter("Looked."));
    expect(f.prompts[0]!.text).toContain(`User request:\n[image 1] [image 2] "${notes}"\n`);
    expect(f.prompts[0]!.text).toContain(`\n[image 1] is the file ${f.shot}\n[image 2] is the file ${second}`);
    expect(f.prompts[0]!.images).toHaveLength(2);
  } finally {
    Object.assign(clipboardDefaults, previous);
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
});

test(`${PASTE_IMAGE_KEY} with a file that is not a picture pastes its path and sends no picture`, async () => {
  const f = await fixture({ vision: true });
  const notes = path.join(path.dirname(f.shot), "notes.txt");
  await writeFile(notes, "not a picture");
  const previous = { ...clipboardDefaults };
  clipboardDefaults.image = async () => null;
  clipboardDefaults.files = async () => [notes];
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write("summarize ");
    f.input.write(PASTE);
    await f.screen.until((output) => output.includes('notes.txt"'));
    f.input.write("\r");
    await f.screen.until(idleAfter("Looked."));
    expect(f.prompts[0]!.text).toEndWith(`User request:\nsummarize "${notes}"`);
    expect(f.prompts[0]!.images).toBeUndefined();
  } finally {
    Object.assign(clipboardDefaults, previous);
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
});

test(`${PASTE_IMAGE_KEY}: a picture on the clipboard comes before copied files, except where files are read first (a Mac)`, async () => {
  const f = await fixture({ vision: true });
  const notes = path.join(path.dirname(f.shot), "notes.txt");
  await writeFile(notes, "not a picture");
  const previous = { ...clipboardDefaults };
  const read: string[] = [];
  clipboardDefaults.image = async () => { read.push("image"); return new Uint8Array(PNG); };
  clipboardDefaults.files = async () => { read.push("files"); return [notes]; };
  clipboardDefaults.filesFirst = false;
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write(PASTE);
    await f.screen.until((output) => output.includes("[image 1]"));
    expect(read).toEqual(["image"]);
    // Finder puts a copied file's icon on the clipboard as a picture: there the files win.
    clipboardDefaults.filesFirst = true;
    f.input.write(PASTE);
    await f.screen.until((output) => output.includes('notes.txt"'));
    expect(read).toEqual(["image", "files"]);
    f.input.write("\r");
    await f.screen.until(idleAfter("Looked."));
    expect(f.prompts[0]!.text).toContain(`User request:\n[image 1] "${notes}"\n`);
    expect(f.prompts[0]!.images).toHaveLength(1);
  } finally {
    Object.assign(clipboardDefaults, previous);
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
});

/** Files copied as this system's clipboard tool prints them (one path a line on Windows, file:// addresses
 * elsewhere), read through the real reader with only the tool faked. */
function copiedThroughTool(files: string[]): () => Promise<string[] | null | undefined> {
  if (process.platform === "win32") return () => readClipboardFiles({ platform: "win32", env: {}, run: async () => files.map((file) => `${file}\r\n`).join("") });
  return () => readClipboardFiles({ platform: "linux", env: { DISPLAY: ":0" }, run: async () => files.map((file) => `${pathToFileURL(file).href}\n`).join("") });
}

test("the paste-picture key leaves out a copied file whose name has a control or bidi character, and says so", async () => {
  const f = await fixture({ vision: true });
  const previous = { ...clipboardDefaults };
  clipboardDefaults.image = async () => null;
  clipboardDefaults.files = copiedThroughTool([path.join(path.dirname(f.shot), "a\u202egnp.exe"), path.join(path.dirname(f.shot), "b\x1b[2J.png"), f.shot]);
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write(PASTE);
    await f.screen.until((output) => output.includes("a copied file's name has control characters; left out"));
    f.input.write("\r");
    await f.screen.until(idleAfter("Looked."));
    expect(f.prompts[0]!.text).toContain("User request:\n[image 1]\n");
    expect(f.prompts[0]!.text).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    expect(f.prompts[0]!.images).toHaveLength(1);
  } finally {
    Object.assign(clipboardDefaults, previous);
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
});

test(`${PASTE_IMAGE_KEY}: when every copied name has a control character, it says so and pastes nothing else`, async () => {
  const f = await fixture({ vision: true });
  const previous = { ...clipboardDefaults };
  let textRead = false;
  clipboardDefaults.image = async () => null;
  clipboardDefaults.files = copiedThroughTool([path.join(path.dirname(f.shot), "a‮gnp.exe"), path.join(path.dirname(f.shot), "b\x1b[2J.png")]);
  clipboardDefaults.text = async () => { textRead = true; return "agnp.exe"; };
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write(PASTE);
    await f.screen.until((output) => output.includes("a copied file's name has control characters; left out"));
    expect(textRead).toBe(false);
    expect(f.screen.output).not.toContain("no picture on the clipboard");
    f.input.write("hi\r");
    await f.screen.until(idleAfter("Looked."));
    expect(f.prompts[0]!.text).toEndWith("User request:\nhi");
  } finally {
    Object.assign(clipboardDefaults, previous);
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
});

test.skipIf(process.platform !== "win32")(`Windows: ${PASTE_IMAGE_KEY} with a picture copied from another computer's share still asks before opening it`, async () => {
  const f = await fixture({ vision: true });
  const previous = { ...clipboardDefaults };
  clipboardDefaults.image = async () => null;
  clipboardDefaults.files = async () => ["\\\\nas\\shots\\pic.png"];
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write(PASTE);
    await f.screen.until((output) => output.includes('pic.png"'));
    f.input.write("\r");
    await f.screen.until(waiting("Attach this picture?"));
    expect(f.screen.output).toContain("is on another computer, nas.");
    f.input.write("1");
    await f.screen.until(idleAfter("Looked."));
    expect(f.screen.output).toContain("not opened, so not attached");
    expect(f.prompts[0]!.text).toEndWith('User request:\n"\\\\nas\\shots\\pic.png"');
    expect(f.prompts[0]!.images).toBeUndefined();
  } finally {
    Object.assign(clipboardDefaults, previous);
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
});
