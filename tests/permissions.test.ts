import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { updateFooter } from "../src/app/footer";
import { parsePermissions, permissionsScreen, permissionsSummary, type PermissionsView } from "../src/app/permissions";
import { canonicalLine } from "../src/tui/commands";
import { createSessionSandbox, runtimeShell, type SandboxHost } from "../src/app/sandbox";
import { sandboxHost } from "../src/app/wiring";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { SandboxStore } from "../src/sandbox/store";
import { SkillRegistry } from "../src/skills/registry";
import { fakeEngine } from "./support/sandbox-fakes";
import { duringTask } from "../src/tui/give-way";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

/**
 * /permissions: one screen of what Casper may do and how to be asked less; /permissions all (stop asking until you quit,
 * session only), /permissions ask, /permissions write <folder> and /permissions forget <folder>; and "Yes, always for this
 * folder" in the write box. Protected places never become allowable.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

async function dirs() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-permissions-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project"), app = path.join(home, "apps", "SomeApp");
  await mkdir(project, { recursive: true }); await mkdir(app, { recursive: true }); await mkdir(path.join(home, ".ssh"));
  await mkdir(path.join(project, ".casper"), { recursive: true });
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  return { base, home, project, app, context };
}

/** A sandbox host that records every question and answers from `answers`; `stop` is the /permissions all switch. */
function fakeHost(answers: Array<string | undefined>, stop: () => boolean = () => false) {
  const asked: string[] = [];
  const value: SandboxHost = {
    canAsk: () => true,
    pick: async (question) => { asked.push(question); return answers.shift(); },
    write: () => {}, planning: () => false, stopAsking: stop,
  };
  return { value, asked };
}

