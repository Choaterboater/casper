import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import type { CasperEvent } from "../src/app/json-events";
import { rememberLabAlways } from "../src/network/lab";
import { prepareLabCheck } from "../src/network/checks";
import { loadProjectContext } from "../src/project/context";
import { projectStateDirectory } from "../src/project/model";
import { SkillRegistry } from "../src/skills/registry";
import type { AgentRuntime, RuntimeSession } from "../src/runtime/types";
import { fakeTool, networkFixture, RECORD_CALL, writeProjectFile, type NetworkFixture } from "./support/network-fakes";

setDefaultTimeout(30_000);

let fixture: NetworkFixture | undefined;
afterEach(async () => { await fixture?.cleanup(); fixture = undefined; });

const ARUBA_SITE = "- hosts: switches\n  gather_facts: false\n  tasks:\n    - arubanetworks.aoscx.aoscx_vlan:\n        vlan_id: 20\n";
const ran = (f: NetworkFixture, tool: string) => stat(path.join(f.records, `${tool}.ran`)).then(() => true, () => false);

interface App { app: CasperApp; output(): string; events: CasperEvent[]; prompts: string[] }

function makeApp(f: NetworkFixture, options: { input?: PassThrough; writer?: NodeJS.WritableStream } = {}): App {
  let text = "";
  const events: CasperEvent[] = [];
  const prompts: string[] = [];
  const runtime: AgentRuntime = {
    async start(start): Promise<RuntimeSession> {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: start.cwd, isStreaming: false }),
        setTools: () => {}, subscribe: () => () => {}, abort: async () => {},
        prompt: async (prompt) => { prompts.push(prompt); },
        complete: async () => ({ text: "", usage: null }),
      } as RuntimeSession;
    },
    async dispose() {},
  };
  const writer = options.writer ?? { write(chunk: string) { text += chunk; return true; } };
  const app = new CasperApp({
    runtimeFactory: () => runtime, sessionHomeDir: f.home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: f.home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: f.home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    networkTools: { path: f.path, tmpRoot: f.tmp, realHome: f.home },
    onEvent: (event) => { events.push(event); },
    ...(options.input ? { input: options.input } : {}),
    output: writer as never,
  });
  return { app, output: () => Bun.stripANSI(text), events, prompts };
}

async function ansibleProject(): Promise<NetworkFixture> {
  const f = await networkFixture();
  await writeProjectFile(f, "ansible.cfg", "[defaults]\ninventory = inventory/\n");
  await writeProjectFile(f, "site.yml", ARUBA_SITE);
  await fakeTool(f, "ansible-playbook", `${RECORD_CALL("ansible-playbook")}\necho "playbook: site.yml"`);
  return f;
}

test("Casper finds the Ansible check but never adds it: /status offers it, /verify add saves it, and then it runs", async () => {
  const f = fixture = await ansibleProject();
  const context = await loadProjectContext({ root: f.root, name: "project", isGit: false } as never, { homeDir: f.home });
  expect(context.model.languages).toContain("ansible");
  expect(context.model.frameworks).toContain("aoscx");
  expect(Object.keys(context.model.foundChecks ?? {})).toEqual(["aruba-syntax"]);
  expect(context.model.namedChecks).toBeUndefined();

  const first = makeApp(f);
  try {
    await first.app.runOnce("/status", f.root);
    expect(first.output()).toContain("found, not saved: aruba-syntax (/verify add <name> saves one)");
    await first.app.runOnce("/verify aruba-syntax", f.root);
    expect(first.output()).toContain("[verify] aruba-syntax is a check Casper found but you have not saved, so it does not run. /verify add aruba-syntax saves it in .casper/project.yaml.");
    expect(await ran(f, "ansible-playbook")).toBe(false);
    await first.app.runOnce("/verify add aruba-syntax", f.root);
    expect(first.output()).toContain("[project] Saved verify.checks.aruba-syntax: { preset: ansible-syntax, playbooks: [ site.yml ] } in .casper/project.yaml");
    await first.app.runOnce("/verify add aruba-syntax", f.root);
    expect(first.output()).toContain("[project] aruba-syntax is already saved in .casper/project.yaml; /verify aruba-syntax runs it.");
    expect(first.output()).not.toContain("is not a check Casper found here");
  } finally { await first.app.close(); }
  expect(await readFile(path.join(f.root, ".casper/project.yaml"), "utf8")).toContain("aruba-syntax:\n      preset: ansible-syntax");
  expect(await ran(f, "ansible-playbook")).toBe(false);

  const second = makeApp(f);
  try {
    await second.app.runOnce("/status", f.root);
    expect(second.output()).toContain("aruba-syntax — run after each change");
    expect(second.output()).not.toContain("found, not saved");
    await second.app.runOnce("/verify aruba-syntax", f.root);
    expect(second.output()).toContain("✓ aruba-syntax");
    const argv = (await readFile(path.join(f.records, "ansible-playbook.argv"), "utf8")).trim().split("\n");
    expect(argv).toContain("--syntax-check");
    expect(argv.slice(argv.indexOf("-i"), argv.indexOf("-i") + 2)).toEqual(["-i", "localhost,"]);
  } finally { await second.app.close(); }
});

