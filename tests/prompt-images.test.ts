import { afterEach, expect, test } from "bun:test";
import { readFile, readdir, stat, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attachImages, imageMimeType, MAX_IMAGES, PastedImageFiles, shareHost, startsWithImageFile } from "../src/app/images";
import { removeTempDir } from "./support/temp-dir";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");
// Real files in the temp folder use this machine's path form, so those tests read paths the way this system writes them.
const HOST = process.platform;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

async function folder(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-images-"));
  dirs.push(dir);
  return dir;
}

test("a dropped image path becomes [image 1] and the file goes with the request", async () => {
  const dir = await folder();
  const shot = path.join(dir, "shot.png");
  await writeFile(shot, PNG);
  const result = await attachImages(`make it look like ${shot} please`, { cwd: dir, home: dir, platform: HOST });
  expect(result.text).toBe(`make it look like [image 1] please\n\n[image 1] is the file ${shot}`);
  expect(result.images).toEqual([{ data: PNG.toString("base64"), mimeType: "image/png" }]);
  expect(result.notes).toEqual([]);
});

test.skipIf(process.platform === "win32")("a path the terminal escaped (spaces) or quoted is read, and ~ is the home folder", async () => {
  const dir = await folder();
  await writeFile(path.join(dir, "Screen Shot 1.png"), PNG);
  await writeFile(path.join(dir, "mock up.jpg"), JPEG);
  const escaped = `${dir.replaceAll(" ", "\\ ")}/Screen\\ Shot\\ 1.png`;
  const result = await attachImages(`${escaped} and '~/mock up.jpg'`, { cwd: "/", home: dir, platform: "darwin" });
  expect(result.text.split("\n")[0]).toBe("[image 1] and [image 2]");
  expect(result.images.map((image) => image.mimeType)).toEqual(["image/png", "image/jpeg"]);
});

test("pasted images keep their numbers and dropped files come after them", async () => {
  const dir = await folder();
  const shot = path.join(dir, "b.png");
  await writeFile(shot, PNG);
  const pasted = new Map([[1, { data: JPEG.toString("base64"), mimeType: "image/jpeg" }]]);
  const result = await attachImages(`[image 1] next to ${shot}`, { cwd: dir, home: dir, pasted, platform: HOST });
  expect(result.text.split("\n")[0]).toBe("[image 1] next to [image 2]");
  expect(result.images.map((image) => image.mimeType)).toEqual(["image/jpeg", "image/png"]);
});

test("a pasted image the user deleted from the line is not sent", async () => {
  const dir = await folder();
  const pasted = new Map([[1, { data: JPEG.toString("base64"), mimeType: "image/jpeg" }]]);
  const result = await attachImages("no picture after all", { cwd: dir, home: dir, pasted, platform: HOST });
  expect(result.images).toEqual([]);
  expect(result.text).toBe("no picture after all");
});

test("words and relative names stay text; a missing or non-image file stays as typed", async () => {
  const dir = await folder();
  await writeFile(path.join(dir, "logo.png"), PNG);
  await writeFile(path.join(dir, "fake.png"), "not an image");
  const typed = `make logo.png smaller, see ${path.join(dir, "gone.png")} and ${path.join(dir, "fake.png")}`;
  const result = await attachImages(typed, { cwd: dir, home: dir, platform: HOST });
  expect(result.text).toBe(typed);
  expect(result.images).toEqual([]);
  expect(result.notes).toEqual([`${path.join(dir, "fake.png")} is not a PNG, JPEG, GIF or WebP picture; not attached`]);
});

test("Windows paths with a drive letter are read", async () => {
  const dir = await folder();
  const shot = path.join(dir, "w.png");
  await writeFile(shot, PNG);
  // Written the way a Windows terminal pastes a dropped file (quoted); `resolve` stands in for the Windows disk.
  const windows = await attachImages(`"C:\\Users\\me\\w.png" fix it`, { cwd: dir, home: dir, platform: "win32", resolve: () => shot });
  expect(windows.text.split("\n")[0]).toBe("[image 1] fix it");
});

