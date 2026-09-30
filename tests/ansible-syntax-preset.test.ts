import { afterEach, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  collectionReason, formatNetworkCheckLine, missingCollection, repairClass, runNetworkCheck, VAULT_REASON, WINDOWS_REASON,
} from "../src/network/checks";
import type { NetworkCheckSpec } from "../src/network/spec";
import { fakeTool, networkFixture, RECORD_CALL, writeProjectFile, type NetworkFixture } from "./support/network-fakes";

let fixture: NetworkFixture | undefined;
afterEach(async () => { await fixture?.cleanup(); fixture = undefined; delete process.env.OPENROUTER_API_KEY; delete process.env.ANSIBLE_VAULT_PASSWORD_FILE; });

const SITE = "- hosts: access\n  tasks:\n    - arubanetworks.aoscx.aoscx_vlan:\n        vlan_id: 20\n";
const syntax: NetworkCheckSpec = { kind: "offline", preset: "ansible-syntax", playbooks: ["site.yml"], after: "each-change" };

async function setup(body: string) {
  fixture = await networkFixture();
  await writeProjectFile(fixture, "site.yml", SITE);
  await writeProjectFile(fixture, "ansible.cfg", "[defaults]\nvault_password_file = ./vault-pass.sh\ninventory = ./dynamic.py\n");
  await fakeTool(fixture, "ansible-playbook", `${RECORD_CALL("ansible-playbook")}\n${body}`);
  return fixture;
}
const context = (f: NetworkFixture) => ({ root: f.root, path: f.path, tmpRoot: f.tmp, realHome: f.home });
const exists = (file: string) => stat(file).then(() => true, () => false);

test("syntax check runs ansible-playbook --syntax-check with -i localhost, and Casper's own ansible.cfg", async () => {
  const f = await setup("exit 0");
  process.env.OPENROUTER_API_KEY = "sk-or-should-not-leak";
  process.env.ANSIBLE_VAULT_PASSWORD_FILE = "/tmp/vault.sh";
  const result = await runNetworkCheck("aruba-syntax", syntax, context(f));
  expect(result.status).toBe("pass");
  const argv = (await readFile(path.join(f.records, "ansible-playbook.argv"), "utf8")).trim().split("\n");
  expect(argv.slice(0, 3)).toEqual(["--syntax-check", "-i", "localhost,"]);
  expect(argv[3]).toEndWith("site.yml");
  const env = await readFile(path.join(f.records, "ansible-playbook.env"), "utf8");
  const config = /^ANSIBLE_CONFIG=(.*)$/m.exec(env)?.[1];
  expect(config).toBeDefined();
  expect(config!.startsWith(f.root)).toBe(false);
  expect(env).not.toContain("sk-or-should-not-leak");
  expect(env).not.toContain("ANSIBLE_VAULT_PASSWORD_FILE");
  // Casper's config file is removed after the run.
  expect(await exists(config!)).toBe(false);
  expect(formatNetworkCheckLine(result)).toMatch(/^✓ aruba-syntax {2}ansible-playbook --syntax-check -i localhost, site\.yml {2}\(\d+\.\ds\)$/);
  expect(formatNetworkCheckLine(result)).not.toContain("offline");
});

test("Casper's ansible.cfg enables only static inventory plugins and has no vault password file", async () => {
  const f = await setup(`cp "$ANSIBLE_CONFIG" "$RECORDS/ansible.cfg"`);
  await runNetworkCheck("aruba-syntax", syntax, context(f));
  const config = await readFile(path.join(f.records, "ansible.cfg"), "utf8");
  expect(config).toContain("enable_plugins = host_list, yaml, ini");
  expect(config).not.toContain("vault");
  expect(config).toContain(path.join(f.home, ".ansible", "collections"));
});

test("a missing collection reads not run with the install line, and is never repairable", async () => {
  const f = await setup(`echo "ERROR! couldn't resolve module/action 'arubanetworks.aoscx.aoscx_vlan'. This often indicates a misspelling, missing collection, or incorrect module path." >&2; exit 4`);
  const result = await runNetworkCheck("aruba-syntax", syntax, context(f));
  expect(result).toMatchObject({ status: "skip", notRun: "collection", reason: collectionReason("arubanetworks.aoscx") });
  expect(formatNetworkCheckLine(result)).toBe("– aruba-syntax  not run: the Ansible collection arubanetworks.aoscx is not installed (ansible-galaxy collection install arubanetworks.aoscx)");
  expect(repairClass(result)).toBe("never");
});

test("a real syntax error stays a failure the model may fix; an unclear message is not turned into a skip", async () => {
  const f = await setup(`echo "ERROR! 'vlan_idd' is not a valid attribute for a Task" >&2; exit 4`);
  const result = await runNetworkCheck("aruba-syntax", syntax, context(f));
  expect(result.status).toBe("fail");
  expect(repairClass(result)).toBe("repairable");
  expect(missingCollection("couldn't resolve module/action 'aoscx_vlan'")).toBeUndefined();
});

