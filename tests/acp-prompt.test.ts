import { expect, test } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_EMBEDDED_TEXT, promptContent } from "../src/acp/prompt";
import { RPC, RpcFailure } from "../src/acp/rpc";
import { attachImages } from "../src/app/images";

/** A 1x1 PNG, a JPEG's first bytes and a HEIC's first bytes (an iPhone photo). */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64");
const HEIC = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]).toString("base64");
const image = (data: string, mimeType = "image/png") => ({ type: "image", mimeType, data });
const words = (text: string) => ({ type: "text", text });
const folder = path.resolve("/work/project");

test("text and a picture keep their order: the picture is [image 1] in the words and goes to the run", () => {
  const content = promptContent([words("Why is this button grey?"), image(PNG)]);
  expect(content.text).toBe("Why is this button grey?\n[image 1]");
  expect([...content.images.keys()]).toEqual([1]);
  expect(content.images.get(1)).toEqual({ data: PNG, mimeType: "image/png" });
  expect(content.notes).toEqual([]);
});

test("a picture's type comes from its bytes, not from what the client says", () => {
  expect(promptContent([image(JPEG, "image/png")]).images.get(1)!.mimeType).toBe("image/jpeg");
});

test("HEIC, empty or broken base64 and a picture over 20 MB get a note instead, and the big one is never decoded", () => {
  const heic = promptContent([words("look"), image(HEIC, "image/heic")]);
  expect(heic.images.size).toBe(0);
  expect(heic.text).toBe("look");
  expect(heic.notes).toEqual(["A picture sent with the request is not a PNG, JPEG, GIF or WebP (image/heic); it was not attached."]);
  for (const data of ["", "not base64!!", "@@@@"]) {
    const broken = promptContent([words("look"), image(data)]);
    expect(broken.images.size).toBe(0);
    expect(broken.notes).toEqual(["A picture sent with the request could not be read; it was not attached."]);
  }
  // 21 MB of base64 that would not even decode to a picture: the size alone turns it away.
  const huge = promptContent([words("look"), image("A".repeat(28 * 1024 * 1024))]);
  expect(huge.images.size).toBe(0);
  expect(huge.notes).toEqual(["A picture sent with the request is over 20 MB; it was not attached."]);
});