async function sandboxFor(d: Awaited<ReturnType<typeof dirs>>, terminal: SandboxHost) {
  const sandbox = createSessionSandbox(terminal, d.context, { root: () => d.project, home: d.home,
    seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux", tempDirs: [] } });
  const shell = runtimeShell(terminal, sandbox, new SandboxStore(d.context.stateDirectory));
  return { sandbox, shell };
}

test("Yes, always for this project: remembered for this project in ~/.casper, used by the next session, covering the folder and below", async () => {
  const d = await dirs();
  const first = fakeHost(["Yes, always for this project"]);
  const one = await sandboxFor(d, first.value);
  expect(await one.shell.outsideWrite!(path.join(d.app, "a.json"))).toBeUndefined();
  expect(first.asked).toHaveLength(1);
  const saved = JSON.parse(await readFile(path.join(d.context.stateDirectory, "sandbox.json"), "utf8")) as { writes?: string[] };
  expect(saved.writes).toEqual([d.app]);
  expect(await readdir(d.project)).not.toContain("sandbox.json");
  await one.sandbox.close();
  // A new session: no question for the folder or below, and /permissions lists it.
  const second = fakeHost([]);
  const two = await sandboxFor(d, second.value);
  await two.sandbox.loadRemembered();
  expect(two.sandbox.rememberedWriteFolders()).toEqual([d.app]);
  expect(await two.shell.outsideWrite!(path.join(d.app, "deep", "b.json"))).toBeUndefined();
  expect(second.asked).toEqual([]);
  // /permissions forget puts the question back.
  expect(await two.sandbox.forgetWrite(d.app)).toBe(true);
  expect(JSON.parse(await readFile(path.join(d.context.stateDirectory, "sandbox.json"), "utf8")).writes).toBeUndefined();
  second.value.pick = async (question) => { second.asked.push(question); return "No"; };
  expect(await two.shell.outsideWrite!(path.join(d.app, "c.json"))).toContain("Not done");
  expect(second.asked).toHaveLength(1);
  await two.sandbox.close();
});

test("/permissions write refuses protected places with the reason, and allows an ordinary folder ahead of time", async () => {
  const d = await dirs();
  const { sandbox } = await sandboxFor(d, fakeHost([]).value);
  for (const place of [path.join(d.home, ".ssh"), d.home, d.project, path.join(d.base, "missing")]) {
    const result = await sandbox.rememberWrite(place);
    expect([place, "refused" in result]).toEqual([place, true]);
  }
  expect(sandbox.rememberedWriteFolders()).toEqual([]);
  const ok = await sandbox.rememberWrite(d.app);
  expect(ok).toEqual({ folder: d.app });
  expect(sandbox.writeAllowed(path.join(d.app, "x.txt"))).toBe(true);
  await sandbox.close();
});

test("a remembered folder that now holds a protected place is left out when it loads, not widened into it", async () => {
  const d = await dirs();
  // Someone (or a change on disk) put the home folder, which holds ~/.ssh, in the saved list.
  await new SandboxStore(d.context.stateDirectory).addWrite(d.home);
  await new SandboxStore(d.context.stateDirectory).addWrite(d.app);
  const other = path.join(d.home, "apps", "Other");
  await mkdir(other);
  await new SandboxStore(d.context.stateDirectory).addWrite(other);
  const { sandbox } = await sandboxFor(d, fakeHost([]).value);
  await sandbox.loadRemembered();
  expect(sandbox.rememberedWriteFolders()).toEqual([d.app, other]);
  expect(sandbox.writeAllowed(path.join(d.home, ".ssh", "id_ed25519"))).toBe(false);
  await sandbox.close();
});

posixOnly("a link out of an allowed folder does not carry the allowance with it", async () => {
  const d = await dirs();
  const outside = path.join(d.base, "elsewhere");
  await mkdir(outside);
  await symlink(outside, path.join(d.app, "out"));
  const { sandbox } = await sandboxFor(d, fakeHost([]).value);
  await sandbox.rememberWrite(d.app);
  expect(sandbox.writeAllowed(path.join(d.app, "out", "x.txt"))).toBe(false);
  expect(sandbox.writeAllowed(path.join(d.app, "x.txt"))).toBe(true);
  await sandbox.close();
});

test("stopping asking answers the shell's own questions Yes for this session, but never a protected place", async () => {
  const d = await dirs();
  let stop = false;
  const terminal = fakeHost(["No", "No", "No"], () => stop);
  const { sandbox, shell } = await sandboxFor(d, terminal.value);
  // Off by default: the write box and the Reach box show.
  expect(await shell.outsideWrite!(path.join(d.app, "a.json"))).toContain("Not done");
  expect(terminal.asked.length).toBe(1);
  stop = true;
  const asked = terminal.asked.length;
  expect(await shell.outsideWrite!(path.join(d.app, "b.json"))).toBeUndefined();
  expect(await shell.approve!("ssh admin@192.0.2.10 uptime")).toBeUndefined();
  expect(terminal.asked.length).toBe(asked);
  // A private place is refused, not asked, whatever the switch says.
  expect(await shell.outsideWrite!(path.join(d.home, ".ssh", "authorized_keys"))).toContain("Not done");
  expect(terminal.asked.length).toBe(asked);
  await sandbox.close();
});

test("the switch is off at start, and the sandbox host ignores it where nobody can answer (one-shot, --json)", async () => {
  const d = await dirs();
  const app = new CasperApp({ runtimeFactory: () => { throw new Error("no model"); }, input: new PassThrough(), output: { write: () => {} }, sessionHomeDir: d.home });
  expect(app.stopAsking).toBe(false);
  app.stopAsking = true;
  expect(sandboxHost(app).stopAsking!()).toBe(false);
  await app.close();
});

test("only the person's typed command can set the switch: nothing the AI can call mentions it", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const root = path.join(import.meta.dir, "..", "src");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (file.endsWith(".ts") && readFileSync(file, "utf8").includes("stopAsking")) found.push(path.relative(root, file).split(path.sep).join("/"));
    }
  };
  walk(root);
  expect(found.sort()).toEqual(["app.ts", "app/commands.ts", "app/footer.ts", "app/sandbox.ts", "app/wiring.ts"]);
});

/** `typed`: each command runs as if typed while a task runs. */
async function session(d: Awaited<ReturnType<typeof dirs>>, commands: string[], answers: string[], typed = false) {
  const input = new PassThrough();
  let output = "";
  const pending = [...commands];
  const badges: Array<string | undefined> = [];
  const app = new CasperApp({
    runtimeFactory: () => { throw new Error("no model in this test"); }, input, sessionHomeDir: d.home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: d.home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: d.home }),
    output: { write: (text) => {
      output += text;
      if (text === "> ") queueMicrotask(() => { badges.push(undefined); input.write(`${pending.shift() ?? "/exit"}\n`); });
      if (/Type [\d, ]*\d or \d: $/.test(text)) queueMicrotask(() => input.write(`${answers.shift() ?? "1"}\n`));
    } },
  });
  const set = app.terminal.setBadge.bind(app.terminal);
  app.terminal.setBadge = (text?: string) => { badges.push(text); set(text); };
  try { await (typed ? duringTask(() => app.runInteractive(d.project)) : app.runInteractive(d.project)); } finally { await app.close(); }
  return { output, badges: badges.filter((badge) => badge !== undefined) as string[] };
}

