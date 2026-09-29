import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkEvent, receiptEvent } from "../src/app/json-events";
import { loadConfiguration } from "../src/config/load";
import { loadProjectContext } from "../src/project/context";
import type { ProjectModel } from "../src/project/model";
import { formatReceipt, liveCheckLine } from "../src/task/result";
import { argvText, runCommandCheck } from "../src/verify/command";
import { formatVerificationResult, repairClass, verificationStatus, type VerificationResult } from "../src/verify/evidence";
import { describeChecksPlan, manualChecks, planAutoChecks, selectedChecks } from "../src/verify/mode";
import { LAB_NOT_YET, type NamedCheckSpec } from "../src/verify/named";
import { defaultVerifyNames, VerifierRegistry } from "../src/verify/registry";
import { VerificationTask } from "../src/verify/task";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function project(config: string, userConfig?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-named-"));
  dirs.push(root);
  const homeDir = path.join(root, "home");
  await mkdir(path.join(root, ".casper"));
  await mkdir(path.join(homeDir, ".casper"), { recursive: true });
  await writeFile(path.join(root, ".casper/project.yaml"), config);
  if (userConfig !== undefined) await writeFile(path.join(homeDir, ".casper/config.yaml"), userConfig);
  return { root, homeDir };
}

function model(root: string, namedChecks: Record<string, NamedCheckSpec>, commands: ProjectModel["commands"] = {}): ProjectModel {
  return { schemaVersion: 1, project: { name: "p", root, git: false }, languages: [], frameworks: [], packageManager: null,
    commands, namedChecks, architecture: {}, conventions: [], detectedAt: "" };
}

const result = (fields: Partial<VerificationResult>): VerificationResult => ({ name: "x", status: "pass", cwd: "/", exitCode: 0, signal: null,
  stdout: "", stderr: "", truncated: false, durationMs: 5, ...fields });

describe("configuration", () => {
  test("verify.checks names checks next to verify.test, and the project model carries them", async () => {
    const { root, homeDir } = await project("verify:\n  test: echo t\n  checks:\n    aruba-syntax:\n      preset: ansible-syntax\n      playbooks: [site.yml]\n    docs: echo docs\n");
    const loaded = await loadConfiguration({ projectRoot: root, homeDir });
    expect(loaded.projectOverrides.commands).toEqual({ test: "echo t" });
    expect(Object.keys(loaded.projectOverrides.namedChecks ?? {})).toEqual(["aruba-syntax", "docs"]);
    const context = await loadProjectContext({ root, cwd: root, name: "p", gitBranch: null, isGit: false }, { homeDir });
    expect(context.model.namedChecks?.docs).toEqual({ kind: "offline", run: "echo docs", after: "each-change" });
  });

  test("a bad name says the rule in plain words", async () => {
    const { root, homeDir } = await project("verify:\n  checks:\n    Bad_Name: echo x\n");
    await expect(loadConfiguration({ projectRoot: root, homeDir })).rejects.toThrow("names are 1-32 lowercase letters, digits or dashes and cannot be typecheck, lint, test or build");
  });

  test("verification.checks may pick named checks, but not unknown or lab ones", async () => {
    const good = await project("verify:\n  checks:\n    docs: echo docs\nverification:\n  checks: [docs]\n");
    expect((await loadConfiguration({ projectRoot: good.root, homeDir: good.homeDir })).verification.checks).toEqual(["docs"]);
    const unknown = await project("verification:\n  checks: [nope]\n");
    await expect(loadConfiguration({ projectRoot: unknown.root, homeDir: unknown.homeDir })).rejects.toThrow("nope is not a check");
    const lab = await project("verify:\n  checks:\n    junos-commit:\n      preset: junos-commit\n      files: [change.set]\n      inventory: lab.yml\nverification:\n  checks: [junos-commit]\n");
    await expect(loadConfiguration({ projectRoot: lab.root, homeDir: lab.homeDir })).rejects.toThrow("lab checks run only when you start them");
  });

  test("your own config picks only built-in checks; a named check is picked in its project", async () => {
    const { root, homeDir } = await project("verify:\n  checks:\n    docs: echo docs\n", "verification:\n  checks: [test, docs]\n");
    await expect(loadConfiguration({ projectRoot: root, homeDir }))
      .rejects.toThrow("~/.casper/config.yaml: verification.checks can only pick typecheck, lint, test or build here; pick docs in that project's .casper/project.yaml");
    const builtins = await project("", "verification:\n  checks: [test]\n");
    expect((await loadConfiguration({ projectRoot: builtins.root, homeDir: builtins.homeDir })).verification.checks).toEqual(["test"]);
  });

  test("the lab list is the user's setting, never the project's", async () => {
    const user = await project("", "lab:\n  hosts: [lab-r1, 10.99.0.0/24]\n");
    expect((await loadConfiguration({ projectRoot: user.root, homeDir: user.homeDir })).lab).toEqual({ hosts: ["lab-r1", "10.99.0.0/24"] });
    const inProject = await project("lab:\n  hosts: [core-sw1]\n");
    await expect(loadConfiguration({ projectRoot: inProject.root, homeDir: inProject.homeDir }))
      .rejects.toThrow("lab is your setting, not the project's: move it from .casper/project.yaml to ~/.casper/config.yaml");
  });
});

