import { afterEach, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readProjectText, removeProjectFile, writeProjectFile } from "../src/platform/files";
import { posixOnly } from "./support/platform";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function folders() {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-project-files-"));
  dirs.push(base);
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "outside text");
  return { root, outside };
}

posixOnly("reads a project file, but never through a link to a file or a folder outside", async () => {
  const { root, outside } = await folders();
  await writeFile(path.join(root, "a.txt"), "hello");
  expect(await readProjectText(root, "a.txt", 100)).toBe("hello");
  expect(await readProjectText(root, "missing.txt", 100)).toBeUndefined();
  await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  await expect(readProjectText(root, "link.txt", 100)).rejects.toThrow("is a link; Casper won't read through it");
  await symlink(outside, path.join(root, "out"));
  await expect(readProjectText(root, "out/secret.txt", 100)).rejects.toThrow("goes through a link");
  await expect(readProjectText(root, "../outside/secret.txt", 100)).rejects.toThrow("is not a path inside the project");
  await expect(readProjectText(root, "a.txt", 2)).rejects.toThrow("is over 2 bytes");
});

posixOnly("writes new files and folders, keeps existing ones in create mode, and never writes through a link", async () => {
  const { root, outside } = await folders();
  expect(await writeProjectFile(root, "src/deep/new.py", "print(1)\n", { mode: "create" })).toBe("written");
  expect(await readFile(path.join(root, "src/deep/new.py"), "utf8")).toBe("print(1)\n");
  expect(await writeProjectFile(root, "src/deep/new.py", "other", { mode: "create" })).toBe("kept");
  expect(await writeProjectFile(root, "src/deep/new.py", "print(2)\n", { mode: "replace" })).toBe("written");
  expect(await writeProjectFile(root, "src/deep/new.py", "print(3)\n", { mode: "append" })).toBe("written");
  expect(await readFile(path.join(root, "src/deep/new.py"), "utf8")).toBe("print(2)\nprint(3)\n");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  await expect(writeProjectFile(root, "link.txt", "x", { mode: "replace" })).rejects.toThrow("is a link; Casper won't write through it");
  await symlink(outside, path.join(root, "out"));
  await expect(writeProjectFile(root, "out/new.txt", "x", { mode: "create" })).rejects.toThrow("goes through a link");
  expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside text");
  await expect(lstat(path.join(outside, "new.txt"))).rejects.toThrow();
});

posixOnly("removes a link itself, never what it points to", async () => {
  const { root, outside } = await folders();
  await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  expect(await removeProjectFile(root, "link.txt")).toBe("removed");
  expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside text");
  expect(await removeProjectFile(root, "link.txt")).toBe("missing");
  await symlink(outside, path.join(root, "out"));
  await expect(removeProjectFile(root, "out/secret.txt")).rejects.toThrow("goes through a link");
  await mkdir(path.join(root, "folder"));
  await expect(removeProjectFile(root, "folder")).rejects.toThrow("is a folder");
});
