import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

/**
 * A command that needs the person runs attached to Casper's real terminal: its keyboard, its screen, its size. Where
 * `script` exists (macOS, Linux) it runs inside one, so the command's output is also kept in a file in a private folder
 * (~/.casper/run, 0700) for the short tail the AI reads; what the person types is never recorded (no -k, -r, -I or -B).
 * Nothing echoes a password, so a password typed at sudo's or ssh's own prompt is not in the output either. The file is
 * removed as soon as it is read. With no `script` (Windows) the command still gets the terminal; its output isn't kept.
 */

export interface AttachedRun { exitCode: number; tail?: string }
export interface AttachOptions {
  /** The user's home: the output file goes in ~/.casper/run. */
  home: string;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  /** Where `script` is found (tests); unset: the PATH. */
  script?: string | null;
}

/** The last lines the AI reads: at most this many lines and characters. */
const TAIL_LINES = 40;
const TAIL_CHARS = 3_000;

/** Output as the screen showed it, without colours, cursor moves, overwritten progress lines or `script`'s own lines. */
export function screenTail(raw: string): string {
  const lines = stripVTControlCharacters(raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")).replace(/\r+\n/g, "\n").split("\n").map((line) => {
    let text = line.slice(line.lastIndexOf("\r") + 1);
    while (/[^\x08]\x08/.test(text)) text = text.replace(/[^\x08]\x08/g, "");
    return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trimEnd();
  });
  const kept = lines.filter((line) => !/^Script (?:started|done) on /.test(line));
  while (kept.length && !kept.at(-1)) kept.pop();
  while (kept.length && !kept[0]) kept.shift();
  const tail = kept.slice(-TAIL_LINES).join("\n");
  return tail.length > TAIL_CHARS ? `…${tail.slice(-TAIL_CHARS)}` : tail;
}

/** Run `command` with the terminal attached; resolves when it ends. */
export async function runAttached(command: string, cwd: string, env: NodeJS.ProcessEnv, options: AttachOptions): Promise<AttachedRun> {
  const platform = options.platform ?? process.platform;
  const { shell, args } = getShellConfig();
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1];
  const script = options.script === undefined ? (platform === "win32" ? null : Bun.which("script", pathValue ? { PATH: pathValue } : {})) : options.script;
  if (!script) return { exitCode: await attached(shell, [...args, command], cwd, env, options.signal) };
  const base = path.join(options.home, ".casper", "run");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(path.join(base, "term-"));
  try {
    await chmod(dir, 0o700);
    const log = path.join(dir, "out"), code = path.join(dir, "code");
    // The command and its shell reach the inner sh by name, never spliced into its text; they are unset before it runs.
    const inner = 'c=$CASPER_RUN; s=$CASPER_RUN_SHELL; f=$CASPER_RUN_CODE; unset CASPER_RUN CASPER_RUN_SHELL CASPER_RUN_CODE; '
      + 'if [ -n "$CASPER_SHELL_WAS" ]; then SHELL=$CASPER_SHELL_WAS; export SHELL; fi; unset CASPER_SHELL_WAS; '
      + '"$s" -c "$c"; printf %s "$?" > "$f"';
    const runEnv = { ...env, CASPER_RUN: command, CASPER_RUN_SHELL: shell, CASPER_RUN_CODE: code };
    // util-linux and BusyBox `script` run -c with $SHELL; BSD's (macOS) takes the program and its arguments.
    const linux = platform === "linux";
    const exit = await attached(script, linux ? ["-q", "-c", inner, log] : ["-q", log, "/bin/sh", "-c", inner], cwd,
      linux ? { ...runEnv, SHELL: "/bin/sh", ...(env.SHELL ? { CASPER_SHELL_WAS: env.SHELL } : {}) } : runEnv, options.signal);
    const written = Number.parseInt(await readFile(code, "utf8").catch(() => ""), 10);
    const output = await readFile(log, "utf8").catch(() => "");
    return { exitCode: Number.isInteger(written) ? written : exit, tail: screenTail(output) };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

function attached(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: "inherit" });
    const stop = () => { try { child.kill("SIGTERM"); } catch { /* gone */ } };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.once("error", (error) => { signal?.removeEventListener("abort", stop); reject(error); });
    child.once("exit", (code, name) => {
      signal?.removeEventListener("abort", stop);
      resolve(code ?? (name ? 128 + (({ SIGINT: 2, SIGKILL: 9, SIGTERM: 15, SIGHUP: 1 } as Record<string, number>)[name] ?? 0) : 1));
    });
  });
}
