import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DRY_RUN_LABEL, labFailureAsk, numberedChoices, prepareLabCheck,
} from "../src/network/checks";
import { namedCheckFields } from "../src/app/json-events";
import { checksPassed, liveCheckLine } from "../src/task/result";
import { formatVerificationResult, repairClass, verificationStatus } from "../src/verify/evidence";
import { fromNetworkResult } from "../src/verify/registry";
import { labAlwaysAllowed, LAB_LIMIT_NOTE, rememberLabAlways } from "../src/network/lab";
import type { LabSettings, NetworkCheckSpec } from "../src/network/spec";
import { fakeTool, networkFixture, RECORD_CALL, writeProjectFile, type NetworkFixture } from "./support/network-fakes";

let fixture: NetworkFixture | undefined;
afterEach(async () => { await fixture?.cleanup(); fixture = undefined; });

const LAB: LabSettings = { hosts: ["10.99.0.0/24", "lab-sw3"] };
const SITE = "- hosts: switches\n  gather_facts: false\n  tasks:\n    - arubanetworks.aoscx.aoscx_vlan:\n        vlan_id: 20\n";
const aoscxCheck: NetworkCheckSpec = { kind: "lab", preset: "ansible-check", inventory: "lab.yml", playbooks: ["site.yml"] };
const junosCommit: NetworkCheckSpec = { kind: "lab", preset: "junos-commit", inventory: "lab.yml", files: ["change.set"] };

function inventoryJson(hosts: Record<string, Record<string, unknown>>) {
  return JSON.stringify({ _meta: { hostvars: hosts }, all: { children: ["switches"] }, switches: { hosts: Object.keys(hosts) } });
}

async function setup(hosts: Record<string, Record<string, unknown>>, playbookBody = "exit 0") {
  fixture = await networkFixture();
  await writeProjectFile(fixture, "lab.yml", "all:\n  hosts: {}\n");
  await writeProjectFile(fixture, "site.yml", SITE);
  await writeProjectFile(fixture, "change.set", "set system host-name lab-r1\n");
  await writeFile(path.join(fixture.records, "inventory.json"), inventoryJson(hosts));
  await fakeTool(fixture, "ansible-inventory", `${RECORD_CALL("ansible-inventory")}\ncat "$RECORDS/inventory.json"`);
  await fakeTool(fixture, "ansible-playbook", `${RECORD_CALL("ansible-playbook")}\ncp "$3" "$RECORDS/playbook-copy.yml" 2>/dev/null\n${playbookBody}`);
  return fixture;
}
const context = (f: NetworkFixture) => ({ root: f.root, path: f.path, tmpRoot: f.tmp, realHome: f.home, lab: LAB as LabSettings | undefined });
const ran = (f: NetworkFixture) => stat(path.join(f.records, "ansible-playbook.ran")).then(() => true, () => false);

test("any device may be checked: one not marked lab is named in the box, and nothing is started before your answer", async () => {
  const f = await setup({ "lab-sw1": { ansible_host: "10.99.0.11" }, "core-sw1": { ansible_host: "10.1.2.3" } });
  const plan = await prepareLabCheck("aoscx-check", aoscxCheck, context(f));
  expect(plan.state).toBe("ready");
  if (plan.state !== "ready") return;
  expect(plan.ask.text).toContain("core-sw1, lab-sw1");
  expect(plan.ask.warnings).toEqual(["Not marked lab: core-sw1 (10.1.2.3)."]);
  expect(numberedChoices(plan.ask.choices)).toBe("1 No · 2 Yes, this once");
  expect(await ran(f)).toBe(false);
  const argv = (await readFile(path.join(f.records, "ansible-inventory.argv"), "utf8")).trim().split("\n");
  expect(argv[0]).toBe("-i");
  expect(argv[1]).toEndWith("lab.yml");
  expect(argv[2]).toBe("--list");
});

