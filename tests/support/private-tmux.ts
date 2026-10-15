import { mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { cleanEnv } from "./env";
import { removeTempDir } from "./temp-dir";
import { run as runFixture } from "./run";

/** A private server for one screen fixture. Never use sync children: they can wedge a parallel Bun worker. */
export async function privateTmux(options: { command?: string[]; timeoutMs?: number; env?: Record<string, string | undefined> } = {}) {
  const binary = process.platform === "win32" ? null : Bun.which("tmux");
  const command = options.command ?? (binary ? [binary] : undefined);
  if (!command) return undefined;
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-screen-"));
  const server = `casper-screen-${randomUUID()}`;
  const env = cleanEnv({ ...options.env, HOME: home, TERM: "xterm-256color", TMUX: undefined, TMUX_PANE: undefined, TMUX_TMPDIR: undefined });
  const call = (...args: string[]) => runFixture([...command, "-L", server, "-f", os.devNull, ...args], {
    cwd: home, env, timeoutMs: options.timeoutMs ?? 5_000,
  });
  let closed = false, started = false;
  const close = async () => {
    if (closed) return;
    try {
      const result = await call("kill-server");
      const gone = /no server running|error connecting.*No such file or directory/i.test(result.stderr);
      if (started && (result.timedOut || (result.status !== 0 && !gone))) {
        throw new Error(`private tmux teardown: ${result.timedOut ? "no answer within command deadline" : result.stderr.trim() || `exit ${result.status}`}`);
      }
    } catch (error) { if (started) throw error; }
    closed = true;
    await removeTempDir(home);
  };
  try {
    // Keep one session for the whole test: killing a screen must not race the server's exit/restart.
    const probe = await call("new-session", "-d", "-s", "keepalive", process.execPath, "-e", "setInterval(() => {}, 1000)");
    if (probe.status !== 0 || probe.timedOut) { await close(); return undefined; }
    started = true;
  } catch { await close(); return undefined; }
  return {
    home, env, server, close,
    async run(...args: string[]): Promise<string> {
      const result = await call(...args);
      if (result.status !== 0 || result.timedOut) {
        throw new Error(`private tmux ${args.join(" ")}: ${result.timedOut ? "no answer within command deadline" : result.stderr.trim() || `exit ${result.status}`}`);
      }
      return result.stdout;
    },
  };
}
