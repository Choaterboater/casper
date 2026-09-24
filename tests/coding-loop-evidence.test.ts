import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { observationInput, observationOutput } from "../src/runtime/observation";
import { formatTaskResult, taskExitCode } from "../src/task/result";
import { runCommandCheck } from "../src/verify/command";
import { VerifierRegistry } from "../src/verify/registry";
import { verifyAndRepair } from "../src/verify/repair-loop";
import { workspaceState } from "../src/verify/workspace-state";
import { formatVerificationReport, formatVerificationResult } from "../src/verify/evidence";
import { checkCommand } from "./support/check-command";
import { needsPosixModes, posixOnly, posixSymlinks } from "./support/platform";

const dirs: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-evidence-"));
  dirs.push(root);
  return root;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

posixSymlinks("artifact-only build success cannot improve when an unrelated symlink disables observation", async () => {
  for (const linked of [false, true]) {
    const root = await fixture();
    await writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, ".gitignore"), "dist/\n");
    if (linked) await symlink("/dev/null", path.join(root, "unrelated-link"));
    const registry = new VerifierRegistry();
    registry.register({ name: "build", run: () => runCommandCheck({ name: "build",
      command: checkCommand("mkdir:dist", "write:dist/output.js=built"), cwd: root, timeoutMs: 1000 }) });
    const report = await verifyAndRepair({ registry, checks: ["build"], cwd: root, request: "Build" });
    expect(report.results[0]?.exitCode).toBe(0);
    expect(report.status).toBe("pass"); // Command outcome, not certification of current inputs.
    expect(taskExitCode(report)).toBe(0);
  }
});

needsPosixModes("filesystem identity covers bytes, membership, permissions and ignored files", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".gitignore"), "ignored\n");
  const file = path.join(root, "ignored");
  await writeFile(file, "before");
  const scope = { inputs: ["."] };
  const before = (await workspaceState(root, scope)).fingerprint;
  expect(before).toBeString();
  expect((await workspaceState(root, scope)).fingerprint).toBe(before);
  await writeFile(file, "after!");
  const edited = (await workspaceState(root, scope)).fingerprint;
  expect(edited).toBeString(); expect(edited).not.toBe(before);
  await chmod(file, 0o600);
  const permission = (await workspaceState(root, scope)).fingerprint;
  expect(permission).toBeString(); expect(permission).not.toBe(edited);
  await mkdir(path.join(root, "added"));
  expect((await workspaceState(root, scope)).fingerprint).not.toBe(permission);
});

posixOnly("unsupported trees, FIFOs, limits and cancellation never supply reusable identity", async () => {
  const root = await fixture();
  const file = path.join(root, "entry");
  const scope = { inputs: ["."] };
  expect((await workspaceState(root)).reason).toContain("No input scope declared");
  await symlink("/dev/null", file);
  expect((await workspaceState(root, scope)).reason).toContain("symlink or special file");
  await rm(file);
  expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
  expect((await workspaceState(root, scope)).reason).toContain("symlink or special file");
  await rm(file);
  await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
  expect((await workspaceState(root, scope)).reason).toContain("exceeds 1 MiB");
  expect((await workspaceState(root, scope, AbortSignal.abort())).reason).toContain("cancelled");
  expect((await workspaceState(path.join(root, "absent"), scope)).reason).toContain("ENOENT");
});

test("repair retains regression coverage and reuses only an unchanged targeted passing check", async () => {
  const root = await fixture();
  const registry = new VerifierRegistry();
  const counts = { test: 0, build: 0 };
  for (const [name, command] of [["test", checkCommand("require:fixed")], ["build", checkCommand("forbid:regression", "mkdir:dist", "write:dist/output.js=built")]] as const) registry.register({ name, scope: { inputs: ["."], exclude: ["dist"] }, run: async (signal) => {
    counts[name]++;
    return runCommandCheck({ name, command, cwd: root, timeoutMs: 1000, signal });
  } });
  const report = await verifyAndRepair({ registry, cwd: root, checks: ["test", "build"], request: "fix", repair: async () => {
    await writeFile(path.join(root, "fixed"), "");
  } });
  expect(report.status).toBe("pass");
  expect(report.rounds[2]?.[0]?.reused).toBe(true);
  expect(counts).toEqual({ test: 2, build: 2 });
  expect(report.results.every((result) => result.freshness === "fresh")).toBe(true);
});