test("an all-lab inventory gives a numbered ask with no Always choice for ansible --check, and the result is labelled", async () => {
  const f = await setup({ "lab-sw1": { ansible_host: "10.99.0.11" }, "lab-sw2": { ansible_host: "10.99.0.12" }, "lab-sw3": {} });
  const plan = await prepareLabCheck("aoscx-check", aoscxCheck, context(f));
  expect(plan.state).toBe("ready");
  if (plan.state !== "ready") return;
  expect(plan.allowAlways).toBe(false);
  expect(plan.ask.text).toBe("Run aoscx-check on 3 devices? It uses ansible --check, and a dry run is not guaranteed: some modules can still change the switches. lab-sw1, lab-sw2, lab-sw3");
  expect(plan.ask.warnings).toEqual([]);
  expect(numberedChoices(plan.ask.choices)).toBe("1 No · 2 Yes, this once");
  expect(plan.ask.note).toBe(LAB_LIMIT_NOTE);
  // Preparing asked nothing of the devices: only the inventory was read.
  expect(await ran(f)).toBe(false);
  const result = await plan.run();
  expect(result).toMatchObject({ status: "pass", kind: "lab", label: DRY_RUN_LABEL, hosts: ["lab-sw1", "lab-sw2", "lab-sw3"] });
  const argv = (await readFile(path.join(f.records, "ansible-playbook.argv"), "utf8")).trim().split("\n");
  expect(argv.slice(0, 3)).toEqual(["--check", "--diff", "-i"]);
  // What the user sees, the JSON fields, and the receipt: a dry-run pass is shown but never grounds for passed.
  const shown = fromNetworkResult(result);
  expect(liveCheckLine(shown)).toMatch(/^✓ aoscx-check · dry run not guaranteed(?: · \d+\.\ds)?$/);
  expect(formatVerificationResult(shown)).toStartWith("✓ aoscx-check  ansible --check on 3 switches  (dry run not guaranteed; ");
  expect(namedCheckFields(shown)).toEqual({ kind: "lab", label: DRY_RUN_LABEL, hosts: ["lab-sw1", "lab-sw2", "lab-sw3"] });
  expect(checksPassed({ status: verificationStatus([shown]), repairAttempts: 0, rounds: [[shown]], results: [shown] })).toBe(false);
});

test("a playbook with delegate_to is shown as a warning with its line; you decide, and nothing ran yet", async () => {
  const f = await setup({ "lab-sw1": { ansible_host: "10.99.0.11" } });
  await writeProjectFile(f, "site.yml", `${SITE}      delegate_to: jump1\n`);
  const plan = await prepareLabCheck("aoscx-check", aoscxCheck, context(f));
  expect(plan.state).toBe("ready");
  if (plan.state !== "ready") return;
  expect(plan.ask.warnings).toEqual(["site.yml uses delegate_to (line 6), so it can reach devices not listed here."]);
  expect(plan.allowAlways).toBe(false);
  expect(numberedChoices(plan.ask.choices)).toBe("1 No · 2 Yes, this once");
  expect(await ran(f)).toBe(false);
});

