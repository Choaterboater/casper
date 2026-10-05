import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp, type CasperAppOptions } from "../../src/app";
import { loadProjectContext } from "../../src/project/context";
import type { AgentRuntime } from "../../src/runtime/types";
import { SkillRegistry } from "../../src/skills/registry";
import { removeTempDir } from "./temp-dir";

/** An interactive CasperApp over a fake rich TTY in a temp project, with `until` on the (ANSI-free) screen. */
export async function richApp(makeRuntime: (project: string) => AgentRuntime, options: Partial<CasperAppOptions> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-rich-app-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "notes.txt"), "An empty folder would ask about a new project.\n");
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  let pending: { test: (output: string) => boolean; resolve: () => void } | undefined;
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 30, write(text: string) {
    output += text;
    if (pending?.test(Bun.stripANSI(output))) { pending.resolve(); pending = undefined; }
  } });
  const screen = () => Bun.stripANSI(output);
  const until = (test: (screen: string) => boolean, ms = 4000) => {
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
  const interactive = app.runInteractive(project);
  return {
    app, input, project, home, interactive, screen, until,
    async close() { await app.close(); input.destroy(); await removeTempDir(root); },
  };
}
