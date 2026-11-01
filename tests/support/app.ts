import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { expect } from "bun:test";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp, type CasperAppOptions } from "../../src/app";
import { loadProjectContext } from "../../src/project/context";
import type { AgentRuntime } from "../../src/runtime/types";
import { SkillRegistry } from "../../src/skills/registry";
import { removeTempDir } from "./temp-dir";
import { cleanEnv } from "./env";
import { saveFolderTrust } from "../../src/project/trust";
import { trustFolder } from "./trust";

/** How richApp's folder is made before Casper opens it. */
export interface RichAppSetup {
  /** false: a folder you haven't trusted, so Casper asks "Trust this folder?". Default: trusted. */
  trusted?: boolean;
  /** Files written into the project first (package.json, .casper/project.yaml). */
  files?: Record<string, string>;
  /** Files written into the throwaway home first (.casper/pages/<key>/<name>.html). */
  homeFiles?: Record<string, string>;
  /** The project is a git repository of its own. */
  git?: boolean;
  /** The folder holding the project is trusted (the project itself is not saved as trusted). */
  trustParent?: boolean;
  /** Open Casper in the fixture's home folder instead of the project. */
  openHome?: boolean;
}

/** An interactive CasperApp over a fake rich TTY in a temp project, with `until` on the (ANSI-free) screen. The project
 * is one you trusted (no "Trust this folder?" box) unless `setup.trusted` is false. */
export async function richApp(makeRuntime: (project: string) => AgentRuntime, options: Partial<CasperAppOptions> = {}, setup: RichAppSetup = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-rich-app-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "notes.txt"), "An empty folder would ask about a new project.\n");
  for (const [name, text] of Object.entries(setup.files ?? {})) {
    await mkdir(path.dirname(path.join(project, name)), { recursive: true });
    await writeFile(path.join(project, name), text);
  }
  for (const [name, text] of Object.entries(setup.homeFiles ?? {})) {
    await mkdir(path.dirname(path.join(home, name)), { recursive: true });
    await writeFile(path.join(home, name), text);
  }
  if (setup.git) expect(Bun.spawnSync(["git", "init", "-q", project], { env: cleanEnv() }).exitCode).toBe(0);
  // Git names a repository by its real path (macOS's /var is /private/var), as Casper's project root does.
  const opened = setup.git ? await realpath(project) : project;
  if (setup.trusted !== false) await trustFolder(opened, home);
  if (setup.trustParent) await saveFolderTrust(path.dirname(opened), home, true);
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  let pending: { test: (output: string) => boolean; resolve: () => void } | undefined;
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 30, write(text: string) {
    output += text;
    if (pending?.test(Bun.stripANSI(output))) { pending.resolve(); pending = undefined; }
  } });
  const screen = () => Bun.stripANSI(output);
  // Returns as soon as the screen matches; a slow Windows CI runner needed more than 4 s.
  const until = (test: (screen: string) => boolean, ms = 15_000) => {
    if (test(screen())) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    pending = { test, resolve };
    return Promise.race([promise, Bun.sleep(ms).then(() => { throw new Error(`timed out; screen: ${screen().slice(-800)}`); })]);
  };
  const runtime = makeRuntime(project);
  const app = new CasperApp({
    input, output: writer, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    ...options,
  });
  const interactive = app.runInteractive(setup.openHome ? home : project);
  return {
    app, input, project, home, interactive, screen, until,
    async close() { await app.close(); input.destroy(); await removeTempDir(root); },
  };
}
