import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { steerOrQueue, takeBackNewest } from "../src/app/during-work";
import { requestAsItStands } from "../src/app/steered-request";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeSession } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(removeTempDir)); });

/** A project whose check passes once `fixed` exists, and a runtime that takes lines typed during work. */
async function setup(respond: (prompt: string, app: CasperApp) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-steered-request-"));
  dirs.push(root);
  await mkdir(path.join(root, ".casper"));
  await mkdir(path.join(root, "home"));
  await writeFile(path.join(root, ".casper/project.yaml"), 'verify:\n  test: "test -f fixed"\nverification:\n  mode: auto\nrepair:\n  maxAttempts: 1\n');
  const prompts: string[] = [];
  const steered: string[] = [];
  let app!: CasperApp;
  const runtime: AgentRuntime = {
    async start(): Promise<RuntimeSession> {
      return {
        setTools() {},
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" as const }),
        async prompt(text) { prompts.push(text); await respond(text, app); },
        async steer(text) { steered.push(text); return true; },
        unsteer(newest) { return newest ? steered.splice(-1) : steered.splice(0); },
        async abort() {}, subscribe: () => () => {},
        getState: () => ({ cwd: root, isStreaming: false }),
      };
    },
    async dispose() {},
  };
  const homeDir = path.join(root, "home");
  app = new CasperApp({
    sessionHomeDir: homeDir, runtimeFactory: () => runtime,
    loadProjectContext: (project) => loadProjectContext(project, { homeDir }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir }),
    output: { write() {} },
  });
  return { root, app, prompts };
}

posixOnly("a line typed during the task reaches the repair round as a later instruction, after the original request", async () => {
  const { root, app, prompts } = await setup(async (prompt, app) => {
    if (prompts.length === 1) {
      await writeFile(path.join(app.activeWorkspaceRoot(), "parser.ts"), "export const parse = (text: string) => text;\n");
      await steerOrQueue(app, "also test the models and fix them");
    }
    if (prompt.startsWith("Casper verification repair")) await writeFile(path.join(app.activeWorkspaceRoot(), "fixed"), "");
  });
  try {
    const report = await app.runOnce("fix the parser", root);
    expect(report?.status).toBe("pass");
    const repair = prompts.find(prompt => prompt.startsWith("Casper verification repair"));
    expect(repair).toContain("Original request:\nfix the parser\n\nLater instructions the user typed during this task, oldest first:\n- also test the models and fix them");
  } finally { await app.close(); }
}, 60_000);

test("the request as it stands lists the lines sent during the task, oldest first; a line taken back is not one of them", async () => {
  const { root, app } = await setup(async () => {});
  try {
    expect(requestAsItStands(app, "build the page")).toBe("build the page");
    await app.start(root);
    (app as unknown as { session: RuntimeSession }).session = await app.ensureRuntime();
    await steerOrQueue(app, "use the brand colours");
    await steerOrQueue(app, "and a dark mode");
    expect(requestAsItStands(app, "build the page")).toBe("build the page\n\nLater instructions the user typed during this task, oldest first:\n- use the brand colours\n- and a dark mode");
    app.terminal.canTakeBack = () => true;
    expect(takeBackNewest(app)).toBe(true);
    expect(requestAsItStands(app, "build the page")).toBe("build the page\n\nLater instructions the user typed during this task, oldest first:\n- use the brand colours");
  } finally { await app.close(); }
});

test("the terminal guide says a line sent during the task is restated in repair, proof and acceptance rounds", async () => {
  const doc = (await readFile(new URL("../docs/TERMINAL_UX.md", import.meta.url), "utf8")).replace(/\s+/g, " ");
  expect(doc).toContain("A line sent to the AI stays part of the task: a repair, proof or acceptance round restates the request with it, "
    + "under `Later instructions the user typed during this task, oldest first:`, and a line taken back is left out.");
});
