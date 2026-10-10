import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import { removeTempDir } from "./support/temp-dir";
import { compileExecutable } from "../scripts/compile";

test("fresh Casper sessions and isolated readers can select the subscription provider without a Pi install", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-claude-runtime-"));
  try {
    const home = path.join(root, "home"), cwd = path.join(root, "project"), agent = path.join(home, ".casper/agent");
    await mkdir(agent, { recursive: true }); await mkdir(cwd);
    const cli = path.join(root, process.platform === "win32" ? "synthetic claude.exe" : "synthetic claude");
    await compileExecutable(path.join(import.meta.dir, "fixtures/claude-subscription-cli.ts"), cli);
    const source = path.resolve(import.meta.dir, "../src/runtime/pi.ts");
    const child = Bun.spawn([process.execPath, "-e", `
      import { PiRuntime } from ${JSON.stringify(source)};
      const main = new PiRuntime(); const reader = new PiRuntime();
      try {
        const session = await main.start({ cwd: process.cwd(), localModels: false });
        const before = session.getStatus();
        await session.selectModel({ query: "claude-subscription/claude-opus-4-8", persist: true });
        const isolated = await reader.startReadOnly({ cwd: process.cwd(), signal: new AbortController().signal, maxTurns: 1, maxToolCalls: 1 });
        console.log(JSON.stringify({ before, main: session.getStatus(), reader: isolated.getStatus() }));
      } finally { await reader.dispose(); await main.dispose(); }
    `], { cwd, env: { ...isolatedEnvironment(home), PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", CASPER_OFFLINE: "1", PI_TELEMETRY: "0", CASPER_CLAUDE_PATH: cli },
      stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(stdout);
    expect(result.before.selectionSource).toBe("none");
    expect(await Bun.file(path.join(home, ".pi")).exists()).toBe(false);
    for (const status of [result.main, result.reader]) expect(status).toMatchObject({ provider: "claude-subscription", model: "claude-opus-4-8", billing: "subscription" });
    expect(JSON.parse(await readFile(path.join(home, ".casper/settings.json"), "utf8"))).toMatchObject({ defaultProvider: "claude-subscription" });
  } finally { await removeTempDir(root); }
}, 120_000);

test("subscription proposals retain Casper's native tools, approvals, private-path guard, shell sandbox, compaction and persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-claude-tools-"));
  try {
    const home = path.join(root, "home"), cwd = path.join(root, "project");
    await mkdir(home); await mkdir(path.join(cwd, "private"), { recursive: true });
    await writeFile(path.join(cwd, "fixture.txt"), "native read evidence\n");
    await writeFile(path.join(cwd, "private/token.txt"), "PRIVATE_FIXTURE_MUST_NOT_REACH_MODEL\n");
    const cli = path.join(root, process.platform === "win32" ? "synthetic claude.exe" : "synthetic claude");
    await compileExecutable(path.join(import.meta.dir, "fixtures/claude-subscription-cli.ts"), cli);
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/claude-subscription-runtime.ts")], { cwd,
      env: { ...isolatedEnvironment(home), CASPER_CLAUDE_PATH: cli, PI_CODING_AGENT_DIR: path.join(home, ".casper/agent"), PI_OFFLINE: "1", CASPER_OFFLINE: "1" },
      stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(stdout);
    expect(result.ends.map((end: { toolName: string; isError: boolean }) => [end.toolName, end.isError])).toEqual([
      ["read", false], ["read", true], ["write", true], ["write", false], ["bash", true],
    ]);
    expect(result.approvals).toBe(1); expect(result.wraps).toBe(0);
    expect(await readFile(path.join(cwd, "marker.txt"), "utf8")).toBe("native write\n");
    expect(result.saved).toContain("native read evidence");
    expect(result.saved).toContain("fixture approval required");
    expect(result.saved).not.toContain("PRIVATE_FIXTURE_MUST_NOT_REACH_MODEL");
    expect(result.compacted).toContain('"type":"compaction"');
    expect(result.turns).toContainEqual({ role: "assistant", text: "fixture complete" });
  } finally { await removeTempDir(root); }
}, 120_000);

test("subscription registration and session-only selection preserve existing saved defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-claude-defaults-"));
  try {
    const home = path.join(root, "home"), cwd = path.join(root, "project"), directory = path.join(home, ".casper");
    await mkdir(directory, { recursive: true }); await mkdir(cwd);
    const defaults = JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-opus-4-8", defaultThinkingLevel: "high" }) + "\n";
    await writeFile(path.join(directory, "settings.json"), defaults);
    const cli = path.join(root, process.platform === "win32" ? "synthetic claude.exe" : "synthetic claude");
    await compileExecutable(path.join(import.meta.dir, "fixtures/claude-subscription-cli.ts"), cli);
    const source = path.resolve(import.meta.dir, "../src/runtime/pi.ts");
    const child = Bun.spawn([process.execPath, "-e", `
      import { PiRuntime } from ${JSON.stringify(source)};
      const runtime = new PiRuntime();
      try {
        const session = await runtime.start({ cwd: process.cwd(), localModels: false });
        const before = session.getStatus();
        await session.selectModel({ query: "claude-subscription/claude-opus-4-8", persist: false });
        console.log(JSON.stringify({ before, after: session.getStatus() }));
      } finally { await runtime.dispose(); }
    `], { cwd, env: { ...isolatedEnvironment(home), CASPER_CLAUDE_PATH: cli, PI_CODING_AGENT_DIR: path.join(directory, "agent"), PI_OFFLINE: "1", CASPER_OFFLINE: "1" },
      stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(stdout);
    expect(result.before).toMatchObject({ provider: "anthropic", model: "claude-opus-4-8", selectionSource: "default" });
    expect(result.after).toMatchObject({ provider: "claude-subscription", model: "claude-opus-4-8", defaultModel: { provider: "anthropic", id: "claude-opus-4-8" } });
    expect(await readFile(path.join(directory, "settings.json"), "utf8")).toBe(defaults);
  } finally { await removeTempDir(root); }
}, 120_000);
