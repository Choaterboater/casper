import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import { ShellSandbox } from "../src/sandbox/manager";

let root = "";
const previous = process.env.CASPER_PROFILE;
beforeEach(async () => { delete process.env.CASPER_PROFILE; root = await mkdtemp(path.join(os.tmpdir(), "casper-profile-trust-")); });
afterEach(async () => {
  if (previous === undefined) delete process.env.CASPER_PROFILE; else process.env.CASPER_PROFILE = previous;
  await rm(root, { recursive: true, force: true });
});
const home = () => path.join(root, "home");
const repo = () => path.join(root, "repo");
const write = (file: string, text: string) => Bun.write(file, text);

test("a profile a repository picks brings its rules and project-level settings, never your own settings", async () => {
  await write(path.join(home(), ".casper/config.yaml"), "profile: work\n");
  await write(path.join(home(), ".casper/profiles/work/config.yaml"), "web: off\nspend:\n  pauseAt: 5\nlab:\n  hosts: [192.0.2.10]\nsandbox:\n  allowedDomains: [internal.example]\n");
  await write(path.join(home(), ".casper/profiles/lab/config.yaml"), "sandbox: off\nshell:\n  keepEnv: [OPENROUTER_API_KEY]\nlab:\n  hosts: [10.0.0.0/8]\nweb:\n  provider: duckduckgo\nspend:\n  pauseAt: 500\nskills:\n  maxActive: 2\n");
  await write(path.join(home(), ".casper/profiles/lab/rules.md"), "lab rules");
  await write(path.join(repo(), ".casper/project.yaml"), "profile: lab\n");
  const config = await loadConfiguration({ homeDir: home(), projectRoot: repo() });
  // The pick itself, its rules and what a project may set anyway.
  expect({ profile: config.profileName, rules: config.profileRules, maxActive: config.skills.maxActive }).toEqual({ profile: "lab", rules: "lab rules", maxActive: 2 });
  // Your own settings stay those of your own profile.
  expect({ off: config.sandbox.user.off, domains: config.sandbox.user.allowedDomains, web: config.web.enabled, pauseAt: config.spend.pauseAt, lab: config.lab?.hosts, labProfile: config.labProfile })
    .toEqual({ off: undefined, domains: ["internal.example"], web: false, pauseAt: 5, lab: ["192.0.2.10"], labProfile: "work" });
  expect(config.sandbox.user.keepEnv).toBeUndefined();
  expect(config.warnings.join("\n")).toContain(".casper/project.yaml picked profile lab");
});

test("a repository that names a missing profile can't drop your own profile's settings", async () => {
  await write(path.join(home(), ".casper/config.yaml"), "profile: work\n");
  await write(path.join(home(), ".casper/profiles/work/config.yaml"), "web: off\nspend:\n  pauseAt: 5\n");
  await write(path.join(repo(), ".casper/project.yaml"), "profile: nope\n");
  const config = await loadConfiguration({ homeDir: home(), projectRoot: repo() });
  expect({ web: config.web.enabled, pauseAt: config.spend.pauseAt }).toEqual({ web: false, pauseAt: 5 });
});

test("the profile you pick yourself still sets everything, and its sandbox: off is named as the reason", async () => {
  await write(path.join(home(), ".casper/config.yaml"), "profile: lab\n");
  await write(path.join(home(), ".casper/profiles/lab/config.yaml"), "sandbox: off\n");
  await write(path.join(repo(), ".casper/project.yaml"), "profile: lab\n");
  const config = await loadConfiguration({ homeDir: home(), projectRoot: repo() });
  expect(config.sandbox.user.off).toBe(true);
  expect(config.warnings.join("\n")).not.toContain("picked profile");
  expect(ShellSandbox.detect({ settings: config.sandbox })).toEqual({ kind: "off", reason: "sandbox: off in profile lab config.yaml" });
});
