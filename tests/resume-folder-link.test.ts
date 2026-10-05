import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const cli = path.resolve(import.meta.dir, "../src/cli.ts");
// A junction needs no admin rights on Windows; elsewhere a folder symlink does the same.
const linkType = process.platform === "win32" ? "junction" : "dir";

const linksWork = await (async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-folder-link-probe-"));
  try {
    await mkdir(path.join(root, "real"));
    await symlink(path.join(root, "real"), path.join(root, "link"), linkType);
    return true;
  } catch { return false; } finally { await rm(root, { recursive: true, force: true }); }
})();

// On Windows the folder a program starts in keeps the spelling it was given: a junction, a link or a short
// 8.3 name (the CI runner's temp folder is C:\Users\RUNNER~1\...). Casper saves its workspace record under the
// real path, so a second start must not move the conversation list to a folder with no conversations in it.
test.skipIf(!linksWork)("/resume lists the saved conversations when Casper starts through a linked folder", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-resume-link-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); const real = path.join(root, "project"); const project = path.join(root, "linked");
  const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true }); await mkdir(path.join(home, ".casper")); await mkdir(real);
  await symlink(real, project, linkType);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "first", retry: { enabled: false } }));
  await writeFile(path.join(agent, "auth.json"), "{}\n");
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: {
    fixture: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fixture-not-a-secret", models: [{ id: "first" }] },
  } }));
  const env = { ...isolatedEnvironment(home), CASPER_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  const run = async (command: string) => {
    const child = Bun.spawn([process.execPath, cli, command], { cwd: project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    return stdout;
  };
  await run("/clear");
  await run("/clear");
  const listed = await run("/resume");
  expect(listed).not.toContain("No other saved conversations");
  expect(listed).toContain("Use /resume <id> (its first few characters are enough)");
}, 60_000);
