import { runtimeShell } from "../app/sandbox";
import type { ShellSandbox } from "../sandbox/manager";
import type { RuntimeShell } from "../runtime/types";

/**
 * A builder's shell: the session's sandbox around its copy, as the main session's mode would run it, with nobody
 * to ask. What would ask the person (a host, a write outside the copy, a command when no sandbox can run) is not
 * run; the builder reads why and goes on, and `note` gets the line for the crew's report (as Claude Code does for
 * background helpers). Undefined when the session has no sandbox store to read your remembered answers from.
 */
export function crewShell(sandbox: ShellSandbox, copy: string, note: (line: string) => void): (RuntimeShell & { close(): Promise<void> }) | undefined {
  if (!sandbox.store) return undefined;
  const held = sandbox.forCopy(copy, note);
  const shell = runtimeShell({
    canAsk: () => false,
    pick: async () => undefined,
    write: (text) => { for (const line of text.split("\n")) if (line.trim()) note(line.trim()); },
    planning: () => false,
  }, held, sandbox.store);
  return { ...shell, close: async () => { await shell.close(); await held.close(); } };
}
