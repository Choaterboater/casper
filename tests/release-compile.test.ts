import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { compileExecutable } from "../scripts/compile";
import { CASPER_VERSION } from "../src/version";
import { cleanEnv } from "./support/env";
import { needsSandbox } from "./support/platform";

// Bun 1.4 copies a read-only runtime (Homebrew's 0555 bun) into the build's cwd as
// `.<hash>-00000000.bun-build` and never unlinks it; the compile must not leave one here.
const bunBuildLeaks = async () => (await readdir(process.cwd())).filter((name) => name.endsWith(".bun-build"));

test("the standalone CLI starts and reports its version on every host", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-compiled-start-"));
  try {
    const binary = path.join(root, process.platform === "win32" ? "casper.exe" : "casper");
    const before = new Set(await bunBuildLeaks());
    await compileExecutable(path.join(import.meta.dir, "../src/standalone.ts"), binary);
    expect((await bunBuildLeaks()).filter((name) => !before.has(name))).toEqual([]);
    const child = Bun.spawn([binary, "--version"], { cwd: root, env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    // A compiled binary names its own executable path (the installer compares only the version token).
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toMatch(new RegExp(`^casper ${CASPER_VERSION.replaceAll(".", "\\.")} \\(.*casper(?:\\.exe)?\\)\\n$`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("the compiled binary embeds the OAuth flow of every /login provider", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-compiled-oauth-"));
  try {
    const binary = path.join(root, process.platform === "win32" ? "probe.exe" : "probe");
    await compileExecutable(path.join(import.meta.dir, "fixtures/compiled-oauth.ts"), binary);
    const child = Bun.spawn([binary], { cwd: root, env: cleanEnv({ HOME: root, USERPROFILE: root }), stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr, output: JSON.parse(stdout) }).toEqual({ exit: 0, stderr: "",
      output: { "openai-codex": "ok", "github-copilot": "ok", anthropic: "ok", openrouter: "ok" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("the compiled binary carries the bundled flows (plan first, prove the fix)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-compiled-flows-"));
  try {
    const binary = path.join(root, process.platform === "win32" ? "probe.exe" : "probe");
    await compileExecutable(path.join(import.meta.dir, "fixtures/compiled-flows.ts"), binary);
    const child = Bun.spawn([binary], { cwd: root, env: cleanEnv({ HOME: root, USERPROFILE: root }), stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const flows = JSON.parse(stdout) as Array<{ name: string; bytes: number }>;
    expect(flows.map((flow) => flow.name)).toEqual(["plan-first", "prove-fix"]);
    for (const flow of flows) expect(flow.bytes).toBeGreaterThan(500);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

function chunk(kind: string, bytes: Buffer): Buffer {
  const tag = Buffer.from(kind);
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(Bun.hash.crc32(Buffer.concat([tag, bytes])));
  return Buffer.concat([length, tag, bytes, crc]);
}

test("compiled native image reads work without build-time WASM or Bun on PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-compiled-image-"));
  try {
    const binary = path.join(root, process.platform === "win32" ? "probe.exe" : "probe");
    await compileExecutable(path.join(import.meta.dir, "fixtures/compiled-image.ts"), binary);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2001, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
    const pixels = Buffer.alloc(2001 * 4, Buffer.from([255, 0, 0, 255]));
    const scanline = Buffer.concat([Buffer.from([0]), pixels]);
    const image = path.join(root, "image.png");
    await writeFile(image, Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.concat([scanline, scanline]))), chunk("IEND", Buffer.alloc(0)),
    ]));
    const child = Bun.spawn([binary, image], {
      cwd: root,
      env: cleanEnv({ HOME: root, USERPROFILE: root, PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin" }),
      stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr, output: JSON.parse(stdout) }).toEqual({ exit: 0, stderr: "", output: { imageRead: true, mimeType: "image/png", resized: true } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

needsSandbox("the compiled binary carries the sandbox and its seccomp helper, written to ~/.casper/bin after a hash check", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-compiled-sandbox-"));
  try {
    const binary = path.join(root, "probe");
    await compileExecutable(path.join(import.meta.dir, "fixtures/compiled-sandbox.ts"), binary);
    const home = path.join(root, "home"), project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    const child = Bun.spawn([binary, project], { cwd: root, env: cleanEnv({ HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" }), stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ mode: 0o700, hashInName: true, inside: "inside", key: false, socket: "SOCKET-BLOCKED" });
    expect(result.helper).toStartWith(path.join(home, ".casper", "bin", "apply-seccomp-"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