test("/permissions is short: the state first, one line per kind, what stays protected, then the stop-asking box", async () => {
  const d = await dirs();
  const { output } = await session(d, ["/permissions"], []);
  const screen = output.slice(output.indexOf("Asking is on:"), output.indexOf("Stop asking until you quit?"));
  for (const line of ["Asking is on: Casper asks before", "  Shell: ", "  Other machines (ssh, scp): asks", "  Writes outside the project: asks · allowed: none · /permissions write <folder>",
    "  Network devices (MCP): writes off", "Protected whatever you pick: ~/.ssh, ~/.casper", "/permissions details shows everything"]) {
    expect(screen).toContain(line);
  }
  expect(screen.trim().split("\n").length).toBeLessThanOrEqual(12);
  expect(screen).not.toContain("To turn everything on");
  // The box follows, Keep asking first: Enter changes nothing, and the view says nothing more.
  expect(output).toContain("1 Keep asking");
  expect(output).toContain("Stop asking until you quit? → Keep asking");
  expect(output).not.toContain("[permissions] Still asking.");
});

test("the short screen's Network devices line says which servers have writes on and which say Yes to everything", () => {
  const view: PermissionsView = {
    shell: "", scripts: "", asking: true, sandboxOn: false, outsideWritesAsk: true, commandsSession: 0, commandsSaved: 0, listedHosts: 0, rememberedHosts: [], reachHosts: [],
    labDevices: 0, labAsks: undefined, checks: "ask", checksRemembered: false, writesForGood: [], writesSession: [], mcpWritesOn: [], mcpAllowAll: [],
    web: true, github: true, sshLogin: true, downloads: true, show: (folder) => folder,
  };
  expect(permissionsSummary(view)).toContain("  Network devices (MCP): writes off · each change asks · /mcp writes <server>");
  const on = permissionsSummary({ ...view, mcpWritesOn: ["central", "mist"], mcpAllowAll: ["central"] });
  expect(on).toContain("  Network devices (MCP): writes on: central, mist · Yes to everything: central; other changes ask · /mcp writes <server>");
  expect(on).not.toContain("writes off");
  expect(permissionsSummary({ ...view, mcpWritesOn: ["central"] })).toContain("writes on: central · each change asks");
});

test("/permissions details is the full screen: every fact and every way to be asked less, with no box", async () => {
  const d = await dirs();
  const { output } = await session(d, ["/permissions details"], []);
  for (const line of ["What Casper may do here, and how to change it. Asking is on.", "To stop being asked about one command: answer 3", "Writes outside the project: Casper asks (1 No · 2 Yes, this once · 3 Yes, for this session · 4 Yes, always for this project)",
    "/permissions write <folder>", "To turn everything on: there is no single switch, on purpose.", "Protected whatever you pick: ~/.ssh, ~/.casper", "/verify and /services may execute project scripts"]) {
    expect(output).toContain(line);
  }
  expect(output).not.toContain("Stop asking until you quit?");
});

test("answering 2 in the /permissions box stops asking, as /permissions all does", async () => {
  const d = await dirs();
  const { output, badges } = await session(d, ["/permissions", "/permissions"], ["2"]);
  expect(output).toContain("[permissions] Not asking until you quit");
  expect(output).toContain("Asking is OFF until you quit: shell commands, hosts, writes outside the project and other machines are answered Yes. /permissions ask turns it back on.");
  expect(output.match(/Stop asking until you quit\?\n/g)).toHaveLength(1);
  expect(badges.some((badge) => badge.includes("ASKING OFF · /permissions ask"))).toBe(true);
});

