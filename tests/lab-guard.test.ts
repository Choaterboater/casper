import { expect, test } from "bun:test";
import { guardLab, inventoryHostsFromJson, labRefusalText, NO_LAB_REASON } from "../src/network/lab";

const lab = { hosts: ["10.99.0.0/24", "fd00::/64", "lab-sw1", "10.50.0.9"] };

test("IP addresses match declared ranges exactly, IPv4 and IPv6", () => {
  expect(guardLab(["10.99.0.7"], lab)).toEqual({ ok: true });
  expect(guardLab(["fd00::1"], lab)).toEqual({ ok: true });
  expect(guardLab(["10.50.0.9"], lab)).toEqual({ ok: true });
  const refused = guardLab(["10.99.0.7", "10.98.0.7"], lab);
  expect(refused).toMatchObject({ ok: false, host: { name: "10.98.0.7" } });
  expect(guardLab(["fd01::1"], lab).ok).toBe(false);
  expect(guardLab(["10.50.0.10"], lab).ok).toBe(false);
});

test("hostnames match by exact, case-folded text; a name that merely contains 'lab' is not guessed", () => {
  expect(guardLab(["LAB-SW1"], lab)).toEqual({ ok: true });
  expect(guardLab(["lab-sw1."], lab)).toEqual({ ok: true });
  expect(guardLab(["lab-sw9"], lab).ok).toBe(false);
  expect(guardLab(["lab-sw1.example.net"], lab).ok).toBe(false);
});

test("a host with ansible_host is checked by the address Ansible connects to", () => {
  expect(guardLab([{ name: "lab-sw1", address: "10.1.2.3" }], lab)).toMatchObject({ ok: false, host: { address: "10.1.2.3" } });
  expect(guardLab([{ name: "anything", address: "10.99.0.20" }], lab)).toEqual({ ok: true });
});

test("no lab declared means not run with the 'tell Casper your lab first' reason", () => {
  expect(guardLab(["10.99.0.7"], undefined)).toEqual({ ok: false, reason: NO_LAB_REASON });
  expect(guardLab(["10.99.0.7"], { hosts: [] })).toEqual({ ok: false, reason: NO_LAB_REASON });
  expect(NO_LAB_REASON).toBe("tell Casper your lab first: add lab.hosts to ~/.casper/config.yaml");
  expect(guardLab([], lab)).toMatchObject({ ok: false, reason: "the inventory lists no hosts" });
});

test("the refusal names the first host outside the lab and says nothing was sent", () => {
  const guard = guardLab([{ name: "core-sw1", address: "10.1.2.3" }], lab);
  if (guard.ok) throw new Error("expected a refusal");
  expect(labRefusalText("junos-commit", guard)).toBe(
    "Refused: junos-commit would reach core-sw1 (10.1.2.3), which is not in your lab list (~/.casper/config.yaml lab.hosts). Nothing was sent.");
});

test("inventory JSON gives every host and its ansible_host; proxy and templated addresses are problems", () => {
  const listed = inventoryHostsFromJson(JSON.stringify({
    _meta: { hostvars: { "lab-sw1": { ansible_host: "10.99.0.5" }, "lab-sw2": {} } },
    all: { children: ["switches"] }, switches: { hosts: ["lab-sw1", "lab-sw2", "lab-sw3"] },
  }));
  expect(listed).toEqual({ hosts: [
    { name: "lab-sw1", address: "10.99.0.5" }, { name: "lab-sw2", address: "lab-sw2" }, { name: "lab-sw3", address: "lab-sw3" },
  ] });
  expect(inventoryHostsFromJson(JSON.stringify({ _meta: { hostvars: { r1: { ansible_ssh_common_args: "-o ProxyCommand=ssh jump" } } } })).problem)
    .toContain("ansible_ssh_common_args");
  expect(inventoryHostsFromJson(JSON.stringify({ _meta: { hostvars: { r1: { ansible_host: "{{ lookup('env','X') }}" } } } })).problem)
    .toContain("template");
});
