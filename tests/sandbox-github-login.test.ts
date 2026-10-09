import { afterAll, beforeAll, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionSandbox, GITHUB_LOGIN_HINT, runtimeShell, type SandboxHost } from "../src/app/sandbox";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { linuxSandboxProblem } from "../src/sandbox/linux";
import { runtimeEngine } from "../src/sandbox/runtime";
import { SandboxStore } from "../src/sandbox/store";
import { needsSandbox, sandboxAvailable } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

/**
 * The real sandbox (bubblewrap on Linux, sandbox-exec on macOS): your GitHub login in ~/.config/gh stays hidden from a
 * sandboxed command, and a plain gh command you said yes to runs outside it, with the login. A stand-in gh reads the
 * login file the way the real one does.
 */

let base = "", home = "", root = "", bin = "";
const TOKEN = `gho_${"a1".repeat(18)}`;

beforeAll(async () => {
  if (!sandboxAvailable) return;
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-github-live-")));
  home = path.join(base, "home"); root = path.join(base, "project"); bin = path.join(base, "system-bin");
  await mkdir(path.join(home, ".config", "gh"), { recursive: true });
  await writeFile(path.join(home, ".config", "gh", "hosts.yml"), `github.com:\n    oauth_token: ${TOKEN}\n    user: example\n`);
  await mkdir(root); await mkdir(bin);
  // The stand-in gh: logged in when it can read the login file (the real gh prints its token only with --show-token).
  await writeFile(path.join(bin, "gh"), [
    "#!/bin/sh",
    "if grep -q oauth_token \"$HOME/.config/gh/hosts.yml\" 2>/dev/null; then echo 'Logged in to github.com account example'; exit 0; fi",
    "echo \"failed to load config: open $HOME/.config/gh/config.yml: operation not permitted\" >&2; exit 1",
  ].join("\n"), { mode: 0o755 });
});

afterAll(async () => { if (base) await removeTempDir(base); });

function host(answers: Array<string | undefined>): SandboxHost {
  return { canAsk: () => true, pick: async () => answers.shift(), write: () => {}, planning: () => false };
}

async function exec(command: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(command, { cwd: root, shell: true, env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...env } });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => resolve({ code, out }));
  });
}

needsSandbox("a sandboxed gh can't read your login; the plain gh you said yes to runs outside the sandbox with it", async () => {
  const context = await loadProjectContext(await inspectProject(root), { homeDir: home });
  const terminal = host(["Yes, this once"]);
  const sandbox = createSessionSandbox(terminal, context, {
    root: () => root, home,
    seams: { engine: runtimeEngine(), problem: () => process.platform === "linux" ? linuxSandboxProblem() : undefined, tempDirs: [], searchPath: `${bin}:/usr/bin:/bin` },
  });
  const shell = runtimeShell(terminal, sandbox, new SandboxStore(context.stateDirectory));
  try {
    // Not plain (a pipe): held by the sandbox, where ~/.config/gh is hidden; the AI is told how to run it.
    const held = await shell.wrap("gh auth status | cat", root);
    expect(held.id).toBeDefined();
    const inside = await exec(held.command);
    expect(inside.out).not.toContain("Logged in");
    expect(inside.out).not.toContain(TOKEN);
    // As the AI's shell does: what the sandbox refused is read before the run is let go.
    const note = await shell.refused!(held.id!, inside.out);
    shell.finished!(held.id!);
    expect(note === GITHUB_LOGIN_HINT || note?.endsWith(GITHUB_LOGIN_HINT.replace(/^\[sandbox\] /, ""))).toBe(true);
    // Plain, and you said yes: it runs outside the sandbox, with your login.
    expect(await shell.approve!("gh auth status")).toBeUndefined();
    const outside = await shell.wrap("gh auth status", root);
    expect(outside.id).toBeUndefined();
    const ran = await exec(outside.command, outside.env);
    expect(ran).toEqual({ code: 0, out: "Logged in to github.com account example\n" });
  } finally { await sandbox.close(); }
});