test("real ansible-core messages: 2.19 [ERROR] lines and the older ERROR! lines both read as a missing collection", () => {
  // ansible-core 2.19.13, captured with an empty ansible.cfg:
  expect(missingCollection("[WARNING]: Error loading plugin 'arubanetworks.aoscx.aoscx_vlan': No module named 'ansible_collections.arubanetworks'\n"
    + "[ERROR]: couldn't resolve module/action 'arubanetworks.aoscx.aoscx_vlan'. This often indicates a misspelling, missing collection, or incorrect module path."))
    .toBe("arubanetworks.aoscx");
  // ansible-core 2.16 wording:
  expect(missingCollection("ERROR! couldn't resolve module/action 'junipernetworks.junos.junos_interfaces'. This often indicates a misspelling, missing collection, or incorrect module path."))
    .toBe("junipernetworks.junos");
  expect(missingCollection("ERROR! the role 'juniper.device.facts' was not found in /x/roles")).toBe("juniper.device");
  expect(missingCollection("[ERROR]: conflicting action statements: ansible.builtin.debug, bogus_kw")).toBeUndefined();
});

test("a playbook that needs a vault password reads not run; Casper does not run vault scripts", async () => {
  const f = await setup(`echo "ERROR! Attempting to decrypt but no vault secrets found" >&2; exit 1`);
  const result = await runNetworkCheck("aruba-syntax", syntax, context(f));
  expect(result).toMatchObject({ status: "skip", notRun: "vault", reason: VAULT_REASON });
});

test("a file name like $(touch pwned).yml is passed as one argument and never run by a shell", async () => {
  const f = await setup("exit 0");
  await writeProjectFile(f, "$(touch pwned).yml", SITE);
  const result = await runNetworkCheck("aruba-syntax", { ...syntax, playbooks: ["$(touch pwned).yml"] }, context(f));
  expect(result.status).toBe("pass");
  expect(await exists(path.join(f.root, "pwned"))).toBe(false);
  expect(await exists(path.join(f.tmp, "pwned"))).toBe(false);
  expect((await readFile(path.join(f.records, "ansible-playbook.argv"), "utf8"))).toContain("$(touch pwned).yml");
});

test("without ansible-playbook on PATH the check is not run (not installed), not failed", async () => {
  fixture = await networkFixture();
  await writeProjectFile(fixture, "site.yml", SITE);
  const result = await runNetworkCheck("aruba-syntax", syntax, { ...context(fixture), path: fixture.bin });
  expect(result).toMatchObject({ status: "skip", notRun: "tool" });
  expect(result.reason).toContain("not installed");
});

test("on Windows the Ansible presets read not run with the WSL hint", async () => {
  const f = await setup("exit 0");
  const result = await runNetworkCheck("aruba-syntax", syntax, { ...context(f), platform: "win32" });
  expect(result).toMatchObject({ status: "skip", reason: WINDOWS_REASON, notRun: "platform" });
  expect(formatNetworkCheckLine(result)).toBe("– aruba-syntax  not run: Ansible does not run on Windows; use WSL");
  expect(await exists(path.join(f.records, "ansible-playbook.ran"))).toBe(false);
});

test("a render check refuses a playbook that is not render-only without starting Ansible", async () => {
  const f = await setup("exit 0");
  await writeProjectFile(f, "render.yml", "- hosts: localhost\n  tasks:\n    - junipernetworks.junos.junos_interfaces:\n        config: []\n        state: merged\n");
  const result = await runNetworkCheck("junos-render", { kind: "offline", preset: "ansible-render", playbooks: ["render.yml"] }, context(f));
  expect(result).toMatchObject({ status: "skip", notRun: "input" });
  expect(result.reason).toContain("render.yml is not render-only");
  expect(await exists(path.join(f.records, "ansible-playbook.ran"))).toBe(false);
});

test("a render-only playbook runs with -i localhost, and no --syntax-check", async () => {
  const f = await setup("exit 0");
  await writeProjectFile(f, "render.yml", "- hosts: localhost\n  tasks:\n    - junipernetworks.junos.junos_interfaces:\n        config: []\n        state: rendered\n");
  const result = await runNetworkCheck("junos-render", { kind: "offline", preset: "ansible-render", playbooks: ["render.yml"] }, context(f));
  expect(result.status).toBe("pass");
  const argv = (await readFile(path.join(f.records, "ansible-playbook.argv"), "utf8")).trim().split("\n");
  expect(argv.slice(0, 2)).toEqual(["-i", "localhost,"]);
  expect(argv).not.toContain("--syntax-check");
});

test("a lab check asked through the offline runner is refused with the start-it-yourself text", async () => {
  const f = await setup("exit 0");
  const result = await runNetworkCheck("junos-commit", { kind: "lab", preset: "junos-commit", inventory: "lab.yml", files: ["c.set"] }, context(f));
  expect(result).toMatchObject({ status: "skip", reason: "Lab checks run only when you start them: /verify junos-commit" });
  expect(await exists(path.join(f.records, "ansible-playbook.ran"))).toBe(false);
});