async function labProject(hosts: Record<string, Record<string, unknown>>, check: "aoscx-check" | "junos-commit", playbookBody = "exit 0"): Promise<NetworkFixture> {
  const f = await networkFixture();
  await writeProjectFile(f, ".casper/project.yaml", [
    "verify:", "  checks:",
    "    aoscx-check:", "      preset: ansible-check", "      inventory: lab.yml", "      playbooks: [site.yml]",
    "    junos-commit:", "      preset: junos-commit", "      inventory: lab.yml", "      files: [change.set]", "",
  ].join("\n"));
  await mkdir(path.join(f.home, ".casper"), { recursive: true });
  await writeFile(path.join(f.home, ".casper", "config.yaml"), "lab:\n  hosts:\n    - 10.99.0.0/24\n");
  await writeProjectFile(f, "lab.yml", "all:\n  hosts: {}\n");
  await writeProjectFile(f, "site.yml", ARUBA_SITE);
  await writeProjectFile(f, "change.set", "set system host-name lab-r1\n");
  await writeFile(path.join(f.records, "inventory.json"), JSON.stringify({ _meta: { hostvars: hosts }, all: { children: ["lab"] }, lab: { hosts: Object.keys(hosts) } }));
  await fakeTool(f, "ansible-inventory", `${RECORD_CALL("ansible-inventory")}\ncat "$RECORDS/inventory.json"`);
  await fakeTool(f, "ansible-playbook", `${RECORD_CALL("ansible-playbook")}\n${playbookBody}`);
  void check;
  return f;
}

test("a device off the lab list is not refused: a run that can't ask sends nothing and says it needs your answer", async () => {
  const f = fixture = await labProject({ "lab-sw1": { ansible_host: "10.99.0.11" }, "core-sw1": { ansible_host: "10.1.2.3" } }, "aoscx-check");
  const { app, output, prompts } = makeApp(f);
  try {
    await app.runOnce("/status", f.root);
    expect(output()).toContain("lab: aoscx-check, junos-commit (device checks: Casper asks before each one)");
    await app.runOnce("/verify aoscx-check", f.root);
    expect(output()).not.toContain("Refused");
    expect(output()).toContain("aoscx-check · not run: lab checks need your answer at the terminal, and this run cannot ask; nothing was sent");
    expect(await ran(f, "ansible-playbook")).toBe(false);
    expect(prompts).toEqual([]);
  } finally { await app.close(); }
});

test("a run that cannot ask sends nothing to the lab and says so", async () => {
  const f = fixture = await labProject({ "lab-sw1": { ansible_host: "10.99.0.11" } }, "aoscx-check");
  const { app, output, events } = makeApp(f);
  try {
    await app.runOnce("/verify aoscx-check", f.root);
    expect(output()).toContain("aoscx-check · not run: lab checks need your answer at the terminal, and this run cannot ask; nothing was sent");
    expect(await ran(f, "ansible-playbook")).toBe(false);
    // The JSON check event keeps the lab fields even when nothing was sent.
    const check = events.find((event) => event.type === "check" && (event as { name?: string }).name === "aoscx-check");
    expect(check).toMatchObject({ kind: "lab", label: "dry run not guaranteed", hosts: ["lab-sw1"] });
  } finally { await app.close(); }
});

test("Always for this project lets junos-commit run without asking, and its check event carries kind, label and hosts", async () => {
  const f = fixture = await labProject({ "lab-r1": { ansible_host: "10.99.0.21" } }, "junos-commit");
  // The answer names the inventory and change file by their real paths (macOS's temp folder is /private/var).
  const root = await realpath(f.root);
  const state = projectStateDirectory(f.root, f.home);
  // The key binds the inventory, hosts, host variables and the change file's contents: take it from the plan itself.
  const plan = await prepareLabCheck("junos-commit", { kind: "lab", preset: "junos-commit", inventory: "lab.yml", files: ["change.set"] },
    { root, path: f.path, tmpRoot: f.tmp, realHome: f.home, lab: { hosts: ["10.99.0.0/24"] } });
  if (plan.state !== "ready") throw new Error(`expected ready, got ${plan.state}`);
  await rememberLabAlways(state, "junos-commit", plan.approvalKey);
  const { app, output, events } = makeApp(f);
  try {
    await app.runOnce("/verify junos-commit", f.root);
    expect(output()).toContain("Running junos-commit on your lab (you chose Always for this project).");
    expect(output()).toContain("✓ junos-commit · commit check only; not committed");
    expect(await ran(f, "ansible-playbook")).toBe(true);
    const check = events.find((event) => event.type === "check" && (event as { name?: string }).name === "junos-commit");
    expect(check).toMatchObject({ kind: "lab", label: "commit check only; not committed", hosts: ["lab-r1"] });
  } finally { await app.close(); }
});

