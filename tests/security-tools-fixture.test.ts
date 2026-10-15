import { afterEach, beforeAll, expect, test } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import { writeFileSync } from "node:fs";
import { link, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSharedLauncher, FAKE_PROGRAM_SETUP_MS, fakeProgram, prepareFakePrograms } from "./fixtures/security-tools/setup";
import { removeTempDir } from "./support/temp-dir";

beforeAll(prepareFakePrograms, FAKE_PROGRAM_SETUP_MS);

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await removeTempDir(dir); });
async function temp() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-launcher-fixture-")));
  temps.push(root);
  return root;
}
const result = (overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> => ({
  pid: 1, status: 0, signal: null, stdout: "build output", stderr: "build diagnostics", output: [], ...overrides,
});
const compile = (outfile: string) => { writeFileSync(outfile, "complete fixture executable"); return result(); };

test("the launcher retries a failed compile, publishes only a complete output, and reuses it", async () => {
  const root = await temp();
  const exe = path.join(root, "shared.exe");
  let attempts = 0;
  const built = await buildSharedLauncher(exe, { scratchRoot: root, compile: outfile => {
    attempts++;
    if (attempts === 1) return result({ status: null, signal: "SIGTERM", error: new Error("temporary compiler failure") });
    return compile(outfile);
  } });
  expect(attempts).toBe(2);
  expect(built).toBe(exe);
  expect(await readFile(exe, "utf8")).toBe("complete fixture executable");
  expect(await readdir(root)).toEqual(["shared.exe"]);
  expect(await buildSharedLauncher(exe, { compile: () => { throw new Error("must use the shared file"); } })).toBe(exe);
});

test("exhausted compile retries report status, signal, error, stdout and stderr for every attempt", async () => {
  const root = await temp();
  let attempts = 0;
  let failure = "";
  try {
    await buildSharedLauncher(path.join(root, "shared.exe"), { scratchRoot: root, compile: () => {
      attempts++;
      return result({ status: null, signal: "SIGTERM", error: new Error("spawn EAGAIN") });
    } });
  } catch (error) { failure = String(error); }
  expect(attempts).toBe(3);
  for (const text of ["attempt 1:", "attempt 2:", "attempt 3:", "status=null", "signal=SIGTERM", "error=Error: spawn EAGAIN", 'stdout="build output"', 'stderr="build diagnostics"']) {
    expect(failure).toContain(text);
  }
  expect(await readdir(root)).toEqual([]);
});

test("a nonzero compiler exit is not mistaken for a published launcher", async () => {
  const root = await temp();
  await expect(buildSharedLauncher(path.join(root, "shared.exe"), { scratchRoot: root,
    compile: outfile => { compile(outfile); return result({ status: 7 }); },
  })).rejects.toThrow("status=7");
  expect(await readdir(root)).toEqual([]);
});

test("a successful compiler status without a nonempty output fails instead of returning a missing exe", async () => {
  const root = await temp();
  await expect(buildSharedLauncher(path.join(root, "shared.exe"), { scratchRoot: root,
    compile: outfile => { writeFileSync(outfile, ""); return result(); },
  })).rejects.toThrow("compile produced no nonempty launcher");
  expect(await readdir(root)).toEqual([]);
});

test("publication failures without a competing exe are retried and reported, not swallowed", async () => {
  const root = await temp();
  let attempts = 0;
  await expect(buildSharedLauncher(path.join(root, "shared.exe"), { scratchRoot: root, compile,
    publish: async () => { attempts++; throw new Error("publication EPERM"); },
  })).rejects.toThrow("publication EPERM");
  expect(attempts).toBe(3);
  expect(await readdir(root)).toEqual([]);
});

test("publication is verified even when the publisher claims success", async () => {
  const root = await temp();
  await expect(buildSharedLauncher(path.join(root, "shared.exe"), { scratchRoot: root, compile,
    publish: async () => {},
  })).rejects.toThrow("shared launcher missing after publication");
});

test("an empty shared file does not count as a competing publisher's completed exe", async () => {
  const root = await temp();
  const exe = path.join(root, "shared.exe");
  await writeFile(exe, "");
  await expect(buildSharedLauncher(exe, { scratchRoot: root, compile })).rejects.toThrow("could not build/publish");
  expect((await stat(exe)).size).toBe(0);
});

test("competing publishers return the same verified executable and clean their scratch files", async () => {
  const root = await temp();
  const exe = path.join(root, "shared.exe");
  const ready = Promise.withResolvers<void>();
  let publishers = 0;
  const publish = async (from: string, to: string) => {
    if (++publishers === 2) ready.resolve();
    await ready.promise;
    await link(from, to);
  };
  expect(await Promise.all([buildSharedLauncher(exe, { scratchRoot: root, compile, publish }),
    buildSharedLauncher(exe, { scratchRoot: root, compile, publish })])).toEqual([exe, exe]);
  expect(publishers).toBe(2);
  expect(await readFile(exe, "utf8")).toBe("complete fixture executable");
  expect(await readdir(root)).toEqual(["shared.exe"]);
});

test("fake programs share the launcher while preserving each command, arguments, cwd and exit code", async () => {
  const root = await temp();
  const programs = await Promise.all(["first", "second"].map((name, index) => fakeProgram(root, name,
    [process.execPath, "-e", `console.log(JSON.stringify({tag:${index}, args:process.argv.slice(1), cwd:process.cwd()})); process.exit(${index});`, "fixed argument"])));
  await Promise.all(programs.map(async (program, index) => {
    const child = Bun.spawn([program, "extra argument"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: index, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ tag: index, args: ["fixed argument", "extra argument"], cwd: root });
  }));
}, 15_000);