describe("running named checks", () => {
  test("an argument list runs without a shell: a file name is only ever a file name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "casper-argv-"));
    dirs.push(root);
    const evil = "$(touch pwned)";
    const done = await runCommandCheck({ name: "files", argv: [process.execPath, "-e", "console.log(process.argv[2] ?? process.argv[1])", evil], cwd: root, timeoutMs: 10_000 });
    expect(done.status).toBe("pass");
    expect(done.stdout).toContain(evil);
    expect(done.command).toBe(argvText([process.execPath, "-e", "console.log(process.argv[2] ?? process.argv[1])", evil]));
    await expect(access(path.join(root, "pwned"))).rejects.toThrow();
  });

  test("the wrap hook sees how a check starts and can change it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "casper-wrap-"));
    dirs.push(root);
    const seen: unknown[] = [];
    const done = await runCommandCheck({ name: "test", command: "exit 3", cwd: root, timeoutMs: 10_000,
      wrap: (plan, context) => { seen.push({ ...plan, ...context }); return { file: "exit 0", args: [], shell: true }; } });
    expect(seen).toEqual([{ file: "exit 3", args: [], shell: true, cwd: root, name: "test" }]);
    expect(done).toMatchObject({ status: "pass", command: "exit 3" });
  });

  test("the registry runs named checks: run commands, presets through the runner, and lab checks not at all", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "casper-registry-"));
    dirs.push(root);
    const calls: string[] = [];
    const registry = VerifierRegistry.forProject(model(root, {
      docs: { kind: "offline", run: "echo named-docs", after: "each-change" },
      diff: { kind: "report", preset: "hier-config", platform: "junos", running: "r.cfg", intended: "i.cfg" },
      "junos-commit": { kind: "lab", preset: "junos-commit", files: ["c.set"], inventory: "lab.yml" },
    }, { test: "echo builtin" }), 10_000, undefined, {
      runPreset: async (name) => { calls.push(name); return result({ name, cwd: root, kind: "report", summary: "2 lines to change · 2 to undo" }); },
    });
    expect(registry.names()).toEqual(["typecheck", "lint", "test", "build", "docs", "diff", "junos-commit"]);
    expect(registry.modelNames()).not.toContain("junos-commit");
    const [docs, diff, lab] = await registry.run(["docs", "diff", "junos-commit"]);
    expect(docs).toMatchObject({ status: "pass", command: "echo named-docs" });
    expect(docs!.stdout).toContain("named-docs");
    expect(diff).toMatchObject({ kind: "report", summary: "2 lines to change · 2 to undo" });
    expect(lab).toMatchObject({ status: "skip", kind: "lab", reason: LAB_NOT_YET });
    expect(calls).toEqual(["diff"]);
    expect(defaultVerifyNames(model(root, { docs: { kind: "offline", run: "x" }, lab: { kind: "lab", preset: "junos-commit", inventory: "i" } })))
      .toEqual(["typecheck", "lint", "test", "build", "docs"]);
  });

  test("casper_check offers named checks, refuses lab checks and hides secrets in named output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "casper-tool-"));
    dirs.push(root);
    await writeFile(path.join(root, "switch.cfg"), "enable secret 0 hunter2secret\n");
    const registry = VerifierRegistry.forProject(model(root, {
      render: { kind: "offline", run: "cat switch.cfg", after: "each-change" },
      "junos-commit": { kind: "lab", preset: "junos-commit", files: ["c.set"], inventory: "lab.yml" },
    }), 10_000);
    const tool = new VerificationTask(registry, root).tool();
    expect((tool.inputSchema as { properties: { check: { enum: string[] } } }).properties.check.enum).toEqual(["typecheck", "lint", "test", "build", "render"]);
    expect(await tool.execute({ check: "junos-commit" })).toEqual({ text: "Lab checks run only when you start them: /verify junos-commit", isError: true });
    const ran = await tool.execute({ check: "render" });
    expect(ran.isError).toBe(false);
    expect(ran.text).toContain("enable secret 0 <secret hidden>");
    expect(ran.text).not.toContain("hunter2secret");
  });
});

