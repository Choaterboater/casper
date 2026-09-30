import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sourceDependencyProblem, staleDependencies } from "../src/runtime/source-deps";
import { cleanEnv } from "./support/env";

const REPO = path.resolve(import.meta.dir, "..");

async function checkout(dependencies: Record<string, string>, installed: Record<string, string>): Promise<string> {
  // The real path: on macOS the temp folder is /var/..., a link to /private/var/..., which the launcher reports.
  const repo = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-source-deps-")));
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "casper", dependencies }));
  for (const [name, version] of Object.entries(installed)) {
    await mkdir(path.join(repo, "node_modules", name), { recursive: true });
    await writeFile(path.join(repo, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
  }
  return repo;
}

test("a package missing from node_modules, or at another pinned version, needs bun install", async () => {
  const repo = await checkout({ "@scope/new": "0.0.77", old: "1.2.0", ranged: "^2.0.0", same: "3.0.0" },
    { old: "1.1.0", ranged: "2.4.1", same: "3.0.0" });
  try {
    expect(staleDependencies(repo)).toEqual(["@scope/new", "old"]);
    expect(sourceDependencyProblem(repo)).toBe(`New parts were added. Run: bun install  (in ${repo})`);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("this checkout's installed packages match package.json", () => {
  expect(sourceDependencyProblem(REPO)).toBeUndefined();
});

test("from source, a pull that added a package prints one line and exits 1 instead of a module error", async () => {
  // Only the launcher and its check are copied: nothing else in src/ may load before the check.
  const repo = await checkout({ "@anthropic-ai/sandbox-runtime": "0.0.77", yaml: "2.8.2" }, { yaml: "2.8.2" });
  try {
    await mkdir(path.join(repo, "src", "runtime"), { recursive: true });
    await copyFile(path.join(REPO, "src", "cli.ts"), path.join(repo, "src", "cli.ts"));
    await copyFile(path.join(REPO, "src", "runtime", "source-deps.ts"), path.join(repo, "src", "runtime", "source-deps.ts"));
    const child = Bun.spawn([process.execPath, path.join(repo, "src", "cli.ts"), "--version"], { cwd: repo, env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stdout, stderr }).toEqual({ exit: 1, stdout: "", stderr: `New parts were added. Run: bun install  (in ${repo})\n` });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("the seccomp helper loads only on Linux: without the package, macOS still starts", async () => {
  // seccomp.ts alone, with no node_modules: a static import of the Linux helper would fail at load.
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-seccomp-lazy-"));
  try {
    await copyFile(path.join(REPO, "src", "sandbox", "seccomp.ts"), path.join(dir, "seccomp.ts"));
    await mkdir(path.join(dir, "node_modules")); // an empty one: Bun never auto-installs the package
    await writeFile(path.join(dir, "probe.ts"), `import { seccompHelper } from "./seccomp";
const mac = await seccompHelper({ platform: "darwin", arch: "x64" });
const linux = await seccompHelper({ platform: "linux", arch: "x64", home: ${JSON.stringify(dir)} }).then(() => "loaded", () => "not installed");
const other = await seccompHelper({ platform: "linux", arch: "ia32" });
process.stdout.write(JSON.stringify({ mac: mac ?? null, linux, other: other ?? null }));
`);
    const child = Bun.spawn([process.execPath, "--no-install", path.join(dir, "probe.ts")], { cwd: dir, env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ mac: null, linux: "not installed", other: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("from source on Linux, the seccomp helper is the installed package's file", async () => {
  const { seccompHelper } = await import("../src/sandbox/seccomp");
  const helper = await seccompHelper({ platform: "linux", arch: "x64" });
  expect(helper).toEndWith(path.join("vendor", "seccomp", "x64", "apply-seccomp"));
});
