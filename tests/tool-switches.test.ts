import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assembleTaskTools, type TaskCapabilitySource } from "../src/app/capabilities";
import { runSettings, settingRows, type SettingsHost } from "../src/app/settings";
import { planPages } from "../src/app/task-tools";
import type { CasperApp } from "../src/app";
import { loadConfiguration } from "../src/config/load";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import type { RuntimeTool } from "../src/runtime/types";
import { removeTempDir } from "./support/temp-dir";

/** The AI's browser tool and its diagram tool: on by default, off in your own config, and no project file turns them back on. */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

async function folders() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-switches-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  return { home, project, config: path.join(home, ".casper", "config.yaml"), projectFile: path.join(project, ".casper", "project.yaml") };
}

const tool = (name: string): RuntimeTool => ({ name, description: name, inputSchema: { type: "object" }, execute: async () => ({ text: "" }) });

function source(overrides: Partial<TaskCapabilitySource> = {}): TaskCapabilitySource {
  return {
    broker: { prepare: async () => [] } as never, delegate: tool("delegate"), ask: tool("ask"),
    lsp: { status: () => [] } as never, confirmRename: async () => false, references: { tools: () => [] } as never,
    visualization: { providerNames: () => ["mermaid"] } as never, projectRoot: "/tmp/none",
    browserReady: false, browserInstalled: true, browser: () => { throw new Error("not started"); },
    services: { declared: false, live: false }, serviceTool: () => tool("service"),
    ...overrides,
  };
}

const names = async (task: string, overrides: Partial<TaskCapabilitySource> = {}) => (await assembleTaskTools(task, source(overrides))).map((entry) => entry.name);

test("browser off: the AI's browser tool is not offered, even for a web task, on a machine with Chrome, or once offered", async () => {
  expect(await names("fix the css layout at https://localhost:5173")).toContain("browser");
  expect(await names("fix the css layout at https://localhost:5173", { browserOff: true })).not.toContain("browser");
  expect(await names("fix the layout", { browserOff: true, browserReady: true, offered: new Set(["browser"]) })).not.toContain("browser");
});

test("diagrams off: the visualize tool is not offered, even with a diagram word or once offered", async () => {
  expect(await names("draw a diagram of the auth flow", { browserInstalled: false })).toContain("visualize");
  expect(await names("draw a diagram of the auth flow", { diagramOff: true })).not.toContain("visualize");
  expect(await names("map the topology", { diagramOff: true, offered: new Set(["visualize"]) })).not.toContain("visualize");
});

test("browser and diagrams load on by default, off from your config, and a project file can't turn them on", async () => {
  const { home, project, config, projectFile } = await folders();
  const load = () => loadConfiguration({ projectRoot: project, homeDir: home });
  const plain = await load();
  expect([plain.browser, plain.diagrams]).toEqual([undefined, undefined]);
  await writeFile(config, "browser: off\nvisualize: off\n");
  expect([(await load()).browser, (await load()).diagrams]).toEqual([false, false]);
  await writeFile(config, "browser: false\nvisualize:\n  enabled: false\n  providers: [mermaid]\n");
  const mapped = await load();
  expect([mapped.browser, mapped.diagrams, mapped.visualize.providers]).toEqual([false, false, ["mermaid"]]);
  // A project file can't turn either back on.
  await writeFile(projectFile, "browser: on\n");
  await expect(load()).rejects.toThrow("browser is a user setting");
  await writeFile(projectFile, "visualize:\n  enabled: true\n  providers: [mindmesh]\n");
  const project1 = await load();
  expect([project1.diagrams, project1.visualize.providers]).toEqual([false, ["mindmesh"]]);
  expect(project1.warnings.join("\n")).toContain("visualize on or off is your own setting");
  await writeFile(projectFile, "visualize: on\n");
  const project2 = await load();
  expect(project2.diagrams).toBe(false);
  expect(project2.warnings.join("\n")).toContain("visualize on or off is your own setting");
  // Nor can a profile the repository picks.
  await mkdir(path.join(home, ".casper", "profiles", "lab"), { recursive: true });
  await writeFile(path.join(home, ".casper", "profiles", "lab", "config.yaml"), "browser: on\nvisualize: on\n");
  await writeFile(projectFile, "profile: lab\n");
  const picked = await load();
  expect([picked.browser, picked.diagrams]).toEqual([false, false]);
  await writeFile(config, "browser: maybe\n");
  await expect(load()).rejects.toThrow("browser must be on or off");
});

