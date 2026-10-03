import { expect, test } from "bun:test";
import { inventoryHostsFromJson, notLabHosts } from "../src/network/lab";

const lab = { hosts: ["10.99.0.0/24", "fd00::/64", "lab-sw1", "10.50.0.9"] };

// The lab list only labels devices ("Not marked lab: …" in the box); any device may be checked.
const off = (hosts: Parameters<typeof notLabHosts>[0], settings = lab) => notLabHosts(hosts, settings).map((host) => host.address);
const h = (address: string, name = address) => ({ name, address });

test("IP addresses match declared ranges exactly, IPv4 and IPv6", () => {
  expect(off([h("10.99.0.7"), h("fd00::1"), h("10.50.0.9")])).toEqual([]);
  expect(off([h("10.99.0.7"), h("10.98.0.7")])).toEqual(["10.98.0.7"]);
  expect(off([h("fd01::1"), h("10.50.0.10")])).toEqual(["fd01::1", "10.50.0.10"]);
});

test("hostnames match by exact, case-folded text; a name that merely contains 'lab' is not guessed", () => {
  expect(off([h("LAB-SW1"), h("lab-sw1.")])).toEqual([]);
  expect(off([h("lab-sw9"), h("lab-sw1.example.net")])).toEqual(["lab-sw9", "lab-sw1.example.net"]);
});

test("a host with ansible_host is matched by the address Ansible connects to", () => {
  expect(off([h("10.1.2.3", "lab-sw1")])).toEqual(["10.1.2.3"]);
  expect(off([h("10.99.0.20", "anything")])).toEqual([]);
});

test("with no lab list, no device is marked lab", () => {
  expect(notLabHosts([h("10.99.0.7")], undefined).map((host) => host.address)).toEqual(["10.99.0.7"]);
  expect(off([h("10.99.0.7")], { hosts: [] })).toEqual(["10.99.0.7"]);
});

test("inventory JSON gives every host and its ansible_host; a proxy is a warning, a templated address a problem", () => {
  const listed = inventoryHostsFromJson(JSON.stringify({
    _meta: { hostvars: { "lab-sw1": { ansible_host: "10.99.0.5" }, "lab-sw2": {} } },
    all: { children: ["switches"] }, switches: { hosts: ["lab-sw1", "lab-sw2", "lab-sw3"] },
  }));
  expect(listed).toMatchObject({ hosts: [
    { name: "lab-sw1", address: "10.99.0.5" }, { name: "lab-sw2", address: "lab-sw2" }, { name: "lab-sw3", address: "lab-sw3" },
  ] });
  const proxied = inventoryHostsFromJson(JSON.stringify({ _meta: { hostvars: { r1: { ansible_ssh_common_args: "-o ProxyCommand=ssh jump" } } } }));
  expect(proxied.problem).toBeUndefined();
  expect(proxied.warnings).toEqual(["Host r1 sets ansible_ssh_common_args, so the connection can go through another machine."]);
  expect(inventoryHostsFromJson(JSON.stringify({ _meta: { hostvars: { r1: { ansible_host: "{{ lookup('env','X') }}" } } } })).problem)
    .toContain("template");
});