test("other ways to reach past the inventory are warnings too: included files, vars_files, roles and group_vars", async () => {
  const f = await setup({ "lab-sw1": { ansible_host: "10.99.0.11" } });
  await writeProjectFile(f, "tasks/more.yml", "- ansible.builtin.set_fact:\n    ansible_host: 10.1.2.3\n");
  await writeProjectFile(f, "site.yml", `${SITE}    - ansible.builtin.import_tasks: tasks/more.yml\n`);
  expect(await prepareLabCheck("aoscx-check", aoscxCheck, context(f))).toMatchObject({ state: "ready", ask: { warnings: expect.arrayContaining([expect.stringContaining("tasks/more.yml uses ansible_host (line 2)")]) } });

  await writeProjectFile(f, "vars/lab.yml", "proxy: \"-o ProxyCommand=ssh jump\"\n");
  await writeProjectFile(f, "site.yml", SITE.replace("  gather_facts: false\n", "  gather_facts: false\n  vars_files: [vars/lab.yml]\n"));
  expect(await prepareLabCheck("aoscx-check", aoscxCheck, context(f))).toMatchObject({ state: "ready", ask: { warnings: expect.arrayContaining([expect.stringContaining("vars/lab.yml uses an SSH proxy setting")]) } });

  await writeProjectFile(f, "site.yml", SITE.replace("  gather_facts: false\n", "  gather_facts: false\n  roles: [arubanetworks.aoscx.vlans]\n"));
  expect(await prepareLabCheck("aoscx-check", aoscxCheck, context(f))).toMatchObject({ state: "ready", ask: { warnings: expect.arrayContaining([expect.stringContaining("not in the project's roles/ folder")]) } });

  await writeProjectFile(f, "roles/vlans/tasks/main.yml", "- ansible.builtin.uri:\n    url: https://10.1.2.3/rest\n");
  await writeProjectFile(f, "site.yml", SITE.replace("  gather_facts: false\n", "  gather_facts: false\n  roles: [vlans]\n"));
  expect(await prepareLabCheck("aoscx-check", aoscxCheck, context(f))).toMatchObject({ state: "ready", ask: { warnings: expect.arrayContaining([expect.stringContaining("roles/vlans/tasks/main.yml uses")]) } });

  await writeProjectFile(f, "site.yml", SITE);
  await writeProjectFile(f, "group_vars/switches.yml", "ansible_host: 10.1.2.3\n");
  expect(await prepareLabCheck("aoscx-check", aoscxCheck, context(f))).toMatchObject({ state: "ready", ask: { warnings: expect.arrayContaining([expect.stringContaining("group_vars/switches.yml uses ansible_host")]) } });
  expect(await ran(f)).toBe(false);
});

