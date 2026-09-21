#!/usr/bin/env bun
// Local-only fresh-process benchmark. No provider, personal config or MCP connection.
// CASPER_BENCH_BASE enables ABBA comparison with a preserved source snapshot.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const current = path.resolve(process.env.CASPER_BENCH_ROOT ?? path.join(import.meta.dir, ".."));
const baseline = process.env.CASPER_BENCH_BASE ? path.resolve(process.env.CASPER_BENCH_BASE) : undefined;
const root = await mkdtemp(path.join(os.tmpdir(), "casper-startup-benchmark-"));
const results: Record<string, number[]> = {};
const importedDependencies: Record<string, number> = {};
try {
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(project);
  await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify({ mcpServers: { unconnected: { command: "never-run-benchmark-server" } } }));
  const env = { ...process.env, HOME: home, CASPER_PROFILE: "default", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  async function sample(label: string, source: string, workload: "import" | "project", record: boolean) {
    const args = workload === "project" ? [path.join(source, "src/cli.ts"), "/project"] : ["-e", `
      const start = performance.now();
      await import(${JSON.stringify(path.join(source, "src/app.ts"))});
      console.log(JSON.stringify({ ms: performance.now() - start, dependencies: Object.keys(require.cache).filter(p => p.includes("/node_modules/ajv/") || p.includes("/node_modules/@modelcontextprotocol/")).length }));
    `];
    const start = performance.now();
    const child = Bun.spawn([process.execPath, ...args], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const wallMs = performance.now() - start;
      assert.equal(code, 0, stderr);
      if (workload === "import") {
        const value = JSON.parse(stdout);
        importedDependencies[label] = value.dependencies;
        if (record) (results[`${label}:app_import_ms`] ??= []).push(value.ms);
      }
      if (record) (results[`${label}:${workload}_process_ms`] ??= []).push(wallMs);
    } finally { clearTimeout(timer); }
  }
  const variants = baseline ? [{ label: "before", source: baseline }, { label: "after", source: current }] : [{ label: "current", source: current }];
  for (const workload of ["import", "project"] as const) {
    for (let warmup = 0; warmup < 2; warmup++) for (const { label, source } of variants) await sample(label, source, workload, false);
    // Five ABBA blocks: ten observations per variant, fresh child every sample.
    for (let block = 0; block < 5; block++) {
      const order = baseline ? [variants[0]!, variants[1]!, variants[1]!, variants[0]!] : [variants[0]!, variants[0]!];
      for (const { label, source } of order) await sample(label, source, workload, true);
    }
  }
  console.log(JSON.stringify({ environment: { bun: Bun.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model }, importedDependencies,
    results: Object.fromEntries(Object.entries(results).map(([name, samples]) => {
      const sorted = [...samples].sort((a, b) => a - b);
      return [name, { count: samples.length, medianMs: +((sorted[4]! + sorted[5]!) / 2).toFixed(3), minMs: +sorted[0]!.toFixed(3), maxMs: +sorted.at(-1)!.toFixed(3), samplesMs: samples.map((value) => +value.toFixed(3)) }];
    })),
  }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