test("nine pictures give eight labels and one note", () => {
  const content = promptContent([words("compare"), ...Array.from({ length: 9 }, () => image(PNG))]);
  expect([...content.images.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(content.text.match(/\[image \d\]/g)).toHaveLength(8);
  expect(content.notes).toEqual(["Only 8 pictures go with one request; the rest were not attached."]);
});

test("a linked file goes as its quoted path, with its name and size; any other link as its name and address", () => {
  const file = path.join(folder, "notes.txt");
  const content = promptContent([words("What is the code word?"), { type: "resource_link", uri: pathToFileURL(file).href, name: "notes.txt", size: 2048 },
    { type: "resource_link", uri: "https://example.com/spec", name: "spec" }]);
  expect(content.text).toBe(`What is the code word?\nAttached file notes.txt (2 KB): "${file}"\nspec https://example.com/spec`);
  // No size given: no size said. A name with a line break in it stays on one line.
  expect(promptContent([{ type: "resource_link", uri: pathToFileURL(file).href, name: "two\nlines" }]).text).toBe(`Attached file two lines: "${file}"`);
});

test("a linked picture file is attached by the quoted-path rule the terminal uses", async () => {
  const file = path.join(folder, "shot one.png");
  const content = promptContent([words("Describe"), { type: "resource_link", uri: pathToFileURL(file).href, name: "shot one.png", size: 70 }]);
  expect(content.text).toBe(`Describe\nAttached file shot one.png (70 bytes): "${file}"`);
  // The same pattern attachImages reads: a quoted absolute path ending in a picture extension (the file is missing
  // here, so it stays words; the integration test sends a real one).
  const attached = await attachImages(content.text, { cwd: folder, resolve: (typed) => typed });
  expect(attached.text).toBe(content.text);
});

test("an app's link to a picture on a Windows share becomes a share path there, so the share box asks; any other share file stays an address", async () => {
  const link = { type: "resource_link", uri: "file://fileserver/share/shot.png", name: "shot.png" };
  const shot = promptContent([link], "win32").text;
  expect(shot).toBe(String.raw`Attached file shot.png: "\\fileserver\share\shot.png"`);
  const asked: string[] = [];
  const confirmShare = async (_file: string, host: string) => { asked.push(host); return false; };
  await attachImages(shot, { cwd: folder, platform: "win32", resolve: (typed) => typed, confirmShare });
  expect(asked).toEqual(["fileserver"]);
  // Any other file on a share is never handed to the model as a path to open, since no box guards that read.
  for (const uri of ["file://fileserver/share/notes.txt", "file:////fileserver/share/notes.txt"]) {
    const notes = promptContent([{ type: "resource_link", uri, name: "notes.txt" }], "win32").text;
    expect(notes).toBe(`notes.txt ${uri}`);
  }
  expect(promptContent([words("Look"), { type: "resource", resource: { uri: "file://fileserver/share/data.bin", blob: "AAAA" } }], "win32").notes)
    .toEqual(["file://fileserver/share/data.bin is not text or a picture Casper can read; it was not sent."]);
  expect(promptContent([{ type: "resource_link", uri: "file:///C:/work/a.txt", name: "a.txt" }], "win32").text).toBe(String.raw`Attached file a.txt: "C:\work\a.txt"`);
  expect(promptContent([link], "linux").text).toBe("shot.png file://fileserver/share/shot.png");
});

test("embedded text up to 256 KB goes whole; past that a file goes as its path and anything else is cut, with a note", () => {
  expect(promptContent([{ type: "resource", resource: { uri: "file:///p/b.ts", text: "x" } }]).text).toBe("file:///p/b.ts\nx");
  const big = `${"line of text\n".repeat(Math.ceil(MAX_EMBEDDED_TEXT / 13))}end`;
  const file = path.join(folder, "big.log");
  const asFile = promptContent([{ type: "resource", resource: { uri: pathToFileURL(file).href, text: big } }]);
  expect(asFile.text).toMatch(new RegExp(`^Attached file big\\.log \\(\\d+ KB\\): "${file.replace(/[\\.]/g, "\\$&")}"$`));
  expect(asFile.notes).toEqual([]);
  const cut = promptContent([{ type: "resource", resource: { uri: "zed://buffer/7", text: big } }]);
  expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(MAX_EMBEDDED_TEXT + 64);
  expect(cut.text.startsWith("zed://buffer/7\nline of text\n")).toBe(true);
  // Cut at a line: no half line at the end.
  expect(cut.text.endsWith("line of text")).toBe(true);
  expect(cut.notes).toEqual(["The text sent as zed://buffer/7 is over 256 KB; only its first 256 KB went with the request."]);
});

test("a blob is a picture when its bytes are one; otherwise a file goes as its path and anything else gets a note", () => {
  const picture = promptContent([{ type: "resource", resource: { uri: "zed://clip/1", blob: PNG, mimeType: "image/png" } }]);
  expect(picture.text).toBe("[image 1]");
  expect(picture.images.get(1)!.mimeType).toBe("image/png");
  const file = path.join(folder, "data.bin");
  const binary = Buffer.from([1, 2, 3]).toString("base64");
  expect(promptContent([{ type: "resource", resource: { uri: pathToFileURL(file).href, blob: binary } }]).text).toBe(`Attached file data.bin (3 bytes): "${file}"`);
  const other = promptContent([words("see"), { type: "resource", resource: { uri: "zed://blob/2", blob: binary } }]);
  expect(other.text).toBe("see");
  expect(other.notes).toEqual(["zed://blob/2 is not text or a picture Casper can read; it was not sent."]);
});

test("audio and an unknown block get a note", () => {
  const content = promptContent([words("hi"), { type: "audio", data: "AAAA", mimeType: "audio/wav" }, { type: "hologram" }]);
  expect(content.text).toBe("hi");
  expect(content.notes).toEqual(["Casper takes no audio; the recording was not sent.", "Casper can't read a hologram block; it was not sent."]);
});

test("a prompt with nothing Casper can read is refused with its notes; one that is not a list is refused", () => {
  let failure: unknown;
  try { promptContent([{ type: "audio", data: "AAAA", mimeType: "audio/wav" }, image(HEIC, "image/heic")]); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(RpcFailure);
  expect((failure as RpcFailure).code).toBe(RPC.invalidParams);
  expect((failure as RpcFailure).message).toBe("Nothing in the prompt Casper can read.\nCasper takes no audio; the recording was not sent.\n"
    + "A picture sent with the request is not a PNG, JPEG, GIF or WebP (image/heic); it was not attached.");
  expect(() => promptContent([words("   ")])).toThrow("Nothing in the prompt Casper can read");
  expect(() => promptContent("hello")).toThrow("prompt must be a list of content blocks");
});

test("a prompt with only a picture is allowed", () => {
  const content = promptContent([image(PNG)]);
  expect(content.text).toBe("[image 1]");
  expect(content.images.size).toBe(1);
});
