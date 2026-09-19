#!/usr/bin/env bun
// Local-only, reproducible micro/workflow benchmarks. No model or personal config.
// CASPER_BENCH_ROOT can point at a preserved source snapshot for paired comparisons.
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const source = path.resolve(process.env.CASPER_BENCH_ROOT ?? path.join(import.meta.dir, ".."));
const { LSPManager } = await import(pathToFileURL(path.join(source, "src/lsp/manager.ts")).href);
const { MessageReader } = await import(pathToFileURL(path.join(source, "src/lsp/protocol.ts")).href);
const { snapshot } = await import(pathToFileURL(path.join(source, "src/lsp/workspace.ts")).href);
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-benchmark-")));
const results: Record<string, { samples: number; medianMs: number; p95Ms: number; samplesMs: number[] }> = {};
async function measure(name: string, count: number, work: () => Promise<unknown> | unknown) {
  await work(); // warm-up; process startup measurements still use a fresh child each time
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await work();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  results[name] = { samples: count, medianMs: +samples[Math.floor(count / 2)].toFixed(3), p95Ms: +samples[Math.min(count - 1, Math.ceil(count * .95) - 1)].toFixed(3), samplesMs: samples.map((value) => +value.toFixed(3)) };
}
const fixture = path.join(source, "tests/fixtures/lsp-server.ts");
const manager = (cwd: string, mode = "normal", timeoutMs = 2000) => new LSPManager(cwd, { servers: [{ name: "bench", source: "benchmark", command: process.execPath, args: [fixture, mode], languages: { ".ts": "typescript" } }], diagnostics: [] }, timeoutMs);
try {
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home);
  await mkdir(project);
  await measure("cli_project_fresh_process", 7, async () => {
    const child = Bun.spawn([process.execPath, path.join(source, "src/cli.ts"), "/project"], {
      cwd: project, env: { ...process.env, HOME: home, CASPER_PROFILE: "default", PI_OFFLINE: "1", PI_TELEMETRY: "0" }, stdout: "ignore", stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    assert.equal(await child.exited, 0, stderr);
  });
  await writeFile(path.join(project, "small.ts"), "x".repeat(4096));
  await writeFile(path.join(project, "large.ts"), "x".repeat(1024 * 1024));
  await measure("snapshot_4KiB", 100, () => snapshot(project, "small.ts"));
  await measure("snapshot_1MiB", 20, () => snapshot(project, "large.ts"));
  for (const chunkSize of [256, 8192]) {
    const body = JSON.stringify({ value: "x".repeat(1024 * 1024) });
    const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await measure(`frame_1MiB_chunks_${chunkSize}`, 7, () => {
      let count = 0;
      const reader = new MessageReader(() => count++);
      for (let offset = 0; offset < frame.length; offset += chunkSize) reader.push(frame.subarray(offset, offset + chunkSize));
      assert.equal(count, 1);
    });
  }
  await measure("connect_close_fixture", 7, async () => {
    const client = manager(project);
    try { await client.connect("bench"); } finally { await client.close(); }
  });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const files = Array.from({ length: 100 }, (_, index) => `file${String(index).padStart(3, "0")}.ts`);
  const text = "old(); // " + "x".repeat(500);
  for (const file of files) await writeFile(path.join(workspace, file), text);
  const client = manager(workspace);
  try {
    await client.connect("bench");
    await client.query("bench", "symbols", { path: files[0] });
    await measure("symbols_1_open_file", 20, () => client.query("bench", "symbols", { path: files[0] }));
    for (const file of files.slice(1)) await client.query("bench", "symbols", { path: file });
    await client.diagnostics("bench", files[0]);
    await measure("symbols_100_open_files", 15, () => client.query("bench", "symbols", { path: files[0] }));
    await measure("diagnostics_100_open_files", 15, async () => {
      assert.equal((await client.diagnostics("bench", files[0])).status, "fresh");
    });
    await measure("rename_100_files_with_diagnostics", 5, async () => {
      for (const file of files) await writeFile(path.join(workspace, file), text);
      const result = await client.rename("bench", files[0], { line: 0, character: 1 }, "new", async () => true);
      assert.equal(result.changed.length, 100);
      assert.equal(result.diagnostics.length, 100);
      assert.ok(result.diagnostics.every((report: { status: string }) => report.status === "fresh"));
    });
  } finally { await client.close(); }
  const silentRoot = path.join(root, "silent");
  await mkdir(silentRoot);
  for (const file of files.slice(0, 10)) await writeFile(path.join(silentRoot, file), "old();");
  const silent = manager(silentRoot, "silent", 100);
  try {
    await silent.connect("bench");
    await measure("rename_10_files_missing_diagnostics_100ms_budget", 3, async () => {
      for (const file of files.slice(0, 10)) await writeFile(path.join(silentRoot, file), "old();");
      const result = await silent.rename("bench", files[0], { line: 0, character: 1 }, "new", async () => true);
      assert.equal(result.changed.length, 10);
      assert.ok(result.diagnostics.every((report: { status: string }) => report.status !== "fresh"));
    });
  } finally { await silent.close(); }
  console.log(JSON.stringify({ environment: { bun: Bun.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model }, results }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
