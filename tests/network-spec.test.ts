import { expect, test } from "bun:test";
import {
  LAB_IN_PROJECT_ERROR, autoNetworkCheckNames, mergeLabSettings, modelNetworkCheckNames, parseLabSettings, parseNetworkChecks,
} from "../src/network/spec";

const NAMES_ERROR = "names are 1-32 lowercase letters, digits or dashes and cannot be typecheck, lint, test or build";

test("a render check with a playbook parses as an offline check that runs after each change", () => {
  expect(parseNetworkChecks({ render: { preset: "ansible-render", playbooks: ["checks/render.yml"] } })).toEqual({
    render: { kind: "offline", preset: "ansible-render", playbooks: ["checks/render.yml"], after: "each-change" },
  });
});

test("bad names and the four built-in names are refused with the plain names message", () => {
  for (const name of ["Test", "lint", "build", "1abc", "a".repeat(33), "has_underscore"]) {
    expect(() => parseNetworkChecks({ [name]: { preset: "junoser", files: ["a.conf"] } })).toThrow(`verify.checks.${name}: ${NAMES_ERROR}`);
  }
  expect(Object.keys(parseNetworkChecks({ "aruba-syntax": { preset: "ansible-syntax", playbooks: "site.yml" } }))).toEqual(["aruba-syntax"]);
});

test("a lab check needs an inventory, and lab and report checks never take a free-form run command", () => {
  expect(() => parseNetworkChecks({ "aoscx-check": { preset: "ansible-check", playbooks: ["site.yml"] } }))
    .toThrow("verify.checks.aoscx-check: a lab check needs an inventory (inventory: path/to/lab.yml)");
  expect(() => parseNetworkChecks({ probe: { kind: "lab", run: "ansible all -m ping" } })).toThrow("never takes a free-form run command");
  expect(() => parseNetworkChecks({ diff: { preset: "hier-config", run: "true", platform: "aoscx", running: "r", intended: "i" } }))
    .toThrow("never takes a free-form run command");
});

test("lab and report kinds come from the preset, and only offline checks may be set to run after each change", () => {
  const checks = parseNetworkChecks({
    "aruba-syntax": { preset: "ansible-syntax", playbooks: ["site.yml"] },
    "manual": { preset: "junoser", files: ["configs/"], after: "ask" },
    "junos-commit": { preset: "junos-commit", inventory: "lab.yml", files: ["change.set"] },
    "aoscx-diff": { preset: "hier-config", platform: "aoscx", running: "running.cfg", intended: "intended.cfg" },
  });
  expect(checks["junos-commit"]!.kind).toBe("lab");
  expect(checks["aoscx-diff"]!.kind).toBe("report");
  expect(autoNetworkCheckNames(checks)).toEqual(["aruba-syntax"]);
  expect(modelNetworkCheckNames(checks)).toEqual(["aruba-syntax", "manual", "aoscx-diff"]);
  expect(() => parseNetworkChecks({ c: { preset: "junos-commit", inventory: "lab.yml", files: ["x.set"], after: "each-change" } }))
    .toThrow("lab checks never run on their own");
  expect(() => parseNetworkChecks({ c: { preset: "junos-commit", inventory: "lab.yml", files: ["x.set"], kind: "offline" } }))
    .toThrow("is a lab check");
});

test("paths must stay inside the project and settings must be known", () => {
  expect(() => parseNetworkChecks({ s: { preset: "ansible-syntax", playbooks: ["../other/site.yml"] } })).toThrow("expected a path inside the project");
  expect(() => parseNetworkChecks({ s: { preset: "ansible-syntax", playbooks: ["/etc/site.yml"] } })).toThrow("expected a path inside the project");
  expect(() => parseNetworkChecks({ s: { preset: "ansible-syntax", playbooks: ["site.yml"], shell: true } })).toThrow("verify.checks.s.shell: unknown setting");
  expect(() => parseNetworkChecks({ s: { preset: "ping-sweep" } })).toThrow("expected one of");
  const many = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`c${index}`, "true"]));
  expect(() => parseNetworkChecks(many)).toThrow("at most 16 named checks");
});

test("lab in .casper/project.yaml is refused; lab in your own settings loads exact names and ranges", () => {
  expect(() => parseLabSettings({ hosts: ["10.99.0.0/24"] }, "project")).toThrow(LAB_IN_PROJECT_ERROR);
  expect(LAB_IN_PROJECT_ERROR).toBe("lab is your setting, not the project's: move it from .casper/project.yaml to ~/.casper/config.yaml");
  expect(parseLabSettings({ hosts: ["LAB-SW1", "10.99.0.0/24", "fd00::/64", "10.98.1.1"] }, "user"))
    .toEqual({ hosts: ["lab-sw1", "10.99.0.0/24", "fd00::/64", "10.98.1.1"] });
  expect(() => parseLabSettings({ hosts: ["lab-*"] }, "user")).toThrow("write exact names, no wildcards");
  expect(() => parseLabSettings({ hosts: ["10.0.0.0/33"] }, "user")).toThrow("is not an IP range");
  expect(() => parseLabSettings({ hosts: "lab-sw1" }, "profile")).toThrow("lab.hosts: expected a list");
  expect(parseLabSettings(undefined, "project")).toBeUndefined();
});

test("a profile's lab list replaces the user file's list instead of adding to it", () => {
  expect(mergeLabSettings({ hosts: ["lab-a"] }, { hosts: ["lab-b"] })).toEqual({ hosts: ["lab-b"] });
  expect(mergeLabSettings({ hosts: ["lab-a"] }, undefined)).toEqual({ hosts: ["lab-a"] });
});
