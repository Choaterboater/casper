import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attachImages, imageMimeType, MAX_IMAGES, startsWithImageFile } from "../src/app/images";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function folder(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-images-"));
  dirs.push(dir);
  return dir;
}

test("a dropped image path becomes [image 1] and the file goes with the request", async () => {
  const dir = await folder();
  const shot = path.join(dir, "shot.png");
  await writeFile(shot, PNG);
  const result = await attachImages(`make it look like ${shot} please`, { cwd: dir, home: dir, platform: "darwin" });
  expect(result.text).toBe(`make it look like [image 1] please\n\n[image 1] is the file ${shot}`);
  expect(result.images).toEqual([{ data: PNG.toString("base64"), mimeType: "image/png" }]);
  expect(result.notes).toEqual([]);
});

test("a path the terminal escaped (spaces) or quoted is read, and ~ is the home folder", async () => {
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
  const result = await attachImages(`[image 1] next to ${shot}`, { cwd: dir, home: dir, pasted, platform: "linux" });
  expect(result.text.split("\n")[0]).toBe("[image 1] next to [image 2]");
  expect(result.images.map((image) => image.mimeType)).toEqual(["image/jpeg", "image/png"]);
});

test("a pasted image the user deleted from the line is not sent", async () => {
  const dir = await folder();
  const pasted = new Map([[1, { data: JPEG.toString("base64"), mimeType: "image/jpeg" }]]);
  const result = await attachImages("no picture after all", { cwd: dir, home: dir, pasted, platform: "linux" });
  expect(result.images).toEqual([]);
  expect(result.text).toBe("no picture after all");
});

test("words and relative names stay text; a missing or non-image file stays as typed", async () => {
  const dir = await folder();
  await writeFile(path.join(dir, "logo.png"), PNG);
  await writeFile(path.join(dir, "fake.png"), "not an image");
  const typed = `make logo.png smaller, see ${path.join(dir, "gone.png")} and ${path.join(dir, "fake.png")}`;
  const result = await attachImages(typed, { cwd: dir, home: dir, platform: "darwin" });
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

test("at most MAX_IMAGES pictures go with one request", async () => {
  const dir = await folder();
  const names: string[] = [];
  for (let index = 0; index < MAX_IMAGES + 2; index++) {
    const name = path.join(dir, `${index}.png`);
    await writeFile(name, PNG);
    names.push(name);
  }
  const result = await attachImages(names.join(" "), { cwd: dir, home: dir, platform: "darwin" });
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

test("a line that starts with a picture file's path is a request; a command or missing file is not", async () => {
  const dir = await folder();
  await writeFile(path.join(dir, "Screen Shot.png"), PNG);
  const options = { cwd: dir, home: dir, platform: "darwin" as const };
  expect(await startsWithImageFile(`${dir.replaceAll(" ", "\\ ")}/Screen\\ Shot.png why is this broken?`, options)).toBe(true);
  expect(await startsWithImageFile("~/Screen\\ Shot.png", options)).toBe(true);
  expect(await startsWithImageFile("/help", options)).toBe(false);
  expect(await startsWithImageFile(`${dir}/missing.png fix it`, options)).toBe(false);
  expect(await startsWithImageFile(`/model ${dir}/Screen\\ Shot.png`, options)).toBe(false);
});
