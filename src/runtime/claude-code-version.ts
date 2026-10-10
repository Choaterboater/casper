/**
 * A Claude plan sign-in through the `anthropic` provider names a Claude Code version (`user-agent: claude-cli/<v>`),
 * pinned in Pi. Anthropic refuses newer models to an old one ("Claude Code 2.1.251 does not support this model;
 * version 2.1.280 or newer is required"), so Casper names the newer of Pi's version and the Claude Code installed
 * on this computer, which keeps itself up to date. Without Claude Code here, Pi's version is sent as it is.
 */
import { spawnSync } from "node:child_process";
import { claudeExecutable } from "./claude-subscription";

const VERSION = /(\d+)\.(\d+)\.(\d+)/;

/** The newer of two `x.y.z` versions; one that doesn't parse loses. */
export function newerVersion(a: string | undefined, b: string | undefined): string | undefined {
  const [x, y] = [a, b].map((v) => VERSION.exec(v ?? "")?.slice(1).map(Number));
  if (!x) return y ? b : undefined;
  if (!y) return a;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]! ? a : b;
  return a;
}

/** `claude --version` prints `2.1.296 (Claude Code)`: the version, or undefined. */
export function parseClaudeVersion(output: string): string | undefined {
  return VERSION.exec(output)?.slice(1).join(".");
}

let installed: { version?: string } | undefined;

/** The installed Claude Code's version, asked once per run (bounded); undefined when there is none or it won't say. */
export function installedClaudeCodeVersion(run: () => string | undefined = defaultRun): string | undefined {
  installed ??= { version: parseClaudeVersion(run() ?? "") };
  return installed.version;
}

/** For tests: forget the version asked for. */
export function resetInstalledClaudeCodeVersion(): void { installed = undefined; }

function defaultRun(): string | undefined {
  const program = claudeExecutable();
  if (!program) return undefined;
  const result = spawnSync(program, ["--version"], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  return result.status === 0 ? result.stdout : undefined;
}

/** The Claude Code version Pi names for a plan sign-in (`claudeCodeVersion` in pi-ai's anthropic-messages.js).
 * tests/claude-code-version.test.ts checks it against the installed Pi, so a Pi update can't drift from it. */
export const PI_CLAUDE_CODE_VERSION = "2.1.280";

/** For a plan sign-in's request: names the installed Claude Code when it is newer than Pi's version, by setting
 * `user-agent: claude-cli/<v>` (a header here wins over Pi's). Otherwise the headers stay as they are. */
export function applyClaudeCodeVersion(headers: Record<string, string | null>, version: () => string | undefined = installedClaudeCodeVersion): void {
  const newer = newerVersion(PI_CLAUDE_CODE_VERSION, version());
  if (!newer || newer === PI_CLAUDE_CODE_VERSION) return;
  for (const name of Object.keys(headers)) if (name.toLowerCase() === "user-agent") delete headers[name];
  headers["user-agent"] = `claude-cli/${newer}`;
}
