import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectInfo } from "../src/project/inspect";
import { loadProjectModel } from "../src/project/model";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function model(files: Record<string, string>, folders: string[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-swift-")); dirs.push(root);
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-swift-home-")); dirs.push(home);
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  for (const folder of folders) await mkdir(path.join(root, folder), { recursive: true });
  return loadProjectModel({ root, name: path.basename(root), isGit: false } as ProjectInfo, { homeDir: home });
}
const flag = process.platform === "darwin" ? " --disable-sandbox" : "";

test("a Swift package checks with swift test and swift build, and shows as swift", async () => {
  const detected = await model({ "Package.swift": "// swift-tools-version:5.9\n" });
  expect(detected.commands).toEqual({ test: `swift test${flag}`, build: `swift build${flag}` });
  expect(detected.languages).toContain("swift");
  expect(detected.packageManager).toBe("swift");
});

test("an Xcode project alone gets no guessed checks; with a Package.swift, swift wins", async () => {
  expect((await model({}, ["App.xcodeproj", "App.xcworkspace"])).commands).toEqual({});
  expect((await model({ "Package.swift": "" }, ["App.xcodeproj"])).commands).toEqual({ test: `swift test${flag}`, build: `swift build${flag}` });
});
