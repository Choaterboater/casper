import { afterEach, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
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

posixOnly("never writes into a hard link's shared content: replace makes a new file, append refuses", async () => {
  const { root, outside } = await folders();
  await link(path.join(outside, "secret.txt"), path.join(root, "hard.txt"));
  await expect(writeProjectFile(root, "hard.txt", "added", { mode: "append" })).rejects.toThrow("is a hard link to another file");
  expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside text");
  expect(await writeProjectFile(root, "hard.txt", "restored", { mode: "replace" })).toBe("written");
  expect(await readFile(path.join(root, "hard.txt"), "utf8")).toBe("restored");
  expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside text");
  // An ordinary file is still replaced in place.
  await writeFile(path.join(root, "plain.txt"), "a long first version");
  expect(await writeProjectFile(root, "plain.txt", "short", { mode: "replace" })).toBe("written");
  expect(await readFile(path.join(root, "plain.txt"), "utf8")).toBe("short");
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

test("a folder snapshot leaves dev server build caches out, so they never show as changes", async () => {
  const { root } = await folders();
  await writeFile(path.join(root, "page.tsx"), "export default 1\n");
  for (const cache of [".next", ".nuxt", ".svelte-kit", ".astro", ".vite", "node_modules/.vite", "__pycache__", ".streamlit/cache"]) {
    await mkdir(path.join(root, cache), { recursive: true });
    await writeFile(path.join(root, cache, "build.js"), "x");
  }
  await writeFile(path.join(root, ".streamlit/config.toml"), "[server]\n");
  const { snapshotTree } = await import("../src/task/changes");
  expect([...(await snapshotTree(root, undefined, { git: false })).keys()].sort()).toEqual([".streamlit/config.toml", "page.tsx"]);
});
