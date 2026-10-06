import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { loadConfiguration } from "../src/config/load";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });

async function load(project: unknown, global?: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-pages-config-"));
  roots.push(root);
  const homeDir = path.join(root, "home"), projectRoot = path.join(root, "repo");
  await mkdir(path.join(homeDir, ".casper"), { recursive: true });
  await mkdir(path.join(projectRoot, ".casper"), { recursive: true });
  await writeFile(path.join(projectRoot, ".casper/project.yaml"), stringify(project));
  if (global !== undefined) await writeFile(path.join(homeDir, ".casper/config.yaml"), stringify(global));
  return loadConfiguration({ projectRoot, homeDir });
}

test("pages: in .casper/project.yaml lists pages to always open, or turns page checks off", async () => {
  const listed = await load({ pages: ["/", "/dashboard", "/dashboard"] });
  expect(listed.pages).toEqual(["/", "/dashboard"]);
  expect(listed.warnings).toEqual([]);
  expect((await load({ pages: "off" })).pages).toBe("off");
  expect((await load({})).pages).toBeUndefined();
});

test("pages: is a project setting; your own config cannot set it", async () => {
  await expect(load({}, { pages: ["/"] })).rejects.toThrow("pages is a project setting (.casper/project.yaml); remove it from ~/.casper/config.yaml");
});

test("bad page paths are rejected with the dotted path", async () => {
  await expect(load({ pages: ["//evil.example"] })).rejects.toThrow("Invalid .casper/project.yaml: pages[0] must be a path on the site");
  await expect(load({ pages: ["/ok", "dashboard"] })).rejects.toThrow("pages[1] must be a path");
  await expect(load({ pages: "/dashboard" })).rejects.toThrow("pages must be off or a list of paths");
  await expect(load({ pages: Array.from({ length: 9 }, (_, index) => `/p${index}`) })).rejects.toThrow("at most 8 are allowed");
});