test("an inventory that is a program, or a link out of the project, is refused and never run", async () => {
  const f = await setup({ "lab-sw1": { ansible_host: "10.99.0.11" } });
  await writeProjectFile(f, "lab.yml", "#!/bin/sh\necho '{}'\n", 0o755);
  const plan = await prepareLabCheck("aoscx-check", aoscxCheck, context(f));
  expect(plan).toMatchObject({ state: "refused", message: expect.stringContaining("is a program (it is executable)") });
  expect(await stat(path.join(f.records, "ansible-inventory.ran")).then(() => true, () => false)).toBe(false);

  const outside = path.join(path.dirname(f.root), "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "inv.yml"), "all: {}\n");
  await symlink(path.join(outside, "inv.yml"), path.join(f.root, "linked.yml"));
  expect(await prepareLabCheck("aoscx-check", { ...aoscxCheck, inventory: "linked.yml" }, context(f)))
    .toMatchObject({ state: "refused", message: expect.stringContaining("leads outside the project") });
});

test("a proxy (jump host) in the inventory's host variables is a warning", async () => {
  const f = await setup({ "lab-sw1": { ansible_host: "10.99.0.11", ansible_ssh_common_args: "-o ProxyJump=bastion" } });
  expect(await prepareLabCheck("aoscx-check", aoscxCheck, context(f)))
    .toMatchObject({ state: "ready", ask: { warnings: expect.arrayContaining([expect.stringContaining("ansible_ssh_common_args")]) } });
});

test("no lab list at all: the check still runs after your answer, and the box says no device is marked lab", async () => {
  const f = await setup({ "lab-sw1": { ansible_host: "10.99.0.11" } });
  const plan = await prepareLabCheck("junos-commit", junosCommit, { ...context(f), lab: undefined });
  expect(plan.state).toBe("ready");
  if (plan.state !== "ready") return;
  expect(plan.ask.warnings).toEqual(["Not marked lab: lab-sw1 (10.99.0.11)."]);
  expect(numberedChoices(plan.ask.choices)).toBe("1 No · 2 Yes, this once · 3 Yes, always for this project");
});

test("junos-commit asks with an Always choice and runs Juniper's config module with check on and commit off", async () => {
  const f = await setup({ "lab-r1": { ansible_host: "10.99.0.21" }, "lab-r2": { ansible_host: "10.99.0.22" } });
  const plan = await prepareLabCheck("junos-commit", junosCommit, context(f));
  expect(plan.state).toBe("ready");
  if (plan.state !== "ready") return;
  expect(plan.allowAlways).toBe(true);
  expect(plan.ask.text).toBe("Run junos-commit on 2 devices? It loads the change, runs commit check, then rolls back. lab-r1, lab-r2");
  expect(numberedChoices(plan.ask.choices)).toBe("1 No · 2 Yes, this once · 3 Yes, always for this project");
  const result = await plan.run();
  expect(result.status).toBe("pass");
  const argv = (await readFile(path.join(f.records, "ansible-playbook.argv"), "utf8")).trim().split("\n");
  expect(argv[0]).toBe("-i");
  expect(argv[3]).toBe("-e");
  expect(argv[4]).toStartWith("@");
  const playbook = await readFile(path.join(f.records, "playbook-copy.yml"), "utf8");
  expect(playbook).toContain("juniper.device.config:");
  expect(playbook).toContain("check: true");
  expect(playbook).toContain("commit: false");
});

test("Always for this project is remembered only for the same inventory, hosts and change file", async () => {
  const f = await setup({ "lab-r1": { ansible_host: "10.99.0.21" } });
  const state = path.join(f.home, ".casper", "projects", "p");
  const first = await prepareLabCheck("junos-commit", junosCommit, context(f));
  if (first.state !== "ready") throw new Error("expected ready");
  expect(await labAlwaysAllowed(state, "junos-commit", first.approvalKey)).toBe(false);
  await rememberLabAlways(state, "junos-commit", first.approvalKey);
  expect(await labAlwaysAllowed(state, "junos-commit", first.approvalKey)).toBe(true);
  expect((await stat(path.join(state, "lab-always.json"))).mode & 0o777).toBe(0o600);
  await writeFile(path.join(f.records, "inventory.json"), inventoryJson({ "lab-r1": { ansible_host: "10.99.0.21" }, "lab-r9": { ansible_host: "10.99.0.29" } }));
  const second = await prepareLabCheck("junos-commit", junosCommit, context(f));
  if (second.state !== "ready") throw new Error("expected ready");
  expect(await labAlwaysAllowed(state, "junos-commit", second.approvalKey)).toBe(false);
});

test("a failed lab check is never repaired on its own: the ask defaults to Stop", async () => {
  const f = await setup({ "lab-r1": { ansible_host: "10.99.0.21" } }, `echo "error: commit check failed" >&2; exit 2`);
  const plan = await prepareLabCheck("junos-commit", junosCommit, context(f));
  if (plan.state !== "ready") throw new Error("expected ready");
  const result = await plan.run();
  expect(result.status).toBe("fail");
  expect(repairClass(fromNetworkResult(result))).toBe("ask");
  const ask = labFailureAsk("junos-commit");
  expect(`${ask.text} ${numberedChoices(ask.choices)}`).toBe(
    "junos-commit failed on the lab. Casper did not ask the model to fix it, because each try touches lab devices. 1 Stop · 2 Ask the model to fix it");
  expect(ask.defaultChoice).toBe(1);
});

test("on Windows lab checks read not run", async () => {
  const f = await setup({ "lab-r1": { ansible_host: "10.99.0.21" } });
  const plan = await prepareLabCheck("junos-commit", junosCommit, { ...context(f), platform: "win32" });
  expect(plan).toMatchObject({ state: "not-run", result: { reason: "Ansible does not run on Windows; use WSL" } });
});

test("review: Always is voided by a changed change file or changed host variables", async () => {
  const f = await setup({ "lab-r1": { ansible_host: "10.99.0.21" } });
  const first = await prepareLabCheck("junos-commit", junosCommit, context(f));
  if (first.state !== "ready") throw new Error("expected ready");
  await writeProjectFile(f, "change.set", "set system host-name other\n");
  const edited = await prepareLabCheck("junos-commit", junosCommit, context(f));
  if (edited.state !== "ready") throw new Error("expected ready");
  expect(edited.approvalKey).not.toBe(first.approvalKey);
  await writeFile(path.join(f.records, "inventory.json"), inventoryJson({ "lab-r1": { ansible_host: "10.99.0.21", ansible_python_interpreter: "/tmp/x.sh" } }));
  const vars = await prepareLabCheck("junos-commit", junosCommit, context(f));
  if (vars.state !== "ready") throw new Error("expected ready");
  expect(vars.approvalKey).not.toBe(edited.approvalKey);
});

test("review: a saved Always runs your own /verify, but a check the AI asks for still shows the box, without Always", async () => {
  const { labCheckRunner } = await import("../src/app/lab-checks");
  const f = await setup({ "lab-r1": { ansible_host: "10.99.0.21" } });
  const state = path.join(f.home, ".casper", "projects", "p");
  const plan = await prepareLabCheck("junos-commit", junosCommit, context(f));
  if (plan.state !== "ready") throw new Error("expected ready");
  await rememberLabAlways(state, "junos-commit", plan.approvalKey);
  const shown: string[][] = [];
  const host = (answer: string | undefined) => ({
    canAsk: () => true, write: () => {}, stateDirectory: state, lab: LAB as LabSettings,
    network: { path: f.path, tmpRoot: f.tmp, realHome: f.home },
    pick: async (_question: string, options: { label: string }[]) => { shown.push(options.map((option) => option.label)); return answer; },
  });
  const ctx = { cwd: f.root, timeoutMs: 60_000 };
  // Yours: Always holds, no box.
  await labCheckRunner(host("No"), "user")("junos-commit", junosCommit, ctx);
  expect(shown).toEqual([]);
  expect(await ran(f)).toBe(true);
  // The AI's: the box, with no Always choice; No sends nothing more.
  const result = await labCheckRunner(host("No"), "ai")("junos-commit", junosCommit, ctx);
  expect(shown).toEqual([["No", "Yes, this once"]]);
  expect(result.status).toBe("skip");
  // And with nobody to ask, the AI's request sends nothing.
  const quiet = await labCheckRunner({ ...host("Yes, this once"), canAsk: () => false }, "ai")("junos-commit", junosCommit, ctx);
  expect(quiet.status).toBe("skip");
});

test("review: every reach finding is shown (up to 5, then +N more), includes are still followed, and check_mode: false and plugin folders count", async () => {
  const f = await setup({ "lab-sw1": { ansible_host: "10.99.0.11" } });
  await writeProjectFile(f, "tasks/more.yml", "- ansible.builtin.shell: reboot\n");
  await writeProjectFile(f, "site.yml", `${SITE}    - ansible.builtin.uri:\n        url: https://example.net\n    - ansible.builtin.import_tasks: tasks/more.yml\n    - arubanetworks.aoscx.aoscx_config:\n        save_when: always\n      check_mode: false\n`);
  await writeProjectFile(f, "library/mine.py", "print('local code')\n");
  const plan = await prepareLabCheck("aoscx-check", aoscxCheck, context(f));
  if (plan.state !== "ready") throw new Error(`expected ready, got ${plan.state}`);
  const text = plan.ask.warnings.join("\n");
  expect(text).toContain("a URL");
  expect(text).toContain("tasks/more.yml uses a command module");
  expect(text).toContain("check_mode: false");
  expect(text).toContain("library/");
});
