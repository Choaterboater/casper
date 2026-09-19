import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { observationInput, observationOutput } from "../src/runtime/observation";
import { formatTaskResult } from "../src/task/result";
import { runCommandCheck } from "../src/verify/command";
import { VerifierRegistry } from "../src/verify/registry";
import { verifyAndRepair } from "../src/verify/repair-loop";
import { workspaceState } from "../src/verify/workspace-state";

const dirs: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-evidence-"));
  dirs.push(root);
  return root;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("filesystem identity covers bytes, membership, permissions and ignored files", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".gitignore"), "ignored\n");
  const file = path.join(root, "ignored");
  await writeFile(file, "before");
  const before = await workspaceState(root);
  expect(before).toBeString();
  expect(await workspaceState(root)).toBe(before);
  await writeFile(file, "after!");
  const edited = await workspaceState(root);
  expect(edited).toBeString(); expect(edited).not.toBe(before);
  await chmod(file, 0o600);
  const permission = await workspaceState(root);
  expect(permission).toBeString(); expect(permission).not.toBe(edited);
  await mkdir(path.join(root, "added"));
  expect(await workspaceState(root)).not.toBe(permission);
});

test("unsupported trees, FIFOs, limits and cancellation never supply reusable identity", async () => {
  const root = await fixture();
  const file = path.join(root, "entry");
  await symlink("/dev/null", file);
  expect(await workspaceState(root)).toBeUndefined();
  await rm(file);
  expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
  expect(await workspaceState(root)).toBeUndefined();
  await rm(file);
  await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
  expect(await workspaceState(root)).toBeUndefined();
  expect(await workspaceState(root, AbortSignal.abort())).toBeUndefined();
  expect(await workspaceState(path.join(root, "absent"))).toBeUndefined();
});

test("repair retains regression coverage and reuses only an unchanged targeted passing check", async () => {
  const root = await fixture();
  const registry = new VerifierRegistry();
  const counts = { test: 0, build: 0 };
  for (const [name, command] of [["test", "test -f fixed"], ["build", "test ! -f regression"]] as const) registry.register({ name, run: async (signal) => {
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
  registry.register({ name: "test", run: async () => {
    const result = await runCommandCheck({ name: "test", command: "true", cwd: root, timeoutMs: 1000 });
    checked.resolve();
    await changed.promise;
    return result;
  } });
  const work = verifyAndRepair({ registry, cwd: root, checks: ["test"], request: "check" });
  await checked.promise;
  await writeFile(path.join(root, "external-edit"), "new state");
  changed.resolve();
  const report = await work;
  expect(report.status).toBe("incomplete");
  expect(report.results[0]).toMatchObject({ status: "pass", freshness: "stale" });
});

test("unknown filesystem state disables reuse while still reporting actual command exits", async () => {
  const root = await fixture();
  await symlink("/dev/null", path.join(root, "unsupported"));
  const registry = new VerifierRegistry();
  let calls = 0;
  for (const name of ["test", "build"] as const) registry.register({ name, run: () => {
    calls++;
    return runCommandCheck({ name, command: name === "test" ? "test -f fixed" : "true", cwd: root, timeoutMs: 1000 });
  } });
  const report = await verifyAndRepair({ registry, cwd: root, checks: ["test", "build"], request: "fix", repair: () => writeFile(path.join(root, "fixed"), "") });
  expect(calls).toBe(5);
  expect(report.status).toBe("pass");
  expect(report.reason).toContain("freshness unavailable");
  expect(report.results.every((result) => !result.reused && result.freshness === "unavailable")).toBe(true);
});

test("a verifier executing in a different cwd cannot borrow another workspace's fingerprint", async () => {
  const root = await fixture();
  const other = await fixture();
  const registry = new VerifierRegistry();
  registry.register({ name: "test", run: () => runCommandCheck({ name: "test", command: "true", cwd: other, timeoutMs: 1000 }) });
  const report = await verifyAndRepair({ registry, cwd: root, checks: ["test"], request: "check" });
  expect(report.results[0]).toMatchObject({ status: "pass", cwd: other, freshness: "unavailable" });
  expect(report.results[0]?.workspaceState).toBeUndefined();
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
  expect(receipt).not.toContain("\u001b"); expect(receipt).not.toContain("\n");
});
