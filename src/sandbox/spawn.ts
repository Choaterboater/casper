import path from "node:path";
import { quote, which } from "./linux";
import { currentSandbox, type SandboxWrapOptions, type ShellSandbox } from "./manager";

/**
 * A program and its arguments, held by the session's shell sandbox when one runs. Casper's own tool runs
 * (network checks, security tools, `uv init`) come through here; checks come through runCommandCheck and
 * services through ManagedProcess. `sandbox: false` runs it as it is (a lab check: it logs in to your
 * devices with your own SSH keys, and is started only by you).
 */
export interface SandboxedSpawn {
  file: string;
  args: string[];
  shell: boolean;
  /** Set when the sandbox holds it: ties what the sandbox refused to this run. */
  held?: { id: string; sandbox: ShellSandbox };
}

export async function sandboxedArgv(file: string, args: readonly string[], options: SandboxWrapOptions, sandbox: ShellSandbox | undefined | false = currentSandbox()): Promise<SandboxedSpawn> {
  if (!sandbox || !sandbox.on) return { file, args: [...args], shell: false };
  const wrapped = await sandbox.wrap([file, ...args].map(quote).join(" "), options);
  if (!wrapped.held) return { file, args: [...args], shell: false };
  return { file: wrapped.command, args: [], shell: true, held: { id: wrapped.id, sandbox } };
}

/** `env` with the folders that hold bwrap and socat on PATH, so a tool's narrowed PATH still starts the sandbox. */
export function sandboxPath(env: Record<string, string | undefined>, held: boolean): Record<string, string> {
  const clean = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  if (!held || process.platform === "win32") return clean;
  const parts = (clean.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const program of ["bwrap", "socat", "sandbox-exec"]) {
    const found = which(program, process.env.PATH ?? "") ?? which(program, "/usr/bin:/bin:/usr/local/bin");
    if (found && !parts.includes(path.dirname(found))) parts.push(path.dirname(found));
  }
  for (const dir of ["/usr/bin", "/bin"]) if (!parts.includes(dir)) parts.push(dir);
  return { ...clean, PATH: parts.join(path.delimiter) };
}
