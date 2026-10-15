import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";
import { run } from "./support/run";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-tmux-regression-"));
  roots.push(root);
  const home = path.join(root, "home");
  await mkdir(home);
  const config = path.join(root, "empty.gitconfig");
  await writeFile(config, "");
  return { root, env: cleanEnv({ HOME: home, CI: "true", GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config, GIT_CONFIG_NOSYSTEM: "1" }) };
}

test.skipIf(process.platform === "win32").each([
  ["tests/box-polish-tmux.test.ts", 1], ["tests/update-tmux.test.ts", 1], ["tests/plan-terminal.test.ts", 1],
  ["tests/check-changes-terminal.test.ts", 1], ["tests/model-servers-terminal.test.ts", 4], ["tests/side-pane.test.ts", 3],
] as const)("%s tmux startup failure skips its real tests under isolated CI instead of failing with server exited unexpectedly", async (file, skips) => {
  const { root, env } = await fixture();
  await writeFile(path.join(root, "tmux"), "#!/bin/sh\nif [ \"$1\" = \"-V\" ]; then printf 'tmux fixture\\n'; exit 0; fi\nprintf 'server exited unexpectedly\\n' >&2\nexit 1\n", { mode: 0o755 });
  const result = await run([process.execPath, "test", "--parallel=2", file], {
    env: { ...env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}` }, timeoutMs: 20_000,
  });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.timedOut).toBe(false);
  expect(result.stderr).toContain(`${skips} skip`);
  expect(result.stderr).toContain("0 fail");
});

test("a private tmux that hangs during startup is unavailable within the command deadline", async () => {
  const { root } = await fixture();
  const fake = path.join(root, "tmux.ts");
  await writeFile(fake, "setInterval(() => {}, 1000);\n");
  const { privateTmux } = await import("./support/private-tmux");
  const started = Date.now();
  expect(await privateTmux({ command: [process.execPath, fake], timeoutMs: 300 })).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("a hung tmux capture yields to the worker and fails within its deadline instead of stalling the regression job", async () => {
  const { root } = await fixture();
  const fake = path.join(root, "tmux.ts");
  await writeFile(fake, 'if (process.argv.includes("capture-pane")) setInterval(() => {}, 1000);\n');
  const { privateTmux } = await import("./support/private-tmux");
  const tmux = await privateTmux({ command: [process.execPath, fake], timeoutMs: 2_000 });
  expect(tmux).toBeDefined();
  let yielded = false;
  const timer = setTimeout(() => { yielded = true; }, 10);
  try {
    await expect(tmux!.run("capture-pane", "-p")).rejects.toThrow("no answer");
    expect(yielded).toBe(true);
  } finally { clearTimeout(timer); await tmux?.close(); }
});

test("a private server keeps a session across screen teardown and closes only its own socket", async () => {
  const { root } = await fixture();
  const fake = path.join(root, "tmux.ts"), log = path.join(root, "calls.jsonl");
  await writeFile(fake, 'import { appendFileSync } from "node:fs"; appendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + "\\n");\n');
  const { privateTmux } = await import("./support/private-tmux");
  const tmux = await privateTmux({ command: [process.execPath, fake, log] });
  expect(tmux).toBeDefined();
  try {
    for (let i = 0; i < 2; i++) {
      await tmux!.run("new-session", "-d", "-s", "screen");
      await tmux!.run("kill-session", "-t", "screen");
    }
  } finally { await tmux?.close(); }
  const calls: string[][] = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(calls[0]).toContain("keepalive");
  expect(calls.filter(args => args.includes("kill-server"))).toHaveLength(1);
  expect(calls.every(args => args[0] === "-L" && args[1] === calls[0]![1] && args[1]!.startsWith("casper-screen-") && args[2] === "-f")).toBe(true);
  await expect(stat(tmux!.home)).rejects.toMatchObject({ code: "ENOENT" });
});

test("failed tmux teardown is reported and retains a cleanup retry instead of silently leaking the server", async () => {
  const { root } = await fixture();
  const fake = path.join(root, "tmux.ts"), marker = path.join(root, "teardown-attempted");
  await writeFile(fake, 'import { existsSync, writeFileSync } from "node:fs"; if (process.argv.includes("kill-server") && !existsSync(process.argv[2])) { writeFileSync(process.argv[2], ""); console.error("teardown failed"); process.exit(1); }\n');
  const { privateTmux } = await import("./support/private-tmux");
  const tmux = await privateTmux({ command: [process.execPath, fake, marker] });
  expect(tmux).toBeDefined();
  try {
    await expect(tmux!.close()).rejects.toThrow("teardown failed");
    expect((await stat(tmux!.home)).isDirectory()).toBe(true);
  } finally { await tmux?.close(); }
  await expect(stat(tmux!.home)).rejects.toMatchObject({ code: "ENOENT" });
});

test("after a successful tmux startup a command error still fails rather than becoming a skip", async () => {
  const { root } = await fixture();
  const fake = path.join(root, "tmux.ts");
  await writeFile(fake, 'if (process.argv.includes("capture-pane")) { console.error("fixture capture failed"); process.exit(1); }\n');
  const { privateTmux } = await import("./support/private-tmux");
  const tmux = await privateTmux({ command: [process.execPath, fake] });
  expect(tmux).toBeDefined();
  try { await expect(tmux!.run("capture-pane")).rejects.toThrow("fixture capture failed"); }
  finally { await tmux?.close(); }
});