test("Windows network paths name their computer; local paths name none", () => {
  expect(shareHost("\\\\nas\\shots\\pic.png")).toBe("nas");
  expect(shareHost("//nas/shots/pic.png")).toBe("nas");
  expect(shareHost("\\\\?\\UNC\\files.example\\s\\pic.png")).toBe("files.example");
  expect(shareHost("\\\\10.0.0.5\\c$\\pic.png")).toBe("10.0.0.5");
  for (const local of ["C:\\Users\\me\\pic.png", "\\\\?\\C:\\pic.png", "\\\\.\\C:\\pic.png", "~\\pic.png", "/home/me/pic.png", "pic.png"]) expect(shareHost(local)).toBeUndefined();
});

/**
 * Windows: opening \\host\share\pic.png sends your Windows login (a hash of it) to that computer, so a picture
 * path like that in a request or pasted text is attached only on a yes. `resolve` stands in for the Windows disk:
 * a picture that was opened is attached, so an empty list shows it was never read.
 */
test("Windows: a picture on another computer's share asks once per computer, and a no leaves it as words", async () => {
  const dir = await folder();
  const shot = path.join(dir, "w.png");
  await writeFile(shot, PNG);
  const typed = "what is \\\\nas\\shots\\a.png and \\\\NAS\\shots\\b.png and \\\\other\\c.png";
  const asked: Array<[string, string]> = [];
  const no = await attachImages(typed, { cwd: dir, home: dir, platform: "win32", resolve: () => shot, confirmShare: async (file, host) => { asked.push([file, host]); return false; } });
  expect(asked).toEqual([["\\\\nas\\shots\\a.png", "nas"], ["\\\\other\\c.png", "other"]]);
  expect(no.images).toEqual([]);
  expect(no.text).toBe(typed);
  expect(no.notes).toEqual([
    "\\\\nas\\shots\\a.png is on another computer (nas); not opened, so not attached",
    "\\\\NAS\\shots\\b.png is on another computer (NAS); not opened, so not attached",
    "\\\\other\\c.png is on another computer (other); not opened, so not attached",
  ]);

  asked.length = 0;
  const yes = await attachImages(typed, { cwd: dir, home: dir, platform: "win32", resolve: () => shot, confirmShare: async (file, host) => { asked.push([file, host]); return host !== "other"; } });
  expect(asked.map(([, host]) => host)).toEqual(["nas", "other"]);
  expect(yes.images.length).toBe(2);
  expect(yes.text.split("\n")[0]).toBe("what is [image 1] and [image 2] and \\\\other\\c.png");

  // Quoted (a dropped file) and long-form paths ask too; with nobody to ask (one-shot) nothing is opened.
  for (const form of ['"\\\\nas\\my shots\\d.png"', "\\\\?\\UNC\\nas\\e.png"]) {
    const quiet = await attachImages(`see ${form}`, { cwd: dir, home: dir, platform: "win32", resolve: () => shot });
    expect(quiet.images).toEqual([]);
    expect(quiet.notes[0]).toContain("is on another computer (nas)");
  }
});

test("Windows: a local picture path and a pasted picture never ask", async () => {
  const dir = await folder();
  const shot = path.join(dir, "w.png");
  await writeFile(shot, PNG);
  const pasted = new Map([[1, { data: PNG.toString("base64"), mimeType: "image/png" }]]);
  const never = async () => { throw new Error("asked"); };
  const result = await attachImages(`[image 1] and "C:\\Users\\me\\w.png" and ~\\w.png`, { cwd: dir, home: dir, platform: "win32", pasted, resolve: () => shot, confirmShare: never });
  expect(result.images.length).toBe(3);
  expect(result.notes).toEqual([]);
  // On macOS and Linux a path like //nas/x.png is on this machine.
  const posix = await attachImages("see //nas/w.png", { cwd: dir, home: dir, platform: "linux", resolve: () => shot, confirmShare: never });
  expect(posix.images.length).toBe(1);
});