test("an edit overlapping a verifier cannot be stamped as fresh at completion", async () => {
  const root = await fixture();
  const registry = new VerifierRegistry();
  const checked = Promise.withResolvers<void>();
  const changed = Promise.withResolvers<void>();
  registry.register({ name: "test", scope: { inputs: ["."] }, run: async () => {
    const result = await runCommandCheck({ name: "test", command: checkCommand(), cwd: root, timeoutMs: 1000 });
    checked.resolve();
    await changed.promise;
    return result;
  } });
  const work = verifyAndRepair({ registry, cwd: root, checks: ["test"], request: "check" });
  await checked.promise;
  await writeFile(path.join(root, "external-edit"), "new state");
  changed.resolve();
  const report = await work;
  expect(report.status).toBe("pass");
  expect(report.results[0]).toMatchObject({ status: "pass", freshness: "stale" });
  expect(taskExitCode(report)).toBe(0);
  for (const text of [formatVerificationReport(report), formatTaskResult({ execution: "completed", verification: report }), formatVerificationResult(report.results[0]!)]) {
    expect(text).toContain("inputs stale");
    expect(text).toContain("current files unverified");
    expect(text).toContain('scope {"inputs":["."]}');
  }
  expect(formatVerificationReport(report)).toContain("Checks pass (command execution)");
  expect(formatTaskResult({ execution: "completed", verification: report })).toContain("Requested behavior is not independently certified");
});

// `/dev/null` as a link target is POSIX-only; Windows has no equivalent device path.
posixOnly("unknown filesystem state disables reuse while still reporting actual command exits", async () => {
  const root = await fixture();
  await symlink("/dev/null", path.join(root, "unsupported"));
  const registry = new VerifierRegistry();
  let calls = 0;
  for (const name of ["test", "build"] as const) registry.register({ name, scope: { inputs: ["."] }, run: () => {
    calls++;
    return runCommandCheck({ name, command: name === "test" ? checkCommand("require:fixed") : checkCommand(), cwd: root, timeoutMs: 1000 });
  } });
  const report = await verifyAndRepair({ registry, cwd: root, checks: ["test", "build"], request: "fix", repair: () => writeFile(path.join(root, "fixed"), "") });
  expect(calls).toBe(5);
  expect(report.status).toBe("pass");
  expect(report.results[0]?.freshnessReason).toContain("symlink or special file");
  expect(report.results.every((result) => !result.reused && result.freshness === "unavailable")).toBe(true);
});

test("observed stale evidence stays invalid even when repair restores directory membership", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "src"));
  const registry = new VerifierRegistry();
  registry.register({ name: "test", scope: { inputs: ["src"] }, run: () => runCommandCheck({ name: "test", cwd: root, timeoutMs: 1000,
    command: checkCommand("append:test-runs") }) });
  registry.register({ name: "build", run: () => runCommandCheck({ name: "build", cwd: root, timeoutMs: 1000,
    command: checkCommand("on-failure:touch:src/temporary", "require:fixed") }) });
  const report = await verifyAndRepair({ registry, checks: ["test", "build"], cwd: root, request: "Check", repair: async () => {
    await rm(path.join(root, "src/temporary"));
    await writeFile(path.join(root, "fixed"), "");
  } });
  expect(report.status).toBe("pass");
  expect(await Bun.file(path.join(root, "test-runs")).text()).toBe("xx");
  expect(report.results[0]?.freshness).toBe("fresh");
});

test("deleting a named input after a pass is known stale, not just unavailable", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "source.ts"), "before");
  const registry = new VerifierRegistry();
  registry.register({ name: "test", scope: { inputs: ["source.ts"] }, run: () => runCommandCheck({
    name: "test", command: checkCommand("require:source.ts"), cwd: root, timeoutMs: 1000 }) });
  registry.register({ name: "build", run: () => runCommandCheck({
    name: "build", command: checkCommand("remove:source.ts"), cwd: root, timeoutMs: 1000 }) });
  const report = await verifyAndRepair({ registry, checks: ["test", "build"], cwd: root, request: "Check" });
  expect(report.results[0]).toMatchObject({ status: "pass", freshness: "stale" });
  expect(formatVerificationReport(report)).toContain("current files unverified");
});