test("/permissions all asks 1 Keep asking · 2 Stop asking until I quit; 1 changes nothing, 2 turns it on with a marker, /permissions ask ends it", async () => {
  const d = await dirs();
  const kept = await session(d, ["/permissions all", "/permissions"], ["1"]);
  expect(kept.output).toContain("Stop asking until you quit?");
  expect(kept.output).toContain("1 Keep asking");
  expect(kept.output).toContain("[permissions] Still asking.");
  expect(kept.output).toContain("Asking is on:");
  expect(kept.badges.join("\n")).not.toContain("ASKING OFF");
  const on = await session(d, ["/permissions all", "/permissions", "/permissions ask", "/permissions"], ["2"]);
  expect(on.output).toContain("[permissions] Not asking until you quit");
  expect(on.output).toContain("Asking is OFF until you quit");
  expect(on.output).toContain("[permissions] Asking is on again.");
  expect(on.badges.some((badge) => badge.includes("ASKING OFF · /permissions ask"))).toBe(true);
  // It is memory only: a new session starts with asking on, and nothing was written.
  const again = await session(d, ["/permissions"], []);
  expect(again.output).toContain("Asking is on:");
  expect(await readdir(d.context.stateDirectory).catch(() => [])).not.toContain("permissions.json");
});

test("a run that cannot ask refuses /permissions all and points at --no-sandbox", async () => {
  const d = await dirs();
  const app = new CasperApp({ runtimeFactory: () => { throw new Error("no model"); }, input: new PassThrough(), output: { write: () => {} }, sessionHomeDir: d.home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: d.home }) });
  try {
    await expect(app.runOnce("/permissions all", d.project)).rejects.toThrow("/permissions all needs a terminal where you can answer. For one run, use --no-sandbox.");
    expect(app.stopAsking).toBe(false);
  } finally { await app.close(); }
});

test("the footer marker says asking is off and how to end it", async () => {
  const d = await dirs();
  const app = new CasperApp({ runtimeFactory: () => { throw new Error("no model"); }, input: new PassThrough(), output: { write: () => {} }, sessionHomeDir: d.home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: d.home }) });
  await app.start(d.project);
  const seen: Array<string | undefined> = [];
  app.terminal.setBadge = (text?: string) => { seen.push(text); };
  updateFooter(app);
  app.stopAsking = true;
  updateFooter(app);
  expect(seen).toEqual([undefined, "ASKING OFF · /permissions ask"]);
  await app.close();
});

test("asking off with the sandbox on: the Shell line says Yes until you quit too, not that other folders ask", () => {
  const view: PermissionsView = {
    shell: "", scripts: "", asking: false, sandboxOn: true, outsideWritesAsk: true, commandsSession: 0, commandsSaved: 0, listedHosts: 0, rememberedHosts: [], reachHosts: [],
    labDevices: 0, labAsks: undefined, checks: "ask", checksRemembered: false, writesForGood: [], writesSession: [], mcpWritesOn: [], mcpAllowAll: [],
    web: true, github: true, sshLogin: true, downloads: true, show: (folder) => folder,
  };
  const off = permissionsSummary(view);
  expect(off).toContain("  Shell: in the sandbox (the project, temp and caches; other folders and hosts: Yes until you quit)");
  expect(off).not.toContain("hosts ask)");
  expect(permissionsSummary({ ...view, asking: true })).toContain("other folders and hosts: asks)");
});

test("with --no-sandbox or sandbox: off, writes outside the project don't ask, and the short and full screens say so", () => {
  const view: PermissionsView = {
    shell: "", scripts: "", asking: true, sandboxOn: false, sandboxReason: "--no-sandbox", shellAsks: false, outsideWritesAsk: false, commandsSession: 0, commandsSaved: 0, listedHosts: 0,
    rememberedHosts: [], reachHosts: [], labDevices: 0, labAsks: undefined, checks: "ask", checksRemembered: false, writesForGood: [], writesSession: [], mcpWritesOn: [], mcpAllowAll: [],
    web: true, github: true, sshLogin: true, downloads: true, show: (folder) => folder,
  };
  const short = permissionsSummary(view);
  expect(short).toContain("Asking is on: Casper asks before other machines.");
  expect(short).toContain("  Writes outside the project: doesn't ask (no sandbox)");
  expect(short).not.toContain("Writes outside the project: asks");
  const full = permissionsScreen(view);
  expect(full).toContain("Writes outside the project: with the sandbox off they don't ask.");
  expect(full).not.toContain("Writes outside the project: Casper asks");
  // Where writes do ask (Windows, no sandbox but the file tools still ask), the line lists them.
  expect(permissionsSummary({ ...view, shellAsks: true, outsideWritesAsk: true })).toContain("Asking is on: Casper asks before shell commands, writes outside the project and other machines.");
});