describe("what a named check means for the run", () => {
  test("a report never makes a run pass, fail or incomplete, and is never repaired", () => {
    const pass = result({ name: "test" });
    const report = result({ name: "diff", status: "fail", kind: "report", reason: "hier_config failed" });
    expect(verificationStatus([pass, report])).toBe("pass");
    expect(repairClass(report)).toBe("never");
    expect(repairClass(result({ status: "fail" }))).toBe("repairable");
    expect(repairClass(result({ status: "fail", ended: "timeout" }))).toBe("ask");
    expect(repairClass(result({ status: "fail", kind: "lab" }))).toBe("ask");
    expect(repairClass(result({ status: "fail", repair: "never" }))).toBe("never");
    expect(formatVerificationResult(result({ name: "aoscx-diff", kind: "report", summary: "12 lines to change · 12 to undo" })))
      .toBe("• aoscx-diff  12 lines to change · 12 to undo (a diff, not a pass/fail check)");
  });

  test("the receipt and the live line say what a named check did in plain words", () => {
    const task = { execution: "completed" as const, changedPaths: ["site.yml"], verification: { status: "incomplete" as const, repairAttempts: 0, rounds: [], results: [
      result({ name: "test" }),
      result({ name: "junoser", status: "skip", command: "junoser -c a.set", reason: "junoser is not installed (gem install junoser)", repair: "never" }),
      result({ name: "aoscx-diff", kind: "report", summary: "3 lines to change · 3 to undo" }),
    ] } };
    const text = formatReceipt(task);
    expect(text).toContain("• Not verified — junoser not run: junoser is not installed (gem install junoser)");
    expect(text).toContain("• aoscx-diff  3 lines to change · 3 to undo (a diff, not a pass/fail check)");
    expect(liveCheckLine(task.verification.results[1]!)).toBe("– junoser · not run: junoser is not installed (gem install junoser)");
    expect(formatReceipt({ ...task, verification: { ...task.verification, results: [result({ name: "aruba-check", label: "dry run not guaranteed", command: "ansible-playbook --check" })] } }))
      .toContain("✓ aruba-check passed (dry run not guaranteed · ansible-playbook --check, 0.0s)");
  });

  test("JSON check events and receipt checks carry kind, label and hosts as extra fields", () => {
    const lab = result({ name: "aoscx-check", kind: "lab", label: "dry run not guaranteed", hosts: ["lab-sw1"] });
    expect(checkEvent(lab, "casper")).toMatchObject({ kind: "lab", label: "dry run not guaranteed", hosts: ["lab-sw1"] });
    expect(checkEvent(result({ name: "test" }), "casper")).not.toHaveProperty("kind");
    const receipt = receiptEvent(undefined, { execution: "completed", verification: { status: "pass", repairAttempts: 0, rounds: [], results: [lab] } }, 0);
    expect(receipt.checks[0]).toMatchObject({ name: "aoscx-check", kind: "lab", hosts: ["lab-sw1"] });
  });

  test("named checks that run after each change join the selection; the rest are listed for /verify", () => {
    const named: Record<string, NamedCheckSpec> = {
      syntax: { kind: "offline", run: "x", after: "each-change" },
      slow: { kind: "offline", run: "y", after: "ask" },
      diff: { kind: "report", preset: "hier-config" },
      lab: { kind: "lab", preset: "junos-commit", inventory: "i" },
    };
    expect(selectedChecks(undefined, { test: "t" }, named)).toEqual(["test", "syntax"]);
    expect(planAutoChecks({ commands: { test: "t" }, named, changedPaths: ["a"] }).run).toEqual(["test", "syntax"]);
    expect(describeChecksPlan({ mode: "auto", checks: ["test", "syntax"], manual: ["slow", "diff"] }))
      .toBe("test, syntax — run after each change · with /verify <name> only: slow, diff");
    expect(manualChecks(selectedChecks(undefined, { test: "t" }, named), named)).toEqual(["slow", "diff"]);
    // verification.checks leaves syntax out: it no longer runs after each change, so the banner says where it went.
    expect(manualChecks(selectedChecks(["test"], { test: "t" }, named), named)).toEqual(["syntax", "slow", "diff"]);
  });
});
