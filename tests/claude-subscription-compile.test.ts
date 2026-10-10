import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileExecutable } from "../scripts/compile";
import { isolatedEnvironment } from "../src/platform/environment";
import { removeTempDir } from "./support/temp-dir";

test("compiled Casper transport loads the real SDK and launches a native CLI with spaces in its path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-claude-compile-"));
  try {
    const suffix = process.platform === "win32" ? ".exe" : "";
    const cli = path.join(root, `synthetic claude${suffix}`);
    const probe = path.join(root, `probe${suffix}`);
    const casper = path.join(root, `casper${suffix}`);
    await compileExecutable(path.join(import.meta.dir, "fixtures/claude-subscription-cli.ts"), cli);
    await compileExecutable(path.join(import.meta.dir, "fixtures/compiled-claude-subscription.ts"), probe);
    const child = Bun.spawn([probe, cli], { cwd: root, env: { ...isolatedEnvironment(root), PI_OFFLINE: "1", CASPER_OFFLINE: "1" },
      stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({ provider: "claude-subscription", stopReason: "stop", content: [{ type: "text", text: "synthetic SDK transport works" }] });
    await compileExecutable(path.resolve(import.meta.dir, "../src/standalone.ts"), casper);
    const fresh = Bun.spawn([casper, "/model", "--session", "claude-subscription/claude-opus-4-8"], { cwd: root,
      env: { ...isolatedEnvironment(root), CASPER_CLAUDE_PATH: cli, PI_OFFLINE: "1", CASPER_OFFLINE: "1", CASPER_LOCAL_MODELS: "off" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    const [selected, error, code] = await Promise.all([new Response(fresh.stdout).text(), new Response(fresh.stderr).text(), fresh.exited]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(selected).toContain("claude-subscription/claude-opus-4-8");
    expect(selected).toContain("Selected for this conversation only");
    expect(await Bun.file(path.join(root, ".pi")).exists()).toBe(false);
  } finally { await removeTempDir(root); }
}, 120_000);
