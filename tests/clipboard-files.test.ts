import { expect, test } from "bun:test";
import { hasLineControls } from "../src/tui/format";
import {
  CLIPBOARD_FILES_BYTES, clipboardFilesCommands, clipboardFilesFromOutput, fileUriPath, readClipboardFiles, runClipboardTool,
  type ClipboardFilesCommand,
} from "../src/tui/clipboard-files";

test("a file:// address from a file manager decodes to its local path", () => {
  expect(fileUriPath("file:///home/me/Screen%20Shot%201.png")).toBe("/home/me/Screen Shot 1.png");
  expect(fileUriPath("file://localhost/tmp/a.png")).toBe("/tmp/a.png");
  expect(fileUriPath("FILE://LOCALHOST/tmp/a.png")).toBe("/tmp/a.png");
  expect(fileUriPath("file:///Users/me/caf%C3%A9.jpg")).toBe("/Users/me/café.jpg");
  expect(fileUriPath("file:///Users/me/Bob's%20%22shot%22.png")).toBe("/Users/me/Bob's \"shot\".png");
  expect(fileUriPath("file:///home/me/folder/")).toBe("/home/me/folder/");
});

test("a file:// address that is not a plain local path is refused: raw controls, another computer, another scheme", () => {
  for (const bad of [
    // Raw spaces and controls are not allowed in an address at all.
    "file:///tmp/a b.png", "file:///tmp/a\tb.png", "file:///tmp/a\nb.png", "file:///tmp/a\x1b[2Jb.png", "file:///tmp/a\u0085b.png",
    // Another computer, or a host that hides one.
    "file://nas/shots/pic.png", "file://evil.example/tmp/a.png", "file://user@host/tmp/a.png", "file://localhost.evil.example/tmp/a.png",
    // Other schemes and shapes.
    "smb://nas/shots/pic.png", "http://example.com/a.png", "https://example.com/a.png", "javascript:alert(1)",
    "data:image/png;base64,AAAA", "file:a.png", "file:/tmp/a.png", "file://", "/tmp/a.png", "",
    // A query or fragment, an escaped slash, and a bad escape.
    "file:///tmp/a.png?x=1", "file:///tmp/a.png#top", "file:///tmp/a%2Fb.png", "file:///tmp/a%2fb.png", "file:///tmp/a%E0%A4%A.png", "file:///tmp/%ZZ.png",
  ]) expect(fileUriPath(bad)).toBeUndefined();
});

test("a file:// name with an escaped control or bidi character comes through as it is, for the paste to leave out and say so", () => {
  // A line break, an escape sequence, NUL, DEL, C1, and bidi overrides: never turned into a name that looks fine.
  for (const [uri, name] of [
    ["file:///tmp/a%0Ab.png", "/tmp/a\nb.png"], ["file:///tmp/a%0D%0Ab.png", "/tmp/a\r\nb.png"], ["file:///tmp/%1B%5B31mred.png", "/tmp/\x1b[31mred.png"],
    ["file:///tmp/a%00.png", "/tmp/a\x00.png"], ["file:///tmp/a%7F.png", "/tmp/a\x7f.png"], ["file:///tmp/a%C2%9B.png", "/tmp/a\x9b.png"],
    ["file:///tmp/%E2%80%AEgnp.exe", "/tmp/‮gnp.exe"], ["file:///tmp/%E2%81%A6a.png", "/tmp/⁦a.png"],
  ] as const) {
    expect(fileUriPath(uri)).toBe(name);
    expect(hasLineControls(name)).toBe(true);
  }
});

test("a uri-list keeps the local files and drops comments and anything else; a path list keeps absolute Windows paths", () => {
  const list = "# copied\r\nfile:///home/me/a.png\r\nhttps://example.com/b.png\r\nfile://nas/c.png\r\nfile:///home/me/notes%20v2.txt\r\nfile:///home/me/%E2%80%AEgnp.exe\r\n";
  // A name with a bidi character is kept so the paste can say it left it out.
  expect(clipboardFilesFromOutput(list, "uris")).toEqual(["/home/me/a.png", "/home/me/notes v2.txt", "/home/me/\u202egnp.exe"]);
  const paths = "C:\\Users\\me\\a.png\r\n\\\\nas\\shots\\b.png\r\nrelative\\c.png\r\n/d.png\r\nC:\\Users\\me\\\u202egnp.exe\r\n";
  expect(clipboardFilesFromOutput(paths, "paths")).toEqual(["C:\\Users\\me\\a.png", "\\\\nas\\shots\\b.png", "C:\\Users\\me\\\u202egnp.exe"]);
});