test("/permissions allow <folder> suggests write <folder>, and write and forget are any case", () => {
  for (const typed of ["allow ~/apps/x", "Allow ~/apps/x", "allowall ~/apps/x", "allow-all ~/apps/x", "all ~/apps/x"]) {
    expect(() => parsePermissions(`/permissions ${typed}`)).toThrow("Did you mean /permissions write ~/apps/x?");
  }
  expect(() => parsePermissions("/permissions allow ~/apps/x")).not.toThrow("/permissions all (it asks first)");
  expect(parsePermissions("/permissions Write ~/apps/SomeApp")).toEqual({ kind: "write", folder: "~/apps/SomeApp" });
  expect(parsePermissions("/permissions FORGET ~/apps/SomeApp")).toEqual({ kind: "forget", folder: "~/apps/SomeApp" });
});

test("the typed words parse, and anything else gets the usage line", () => {
  expect(parsePermissions("/permissions")).toEqual({ kind: "show" });
  expect(parsePermissions("/permissions details")).toEqual({ kind: "details" });
  expect(parsePermissions("/permissions all")).toEqual({ kind: "all" });
  expect(parsePermissions("/permissions ask")).toEqual({ kind: "ask" });
  expect(parsePermissions("/permissions write ~/apps/SomeApp")).toEqual({ kind: "write", folder: "~/apps/SomeApp" });
  expect(parsePermissions('/permissions forget "my folder"')).toEqual({ kind: "forget", folder: "my folder" });
  expect(() => parsePermissions("/permissions bogus")).toThrow("Usage: /permissions [details] | /permissions all|ask | /permissions write|forget <folder>");
  expect(() => parsePermissions("/permissions bogus")).not.toThrow("Did you mean");
});

test("allowall and allow-all are /permissions all, which still asks first; a near word is suggested, never run", () => {
  for (const typed of ["allowall", "allow-all", "AllowAll"]) expect(parsePermissions(`/permissions ${typed}`)).toEqual({ kind: "all" });
  expect(canonicalLine("/permissions allowall")).toBe("/permissions all");
  for (const typed of ["allo", "al", "yolo", "everything", "allow", "stop"]) {
    expect(() => parsePermissions(`/permissions ${typed}`)).toThrow("Usage: /permissions [details] | /permissions all|ask | /permissions write|forget <folder>. Did you mean /permissions all (it asks first)?");
  }
  expect(() => parsePermissions("/permissions aks")).toThrow("Did you mean /permissions ask?");
  expect(() => parsePermissions("/permissions detail")).toThrow("Did you mean /permissions details?");
  expect(() => parsePermissions("/permissions forgot ~/x")).toThrow("Did you mean /permissions forget?");
});

test("a typo in a session prints the suggestion and changes nothing", async () => {
  const d = await dirs();
  const { output, badges } = await session(d, ["/permissions allo", "/permissions details"], []);
  expect(output).toContain("[error] Usage: /permissions [details]");
  expect(output).toContain("Did you mean /permissions all (it asks first)?");
  expect(output).not.toContain("[permissions] Not asking");
  expect(output).toContain("Asking is on.");
  expect(badges.join("\n")).not.toContain("ASKING OFF");
});

test("/permissions write and forget say what happened in plain words, in a session", async () => {
  const d = await dirs();
  const { output } = await session(d, [`/permissions write ${d.app}`, `/permissions write ${path.join(d.home, ".ssh")}`, `/permissions forget ${d.app}`, `/permissions forget ${d.app}`], []);
  expect(output).toContain("Allowed: the AI's edits and shell commands may write");
  expect(output).toContain("never in the repo");
  expect(output).toContain("is protected on purpose");
  expect(output).toContain("Forgot");
  expect(output).toContain("was not allowed. /permissions shows what is.");
  await writeFile(path.join(d.base, "unused"), "");
});

test("/permissions write and forget typed during a task say the running task has the change from its next question; a refusal doesn't", async () => {
  const d = await dirs();
  const { output } = await session(d, [`/permissions write ${d.app}`, `/permissions write ${path.join(d.home, ".ssh")}`, `/permissions forget ${d.app}`, `/permissions forget ${d.app}`], [], true);
  const note = " The running task too, from its next question.\n";
  expect(output).toMatch(/Allowed: the AI's edits[^\n]* takes it back\. The running task too, from its next question\.\n/);
  expect(output).toContain(`Forgot ${d.app}: Casper asks before writes there again.${note}`);
  expect(output.split(note)).toHaveLength(3);
  expect(output).toContain("was not allowed. /permissions shows what is.\n");
});
