import { afterEach, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectAnsible, readPlaybook } from "../src/network/ansible";
import { networkFixture, writeProjectFile, type NetworkFixture } from "./support/network-fakes";

let fixture: NetworkFixture | undefined;
afterEach(async () => { await fixture?.cleanup(); fixture = undefined; });

const ARUBA_SITE = `- name: VLANs on the access switches
  hosts: access
  gather_facts: false
  tasks:
    - name: Make VLAN 20
      arubanetworks.aoscx.aoscx_vlan:
        vlan_id: 20
        name: users
`;

const JUNOS_RENDER = `- name: Render interfaces
  hosts: localhost
  gather_facts: false
  tasks:
    - name: Render
      junipernetworks.junos.junos_interfaces:
        config:
          - name: ge-0/0/1
            description: uplink
        state: rendered
      register: rendered
    - ansible.builtin.debug:
        var: rendered.rendered
`;

test("ansible.cfg plus a playbook using arubanetworks.aoscx gives aruba-syntax over that playbook", async () => {
  fixture = await networkFixture();
  await writeProjectFile(fixture, "ansible.cfg", "[defaults]\ninventory = inventory/\n");
  await writeProjectFile(fixture, "site.yml", ARUBA_SITE);
  const found = await detectAnsible(fixture.root);
  expect(found?.signals).toEqual(["ansible.cfg"]);
  expect(found?.frameworks).toEqual(["aoscx"]);
  expect(found?.checks).toEqual({ "aruba-syntax": { kind: "offline", preset: "ansible-syntax", playbooks: ["site.yml"], after: "each-change" } });
});

test("YAML without hosts: is not a playbook, and a project with no Ansible gives nothing", async () => {
  fixture = await networkFixture();
  await writeProjectFile(fixture, "config.yml", "- name: not a play\n  value: 1\n");
  await writeProjectFile(fixture, "vars.yml", "vlans: [10, 20]\n");
  expect(await detectAnsible(fixture.root)).toBeUndefined();
});

test("a playbook linked from outside the project is never read", async () => {
  fixture = await networkFixture();
  const outside = path.join(path.dirname(fixture.root), "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "site.yml"), ARUBA_SITE);
  await symlink(path.join(outside, "site.yml"), path.join(fixture.root, "site.yml"));
  await symlink(outside, path.join(fixture.root, "linked"));
  expect(await detectAnsible(fixture.root)).toBeUndefined();
});

test("a render-only Junos playbook gives junos-render, and a normal Junos playbook gives junos-syntax", async () => {
  fixture = await networkFixture();
  await writeProjectFile(fixture, "checks/render.yml", JUNOS_RENDER);
  await writeProjectFile(fixture, "deploy.yml", JUNOS_RENDER.replace("hosts: localhost", "hosts: routers").replace("state: rendered", "state: merged"));
  const found = await detectAnsible(fixture.root);
  expect(found?.frameworks).toEqual(["junos"]);
  expect(found?.checks["junos-render"]).toEqual({ kind: "offline", preset: "ansible-render", playbooks: ["checks/render.yml"], after: "each-change" });
  expect(found?.checks["junos-syntax"]?.playbooks).toEqual(["deploy.yml"]);
});

test("a render playbook stops being render-only when a task changes devices, runs a command or targets a group", () => {
  expect(readPlaybook("r.yml", JUNOS_RENDER)?.renderOnly).toBe(true);
  expect(readPlaybook("r.yml", JUNOS_RENDER.replace("state: rendered", "state: merged"))?.renderProblem).toContain("is not state: rendered");
  expect(readPlaybook("r.yml", `${JUNOS_RENDER}    - ansible.builtin.shell: echo hi\n`)?.renderProblem).toContain("is not a render step");
  expect(readPlaybook("r.yml", JUNOS_RENDER.replace("hosts: localhost", "hosts: routers"))?.renderProblem).toContain("targets routers");
  expect(readPlaybook("r.yml", JUNOS_RENDER.replace("register: rendered", "delegate_to: core1"))?.renderProblem).toContain("delegate_to");
});

test("delegate_to and add_host lines are found with their line numbers", () => {
  const info = readPlaybook("site.yml", `${ARUBA_SITE}      delegate_to: jump1\n    - add_host:\n        name: x\n`);
  expect(info?.reach).toEqual([{ what: "delegate_to", line: 9 }, { what: "add_host", line: 10 }]);
});

test("short module names count only when the play lists the collection", () => {
  const text = "- hosts: sw\n  collections: [arubanetworks.aoscx]\n  tasks:\n    - aoscx_vlan:\n        vlan_id: 3\n";
  expect(readPlaybook("s.yml", text)?.collections).toEqual(["arubanetworks.aoscx"]);
  expect(readPlaybook("s.yml", text.replace("  collections: [arubanetworks.aoscx]\n", ""))?.collections).toEqual([]);
});