test("browser off: the page check still runs for a web project (it is not the AI's browser)", async () => {
  const { home, project, config } = await folders();
  await writeFile(config, "browser: off\n");
  await writeFile(path.join(project, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, dependencies: { react: "18", vite: "5" } }));
  await writeFile(path.join(project, "bun.lock"), "");
  await mkdir(path.join(project, "node_modules")); await mkdir(path.join(project, "src"));
  await writeFile(path.join(project, "src", "App.tsx"), "export default function App() { return null; }\n");
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  expect(context.browser).toBe(false);
  const app = { activeWorkspaceRoot: () => project } as unknown as CasperApp;
  expect(await planPages(app, context, ["src/App.tsx"])).toMatchObject({ pages: { open: ["/"] } });
});

function fakeHost(home: string, project: string, answers: (string | undefined)[]): SettingsHost & { asked: string[]; text: () => string } {
  let text = "";
  const asked: string[] = [];
  let context: Awaited<ReturnType<typeof loadProjectContext>> | undefined;
  return {
    output: { write: (chunk: string) => { text += chunk; } }, homeDir: () => home, canAsk: true,
    context: async () => context ??= await loadProjectContext(await inspectProject(project), { homeDir: home }),
    reload: async () => { context = await loadProjectContext(await inspectProject(project), { homeDir: home }); },
    ask: async (question, options) => { asked.push(`${question}\n${options.map((option, index) => `${index + 1} ${option.label}`).join("\n")}`); return answers.shift(); },
    asked, text: () => text,
  };
}

test("/settings: Browser tool and Diagram tool rows; 1 keeps as is, a pick saves browser: false / visualize: false", async () => {
  const { home, project, config } = await folders();
  const host = fakeHost(home, project, ["Browser tool", "Keep it on", "Browser tool", "Turn it off", "Diagram tool", "Turn it off", "Done"]);
  await runSettings(host);
  expect(host.asked[1]!.split("\n").slice(1)).toEqual(["1 Keep it on", "2 Turn it off"]);
  expect(host.asked[1]).toContain("The AI's own browser");
  const saved = await readFile(config, "utf8");
  expect(saved).toContain("browser: false");
  expect(saved).toContain("visualize: false");
  const context = (await host.context())!;
  expect([context.browser, context.diagrams]).toEqual([false, false]);
  expect(settingRows(context).filter((row) => row.label === "Browser tool" || row.label === "Diagram tool").map((row) => row.value)).toEqual(["off", "off"]);
  expect(host.text()).toContain("[settings] Diagram tool: off. Saved in ~/.casper/config.yaml.\n");
});

test("/settings: Diagram tool off keeps the visualize providers you listed", async () => {
  const { home, project, config } = await folders();
  await writeFile(config, "visualize:\n  providers: [mermaid]\n");
  await runSettings(fakeHost(home, project, ["Diagram tool", "Turn it off", "Done"]));
  expect(await readFile(config, "utf8")).toBe("visualize:\n  providers: [ mermaid ]\n  enabled: false\n");
});

test("/settings first screen shows every row's state at a glance, within 80 columns", async () => {
  const { home, project, config } = await folders();
  await writeFile(config, "browser: off\n");
  const host = fakeHost(home, project, [undefined]);
  await runSettings(host);
  const first = host.asked[0]!;
  const context = (await host.context())!;
  for (const row of settingRows(context)) expect(first).toContain(`${row.label}: ${row.value}`);
  expect(first).toContain("Browser tool: off");
  const glance = first.slice(0, first.indexOf("\n1 Done"));
  for (const line of glance.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  expect(first).toContain("\n1 Done\n2 Web lookups\n");
});
