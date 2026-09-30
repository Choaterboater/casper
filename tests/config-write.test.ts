import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import { projectCommandLine, saveProjectCommand } from "../src/project/config-write";
import { needsFifos, needsSymlinks } from "./support/platform";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function project(yaml?: string) {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-config-write-"));
  temporary.push(base);
  const root = path.join(base, "project");
  const homeDir = path.join(base, "home");
  await mkdir(root);
  await mkdir(homeDir);
  if (yaml !== undefined) {
    await mkdir(path.join(root, ".casper"));
    await writeFile(path.join(root, ".casper/project.yaml"), yaml);
  }
  return { base, root, homeDir, file: path.join(root, ".casper/project.yaml") };
}

describe("saving a project test command", () => {
  test("adds verify.test and keeps comments, order and other settings", async () => {
    const original = "# Lab project\nverify:\n  # ruff is fast\n  lint: ruff check .\nconventions:\n  - plain words # keep\n";
    const { root, homeDir, file } = await project(original);
    const write = await saveProjectCommand(root, "test", "uv run pytest");
    const text = await readFile(file, "utf8");
    expect(text).toBe("# Lab project\nverify:\n  # ruff is fast\n  lint: ruff check .\n  test: uv run pytest\nconventions:\n  - plain words # keep\n");
    expect(write).toMatchObject({ line: "verify.test: uv run pytest", before: original, after: text });
    // The loader reads it back as the project's test command.
    const loaded = await loadConfiguration({ projectRoot: root, homeDir });
    expect(loaded.projectOverrides.commands?.test).toBe("uv run pytest");
    expect(loaded.projectOverrides.commands?.lint).toBe("ruff check .");
  });

  test("creates .casper/project.yaml when there is none, with nothing left over", async () => {
    const { root, file } = await project();
    const write = await saveProjectCommand(root, "test", "bun test");
    expect(await readFile(file, "utf8")).toBe("verify:\n  test: bun test\n");
    expect(write.before).toBeNull();
    expect((await readdir(path.dirname(file))).sort()).toEqual(["project.yaml"]);
  });

  test("the line shown before saving is the line written, quoting included", async () => {
    expect(projectCommandLine("test", "pytest -k 'a: b'")).toBe(`verify.test: "pytest -k 'a: b'"`);
    const { root, file } = await project("");
    await saveProjectCommand(root, "test", "pytest -k 'a: b'");
    expect(await readFile(file, "utf8")).toContain(`  test: "pytest -k 'a: b'"`);
  });

  test("an existing different command is not replaced; the same one is left alone", async () => {
    const { root, file } = await project("verify:\n  test: make test\n");
    await expect(saveProjectCommand(root, "test", "uv run pytest")).rejects.toThrow("verify.test is already set");
    await saveProjectCommand(root, "test", "make test");
    expect(await readFile(file, "utf8")).toBe("verify:\n  test: make test\n");
  });

  test("broken or odd files are refused and left as they are", async () => {
    for (const [yaml, message] of [["verify: [a\n", "does not parse"], ["- a\n- b\n", "not a mapping"], ["verify: pytest\n", "verify in .casper/project.yaml is not a mapping"]] as const) {
      const { root, file } = await project(yaml);
      await expect(saveProjectCommand(root, "test", "uv run pytest")).rejects.toThrow(message);
      expect(await readFile(file, "utf8")).toBe(yaml);
    }
  });

  test("bad names and multi-line commands are refused", async () => {
    const { root } = await project();
    await expect(saveProjectCommand(root, "deploy" as "test", "x")).rejects.toThrow("not a check name");
    await expect(saveProjectCommand(root, "test", "pytest\nrm -rf ~")).rejects.toThrow("one plain line");
    await expect(saveProjectCommand(root, "test", "  ")).rejects.toThrow("one plain line");
  });

  needsSymlinks("a linked project.yaml or .casper folder is refused, and the target is untouched", async () => {
    const { base, root } = await project();
    const outside = path.join(base, "outside.yaml");
    await writeFile(outside, "secret: 1\n");
    await mkdir(path.join(root, ".casper"));
    await symlink(outside, path.join(root, ".casper/project.yaml"));
    await expect(saveProjectCommand(root, "test", "uv run pytest")).rejects.toThrow("link or not a regular file");
    expect(await readFile(outside, "utf8")).toBe("secret: 1\n");

    const other = await project();
    const target = path.join(other.base, "elsewhere");
    await mkdir(target);
    await symlink(target, path.join(other.root, ".casper"));
    await expect(saveProjectCommand(other.root, "test", "uv run pytest")).rejects.toThrow(".casper is a link");
    expect(await readdir(target)).toEqual([]);
  });

  needsFifos("a special file is refused without waiting on it", async () => {
    const { root } = await project();
    await mkdir(path.join(root, ".casper"));
    Bun.spawnSync(["mkfifo", path.join(root, ".casper/project.yaml")]);
    await expect(saveProjectCommand(root, "test", "uv run pytest")).rejects.toThrow("not a regular file");
  });
});