test("each system's clipboard tool is a fixed program and fixed arguments, by full path where the system has one", () => {
  const [mac] = clipboardFilesCommands("darwin", {});
  expect(mac!.file).toBe("/usr/bin/osascript");
  expect(mac!.output).toBe("uris");
  // osascript gets the script as -e lines only: no file, no argument from the clipboard or the environment.
  expect(mac!.args.filter((_, index) => index % 2 === 0).every((flag) => flag === "-e")).toBe(true);
  expect(mac!.args.join("\n")).toContain("NSPasteboardURLReadingFileURLsOnlyKey");
  expect(mac!.args.join("\n")).toContain("filePathURL()");

  expect(clipboardFilesCommands("win32", { SystemRoot: "D:\\Win" })).toEqual([{
    file: "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }"],
    output: "paths",
  }]);
  expect(clipboardFilesCommands("win32", {})[0]!.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");

  const wayland: ClipboardFilesCommand = { file: "wl-paste", args: ["--no-newline", "--type", "text/uri-list"], output: "uris" };
  const x11: ClipboardFilesCommand = { file: "xclip", args: ["-selection", "clipboard", "-t", "text/uri-list", "-o"], output: "uris" };
  expect(clipboardFilesCommands("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toEqual([wayland, x11]);
  expect(clipboardFilesCommands("linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual([wayland]);
  expect(clipboardFilesCommands("linux", { DISPLAY: ":0" })).toEqual([x11]);
  expect(clipboardFilesCommands("linux", {})).toEqual([]);
});

test("the next tool is tried only when one is not installed; a Wayland clipboard with no files never falls back to X11", async () => {
  const env = { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" };
  const ran: string[] = [];
  const answers = (byFile: Record<string, string | null | undefined>) => async (command: ClipboardFilesCommand) => { ran.push(command.file); return byFile[command.file]; };
  expect(await readClipboardFiles({ platform: "linux", env, run: answers({ "wl-paste": null, xclip: "file:///stale.png" }) })).toBeNull();
  expect(ran).toEqual(["wl-paste"]);
  ran.length = 0;
  expect(await readClipboardFiles({ platform: "linux", env, run: answers({ "wl-paste": undefined, xclip: "file:///home/me/a.png\n" }) })).toEqual(["/home/me/a.png"]);
  expect(ran).toEqual(["wl-paste", "xclip"]);
  expect(await readClipboardFiles({ platform: "linux", env, run: answers({}) })).toBeUndefined();
  expect(await readClipboardFiles({ platform: "linux", env: {}, run: answers({}) })).toBeUndefined();
  // Only addresses that are not local files: nothing to paste.
  expect(await readClipboardFiles({ platform: "darwin", env: {}, run: async () => "https://example.com/a.png\n" })).toBeNull();
  expect(await readClipboardFiles({ platform: "win32", env: {}, run: async () => "C:\\Users\\me\\a.png\r\nC:\\Users\\me\\b.txt\r\n" })).toEqual(["C:\\Users\\me\\a.png", "C:\\Users\\me\\b.txt"]);
});

const bun = (script: string, ...args: string[]): ClipboardFilesCommand => ({ file: process.execPath, args: ["-e", script, ...args], output: "paths" });

test("a clipboard tool runs without a shell: its arguments reach it as they are", async () => {
  const output = await runClipboardTool(bun("process.stdout.write(JSON.stringify(process.argv.slice(1)))", "a;b", "$(echo hi)", "`id`", "x && y", "%PATH%", "| more"));
  expect(JSON.parse(output!)).toEqual(["a;b", "$(echo hi)", "`id`", "x && y", "%PATH%", "| more"]);
});

test("a clipboard tool that fails, hangs, prints too much or is not installed gives nothing", async () => {
  expect(await runClipboardTool(bun("process.exit(1)"))).toBeNull();
  expect(await runClipboardTool(bun("setInterval(() => {}, 1000)"), 300)).toBeNull();
  expect(await runClipboardTool(bun(`process.stdout.write("x".repeat(${CLIPBOARD_FILES_BYTES + 1}))`))).toBeNull();
  expect(await runClipboardTool({ file: "casper-no-such-clipboard-tool", args: [], output: "uris" })).toBeUndefined();
});