/** A plain terminal: typed lines, no ask panel. */
function plainTerminal(f: NetworkFixture) {
  // Piped input, as the exact-answer channel takes on the plain terminal (a cooked TTY with redirected output is refused).
  const input = new PassThrough();
  let text = "";
  let pending: { test: (visible: string) => boolean; resolve: () => void } | undefined;
  const writer = Object.assign(new EventEmitter(), { isTTY: false, columns: 200, rows: 40, write(chunk: string) {
    text += chunk;
    if (pending?.test(Bun.stripANSI(text))) { pending.resolve(); pending = undefined; }
    return true;
  } });
  const made = makeApp(f, { input, writer: writer as never });
  const visible = () => Bun.stripANSI(text);
  const until = (check: (visible: string) => boolean) => {
    if (check(visible())) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => reject(new Error(`Still waiting; the screen was:\n${visible().slice(-3000)}`)), 20_000);
    pending = { test: check, resolve: () => { clearTimeout(timer); resolve(); } };
    return promise;
  };
  return { ...made, input, visible, until };
}

test("on the plain terminal the AOS-CX lab check asks with no Always choice, runs on 2, and a failure asks Stop first", async () => {
  const f = fixture = await labProject({ "lab-sw1": { ansible_host: "10.99.0.11" } }, "aoscx-check", `echo "fatal: lab-sw1 unreachable" >&2; exit 2`);
  const t = plainTerminal(f);
  const running = t.app.runInteractive(f.root);
  try {
    await t.until((text) => text.endsWith("> "));
    t.input.write("/verify aoscx-check\n");
    await t.until((text) => text.includes("Type 1 or 2: "));
    expect(t.visible()).toContain("Run aoscx-check on 1 device? It uses ansible --check, and a dry run is not guaranteed: some modules can still change the switches. lab-sw1\n");
    expect(t.visible()).toContain("  1 Skip\n  2 Run it\n");
    expect(t.visible()).not.toContain("Always for this project");
    expect(await ran(f, "ansible-playbook")).toBe(false);
    t.input.write("2\n");
    await t.until((text) => text.includes("failed on the lab. Casper did not ask the model to fix it"));
    expect(await ran(f, "ansible-playbook")).toBe(true);
    expect(t.visible()).toContain("✗ aoscx-check · dry run not guaranteed ·");
    // The paid choice says it uses tokens before it is chosen.
    expect(t.visible()).toContain("  1 Stop · keep the files as they are; nothing more runs on the lab\n"
      + "  2 Ask the model to fix it · the model changes the files (uses tokens), then the check runs on the lab again\n");
    // Enter picks Stop: no repair prompt reaches the model.
    t.input.write("\n");
    await t.until((text) => text.includes("✗ Failed — aoscx-check failed"));
    expect(t.visible()).toContain("✗ aoscx-check failed on the lab (exit 2) — log above; Casper did not ask the model to fix it. /verify aoscx-check runs it again (asks first)");
    expect(t.prompts).toEqual([]);
    await t.until((text) => text.endsWith("> "));
  } finally {
    t.input.write("/exit\n");
    await running;
    await t.app.close();
    t.input.destroy();
  }
});

test("Skip at the lab ask sends nothing, and so does Enter", async () => {
  const f = fixture = await labProject({ "lab-sw1": { ansible_host: "10.99.0.11" } }, "aoscx-check");
  const t = plainTerminal(f);
  const running = t.app.runInteractive(f.root);
  try {
    await t.until((text) => text.endsWith("> "));
    t.input.write("/verify aoscx-check\n");
    await t.until((text) => text.includes("Type 1 or 2: "));
    // Enter picks 1, which is Skip: a stray Enter never reaches a device.
    t.input.write("\n");
    await t.until((text) => text.includes("aoscx-check · not run: you chose Skip; nothing was sent"));
    expect(await ran(f, "ansible-playbook")).toBe(false);
    await t.until((text) => text.endsWith("> "));
  } finally {
    t.input.write("/exit\n");
    await running;
    await t.app.close();
    t.input.destroy();
  }
});
