import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { broadFolder } from "../src/project/inspect";
import { formatProjectContext, loadProjectContext } from "../src/project/context";
import { removeTempDir } from "./support/temp-dir";

const info = (root: string) => ({ cwd: root, root, name: path.basename(root), gitBranch: null, isGit: false });

test("the home folder and a drive's top are broad; a folder inside home is not", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-broad-")));
  try {
    expect(broadFolder(home, home)).toBe("home");
    expect(broadFolder(path.join(home, "Projects", "app"), home)).toBeUndefined();
    expect(broadFolder(path.parse(home).root, home)).toBe("drive");
  } finally { await removeTempDir(home); }
});

test("opened in the home folder, the model is told a request need not be a project and where a new one goes; a project gets no such line", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-home-prompt-")));
  const project = path.join(home, "Projects", "app");
  await mkdir(project, { recursive: true });
  try {
    const atHome = formatProjectContext(await loadProjectContext(info(home), { homeDir: home }));
    const projects = process.platform === "win32" ? path.win32.join(home, "Projects") : "~/Projects";
    expect(atHome).toContain(`- This is the user's home folder: a request here need not be about a project. Don't search it broadly or add files at its top; a new project goes in ${projects}/<name>, and for one of theirs, ask its path.`);
    expect(formatProjectContext(await loadProjectContext(info(home), { homeDir: home }), true)).toContain("This is the user's home folder: a request here need not be about a project");
    expect(formatProjectContext(await loadProjectContext(info(project), { homeDir: home }))).not.toContain("need not be about a project");
  } finally { await removeTempDir(home); }
});

test("a task in the home folder doesn't list it: no change list or undo, and the receipt says why", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-home-snapshot-")));
  const project = path.join(home, "Projects", "app");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(home, "notes.txt"), "x");
  await writeFile(path.join(project, "a.ts"), "x");
  const input = Object.assign(new PassThrough(), { isTTY: false });
  const output = Object.assign(new EventEmitter(), { isTTY: false, write: () => true });
  const app = new CasperApp({ input, output, sessionHomeDir: home });
  try {
    expect(await app.snapshotWorkspace(home)).toBeUndefined();
    expect(app.snapshotFailure).toBe("not a project folder (your home folder)");
    app.snapshotFailure = undefined;
    expect([...(await app.snapshotWorkspace(project))?.keys() ?? []]).toEqual(["a.ts"]);
    expect(app.snapshotFailure).toBeUndefined();
  } finally {
    await app.close();
    input.destroy();
    await removeTempDir(home);
  }
});
