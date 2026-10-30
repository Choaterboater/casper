import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { openProjectFolder } from "../src/app/workspace";
import { SNAPSHOT_FILE_LIMIT } from "../src/task/changes";
import { loadProjectContext, type ProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeSession } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

/**
 * Casper opened in a NAS's docker folder: the parent of many container app folders, too big to list and with folders
 * it can't read. Every edit landed in one app folder, cloudflared/ (no git, its own docker-compose.yml), yet the
 * receipt said "Changes unknown" and the compose check ran every app's compose file. The app folder is now the work's
 * folder: its own checks run, and Casper says where to work so undo and the change list work there.
 */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) { await chmod(path.join(root, "home", "docker", "private"), 0o755).catch(() => {}); await removeTempDir(root); }
});

const COMPOSE = "services:\n  app:\n    image: busybox\n";

/** home/docker: app folders with their own compose files, one folder Casper can't read, and a model that edits cloudflared. */
async function dockerParent() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-big-parent-")));
  roots.push(root);
  const home = path.join(root, "home"), docker = path.join(home, "docker");
  for (const app of ["cloudflared", "plex", "homeassistant"]) {
    await mkdir(path.join(docker, app), { recursive: true });
    await writeFile(path.join(docker, app, "docker-compose.yml"), COMPOSE);
  }
  await writeFile(path.join(docker, "cloudflared", "config.yml"), "tunnel: old\n");
  // Root-owned on the NAS: Casper can't read it, so it can't list the parent folder.
  await mkdir(path.join(docker, "private"));
  await writeFile(path.join(docker, "private", "db.sqlite"), "");
  await chmod(path.join(docker, "private"), 0o000);
  const runtime: AgentRuntime = {
    async start(options): Promise<RuntimeSession> {
      return { getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }), getState: () => ({ cwd: docker, isStreaming: false }),
        subscribe: () => () => {}, abort: async () => {}, setTools: () => {},
        prompt: async () => {
          for (const file of ["config.yml", "docker-compose.yml"]) {
            const target = path.join(docker, "cloudflared", file);
            await writeFile(target, file === "config.yml" ? "tunnel: new\n" : `${COMPOSE}    restart: unless-stopped\n`);
            await options.afterFileEdit?.(target, new AbortController().signal);
          }
        } };
    },
    async dispose() {},
  };
  let output = "";
  const app = new CasperApp({ runtimeFactory: () => runtime, sessionHomeDir: home, output: { write: (text: string) => { output += text; } },
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context: ProjectContext) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }) });
  return { app, docker, output: () => output };
}

// Root ignores the folder's mode, so the folder would be readable.
const unreadable = process.platform !== "win32" && process.getuid?.() !== 0 ? posixOnly : test.skip;

unreadable("a folder Casper can't list: the app folder that holds every edit is the work's folder, and only its compose file is checked", async () => {
  const { app, docker, output } = await dockerParent();
  try {
    await app.runOnce("set up the cloudflared tunnel", docker);
    expect(output()).toContain("– Changes unknown: Casper could not read this folder (EACCES)");
    expect(output()).toContain("– Changed (seen by Casper's edit and write tools): cloudflared/config.yml, cloudflared/docker-compose.yml");
    // The app's own compose file, not every app's (checked when docker is on PATH; without it there is no compose check).
    if (Bun.which("docker")) expect(output()).toContain("• Casper checking: compose (checks from cloudflared)");
    expect(output()).not.toContain("plex");
    expect(output()).not.toContain("homeassistant");
    // Where undo and the change list work: the app's own folder.
    expect(output()).toContain("[folder] The work is in ~/docker/cloudflared. To work there: cd ~/docker/cloudflared && casper\n");
  } finally { await app.close(); }
}, 60_000);

/** Just enough of the app for the start-up lines. */
function startApp(home: string) {
  const out: string[] = [];
  return { app: { sessionHomeDir: home, output: { write: (text: string) => { out.push(text); } }, terminal: { rich: false } } as unknown as CasperApp, out };
}

unreadable("opening a folder Casper can't list says once that undo is off there, and which folder to open instead", async () => {
  const { docker } = await dockerParent();
  const home = path.dirname(docker);
  const { app, out } = startApp(home);
  expect(await openProjectFolder(app, docker, { platform: "linux" })).toBe(docker);
  expect(out.join("")).toContain("[folder] Casper can't read some folders in this folder, so undo and the list of changed files are off here. "
    + "To have them for one app, open its folder: cd ~/docker/cloudflared && casper\n");
  // A folder it can list says nothing.
  await chmod(path.join(docker, "private"), 0o755);
  const again = startApp(home);
  await openProjectFolder(again.app, docker, { platform: "linux" });
  expect(again.out.join("")).not.toContain("undo");
}, 60_000);

posixOnly("opening a folder of over 20,000 files says so too", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-big-parent-")));
  roots.push(root);
  const home = path.join(root, "home"), docker = path.join(home, "docker");
  await mkdir(path.join(docker, "cloudflared"), { recursive: true });
  await writeFile(path.join(docker, "cloudflared", "compose.yaml"), COMPOSE);
  for (let batch = 0; batch <= SNAPSHOT_FILE_LIMIT / 1000; batch++) {
    const folder = path.join(docker, "plex", `media-${batch}`);
    await mkdir(folder, { recursive: true });
    await Promise.all(Array.from({ length: 1000 }, (_, index) => writeFile(path.join(folder, `${index}.mkv`), "")));
  }
  const { app, out } = startApp(home);
  await openProjectFolder(app, docker, { platform: "linux" });
  expect(out.join("")).toContain("[folder] This folder has over 20,000 files, so undo and the list of changed files are off here. "
    + "To have them for one app, open its folder: cd ~/docker/cloudflared && casper\n");
}, 180_000);
