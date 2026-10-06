import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import { removeTempDir } from "./support/temp-dir";

async function folders() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-big-model-config-"));
  const homeDir = path.join(root, "home");
  const projectRoot = path.join(root, "repo");
  await mkdir(path.join(homeDir, ".casper", "profiles", "work"), { recursive: true });
  await mkdir(path.join(projectRoot, ".casper"), { recursive: true });
  return { root, homeDir, projectRoot };
}

test("repair.bigModelLastTry and suggestions load from the user's config and a profile", async () => {
  const { root, homeDir, projectRoot } = await folders();
  const previous = process.env.CASPER_PROFILE;
  try {
    delete process.env.CASPER_PROFILE;
    expect((await loadConfiguration({ projectRoot, homeDir })).repair).toEqual({ maxAttempts: 3 });
    expect((await loadConfiguration({ projectRoot, homeDir })).suggestions).toBeUndefined();
    await writeFile(path.join(homeDir, ".casper/config.yaml"), "repair:\n  bigModelLastTry: true\nsuggestions: false\n");
    const loaded = await loadConfiguration({ projectRoot, homeDir });
    expect(loaded.repair).toEqual({ maxAttempts: 3, bigModelLastTry: true });
    expect(loaded.suggestions).toBe(false);
    expect(loaded.updates).toBeUndefined();
    expect(loaded.warnings).toEqual([]);
    await writeFile(path.join(homeDir, ".casper/config.yaml"), "updates: off\n");
    expect((await loadConfiguration({ projectRoot, homeDir })).updates).toBe(false);
    await writeFile(path.join(homeDir, ".casper/config.yaml"), "updates: sometimes\n");
    await expect(loadConfiguration({ projectRoot, homeDir })).rejects.toThrow("updates must be true or false");
    await writeFile(path.join(homeDir, ".casper/config.yaml"), "repair:\n  bigModelLastTry: true\nsuggestions: false\n");
    await writeFile(path.join(homeDir, ".casper/profiles/work/config.yaml"), "repair:\n  bigModelLastTry: false\nsuggestions: true\n");
    const profile = await loadConfiguration({ projectRoot, homeDir, profileName: "work" });
    expect(profile.repair.bigModelLastTry).toBe(false);
    expect(profile.suggestions).toBe(true);
    await writeFile(path.join(homeDir, ".casper/config.yaml"), "repair:\n  bigModelLastTry: yes please\n");
    await expect(loadConfiguration({ projectRoot, homeDir })).rejects.toThrow("repair.bigModelLastTry must be true or false");
  } finally {
    if (previous === undefined) delete process.env.CASPER_PROFILE; else process.env.CASPER_PROFILE = previous;
    await removeTempDir(root);
  }
});

test("a project cannot choose to spend on the big model or turn suggestions on or off", async () => {
  const { root, homeDir, projectRoot } = await folders();
  try {
    await writeFile(path.join(projectRoot, ".casper/project.yaml"), "repair:\n  bigModelLastTry: true\n");
    await expect(loadConfiguration({ projectRoot, homeDir })).rejects.toThrow(
      "repair.bigModelLastTry is a user setting (~/.casper/config.yaml); a project cannot choose to spend on your big model");
    await writeFile(path.join(projectRoot, ".casper/project.yaml"), "repair:\n  bigModelLastTry: false\n");
    await expect(loadConfiguration({ projectRoot, homeDir })).rejects.toThrow("a project cannot choose to spend on your big model");
    await writeFile(path.join(projectRoot, ".casper/project.yaml"), "suggestions: true\n");
    await expect(loadConfiguration({ projectRoot, homeDir })).rejects.toThrow("suggestions is a user setting");
    await writeFile(path.join(projectRoot, ".casper/project.yaml"), "updates: false\n");
    await expect(loadConfiguration({ projectRoot, homeDir })).rejects.toThrow("updates is a user setting");
  } finally {
    await removeTempDir(root);
  }
});