test("a verifier executing in a different cwd cannot borrow another workspace's fingerprint", async () => {
  const root = await fixture();
  const other = await fixture();
  const registry = new VerifierRegistry();
  registry.register({ name: "test", scope: { inputs: ["."] }, run: () => runCommandCheck({ name: "test", command: checkCommand(), cwd: other, timeoutMs: 1000 }) });
  const report = await verifyAndRepair({ registry, cwd: root, checks: ["test"], request: "check" });
  expect(report.results[0]).toMatchObject({ status: "pass", cwd: other, freshness: "unavailable" });
  expect(report.results[0]?.workspaceState).toBeUndefined();
});

// `/dev/null` as a link target is POSIX-only; Windows has no equivalent device path.
posixOnly("dependency-heavy workspaces can observe an explicitly limited scope without treating artifacts as inputs", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules", "large"), Buffer.alloc(2 * 1024 * 1024));
  await symlink("/dev/null", path.join(root, "node_modules", "link"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "code.ts"), "before");
  const scope = { inputs: ["src"], exclude: ["src/coverage"] };
  const registry = new VerifierRegistry();
  registry.register({ name: "test", scope, run: () => runCommandCheck({ name: "test", cwd: root, timeoutMs: 1000,
    command: checkCommand("mkdir:src/coverage", "write:src/coverage/results.json=coverage") }) });
  const report = await verifyAndRepair({ registry, checks: ["test"], cwd: root, request: "Check" });
  expect(report.results[0]).toMatchObject({ status: "pass", freshness: "fresh", scope });
  expect(formatVerificationReport(report)).toContain("declared local scope only");
  // Declaring dependencies as inputs still reports the concrete unsupported input.
  expect((await workspaceState(root, { inputs: ["node_modules"] })).reason).toContain("exceeds 1 MiB");
  // Explicit nested inputs may not silently follow an included symlinked parent.
  await symlink(path.join(root, "src"), path.join(root, "linked-src"));
  expect((await workspaceState(root, { inputs: ["linked-src/code.ts"] })).reason).toContain("Unsupported input parent");
});

posixOnly("a missing after-observation never becomes reusable merely because the final observation succeeds", async () => {
  const root = await fixture();
  const registry = new VerifierRegistry();
  registry.register({ name: "test", scope: { inputs: ["."] }, run: () => runCommandCheck({ name: "test", cwd: root, timeoutMs: 1000,
    command: "ln -s /dev/null temporary-link" }) });
  registry.register({ name: "build", run: () => runCommandCheck({ name: "build", cwd: root, timeoutMs: 1000,
    command: "rm temporary-link" }) });
  const report = await verifyAndRepair({ registry, checks: ["test", "build"], cwd: root, request: "Check" });
  expect(report.results[0]).toMatchObject({ status: "pass", freshness: "unavailable" });
  expect(report.results[0]?.freshnessReason).toContain("symlink or special file");
  expect(report.results[0]?.reused).not.toBe(true);
});

test("observation envelopes omit arbitrary arguments, bound Unicode output and disclose producer truncation", () => {
  expect(observationInput({ command: "true", path: "a", content: "private file body", auth: "secret" })).toEqual({ command: "true", path: "a" });
  expect(observationInput({ command: "x".repeat(8193) })).toEqual({});
  const result = observationOutput({ content: [{ type: "text", text: "😀".repeat(10000) + "TAIL" }] });
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8192);
  expect(result.text).not.toContain("�");
  expect(result.text).toEndWith("TAIL");
  expect(observationOutput({ content: [{ type: "text", text: "short" }], details: { truncation: { truncated: true } } })).toEqual({ text: "short", truncated: true });
  expect(observationOutput(undefined)).toEqual({ text: "", truncated: false });
  const receipt = formatTaskResult({ execution: "completed", observedEdits: ["a\n\u001b[31mforged"] });
  expect(receipt).not.toContain("\u001b"); expect(receipt).not.toContain("a\n");
  expect(receipt).toContain("tool edits   a  [31mforged");
});