test("at most MAX_IMAGES pictures go with one request", async () => {
  const dir = await folder();
  const names: string[] = [];
  for (let index = 0; index < MAX_IMAGES + 2; index++) {
    const name = path.join(dir, `${index}.png`);
    await writeFile(name, PNG);
    names.push(name);
  }
  const result = await attachImages(names.join(" "), { cwd: dir, home: dir, platform: HOST });
  expect(result.images.length).toBe(MAX_IMAGES);
  expect(result.notes).toEqual([`Only ${MAX_IMAGES} pictures go with one request; the rest stay as file names`]);
});

test("image types are read from the bytes, not the name", () => {
  expect(imageMimeType(PNG)).toBe("image/png");
  expect(imageMimeType(JPEG)).toBe("image/jpeg");
  expect(imageMimeType(Buffer.from("GIF89a"))).toBe("image/gif");
  expect(imageMimeType(Buffer.from("RIFF0000WEBP"))).toBe("image/webp");
  expect(imageMimeType(Buffer.from("hello"))).toBeUndefined();
});

test.skipIf(process.platform === "win32")("a line that starts with a picture file's path is a request; a command or missing file is not", async () => {
  const dir = await folder();
  await writeFile(path.join(dir, "Screen Shot.png"), PNG);
  const options = { cwd: dir, home: dir, platform: HOST };
  expect(await startsWithImageFile(`${dir.replaceAll(" ", "\\ ")}/Screen\\ Shot.png why is this broken?`, options)).toBe(true);
  expect(await startsWithImageFile("~/Screen\\ Shot.png", options)).toBe(true);
  expect(await startsWithImageFile("/help", options)).toBe(false);
  expect(await startsWithImageFile(`${dir}/missing.png fix it`, options)).toBe(false);
  expect(await startsWithImageFile(`/model ${dir}/Screen\\ Shot.png`, options)).toBe(false);
});

const WEBP = Buffer.from("52494646000000005745425050", "hex");

test("a pasted picture is saved as a private file and its path goes on a line under the request", async () => {
  const dir = await folder();
  const files = new PastedImageFiles(dir);
  const pasted = new Map([[1, { data: PNG.toString("base64"), mimeType: "image/png" }], [2, { data: WEBP.toString("base64"), mimeType: "image/webp" }]]);
  const result = await attachImages("compare [image 1] with [image 2]", { cwd: dir, home: dir, pasted, saveTo: files, platform: HOST });
  const [request, blank, first, second] = result.text.split("\n");
  expect(request).toBe("compare [image 1] with [image 2]");
  expect(blank).toBe("");
  const one = /^\[image 1\] is the file (.+pasted-image-1-[0-9a-f]{8}\.png)$/.exec(first!)?.[1];
  const two = /^\[image 2\] is the file (.+pasted-image-2-[0-9a-f]{8}\.webp)$/.exec(second!)?.[1];
  expect(one).toBeDefined(); expect(two).toBeDefined();
  expect(one).not.toBe(two);
  expect(path.isAbsolute(one!)).toBe(true);
  expect(await readFile(one!)).toEqual(PNG);
  expect(await readFile(two!)).toEqual(WEBP);
  expect(result.images).toHaveLength(2);
  if (process.platform !== "win32") {
    expect((await stat(one!)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(one!))).mode & 0o777).toBe(0o700);
  }
  await files.remove();
  expect(await readdir(dir)).toEqual([]);
});

test("without a pasted picture nothing is saved and no line is added", async () => {
  const dir = await folder();
  const files = new PastedImageFiles(dir);
  const pasted = new Map([[1, { data: PNG.toString("base64"), mimeType: "image/png" }]]);
  const result = await attachImages("no picture after all", { cwd: dir, home: dir, pasted, saveTo: files, platform: HOST });
  expect(result.text).toBe("no picture after all");
  expect(await attachImages("plain", { cwd: dir, home: dir, saveTo: files, platform: HOST })).toMatchObject({ text: "plain", images: [] });
  expect(await readdir(dir)).toEqual([]);
});
