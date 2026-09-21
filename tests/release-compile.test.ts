import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { compileExecutable } from "../scripts/compile";

test("the standalone CLI starts and reports its version on every host", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-compiled-start-"));
  try {
    const binary = path.join(root, process.platform === "win32" ? "casper.exe" : "casper");
    await compileExecutable(path.join(import.meta.dir, "../src/standalone.ts"), binary);
    const child = Bun.spawn([binary, "--version"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "casper 0.1.0\n", stderr: "" });
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
      env: { ...process.env, HOME: root, USERPROFILE: root, PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin" },
      stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr, output: JSON.parse(stdout) }).toEqual({ exit: 0, stderr: "", output: { imageRead: true, mimeType: "image/png", resized: true } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
