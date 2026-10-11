import { runtimeShell, type SandboxHost } from "../app/sandbox";
import type { ShellSandbox } from "../sandbox/manager";
import type { RuntimeShell } from "../runtime/types";

/** The main session's box a builder's command asks in, and the name its questions go by ("Builder 2"). */
export interface CrewAsk { host: SandboxHost; label: string }

/** "Run this command?  npm install" asked for a builder: "Builder 2 wants to run: npm install"; its other questions get the name in front. */
const named = (label: string, question: string) =>
  question.startsWith("Run this command?  ") ? `${label} wants to run: ${question.slice("Run this command?  ".length)}` : `${label}: ${question}`;

/**
 * A builder's shell: the session's sandbox around its copy, as the main session's mode would run it. A command that
 * needs your yes (no sandbox holds commands, a machine to reach) is asked in the session's box, named for the builder,
 * and /permissions all and your remembered answers count as for your own. A host or a write outside the copy is never
 * asked, and with `ask` unset or a run that can't ask (one-shot) nothing is: it is not run, the builder reads why and goes
 * on, and `note` gets the line for the crew's report (as Claude Code does for background helpers). Undefined when the
 * session has no sandbox store to read your remembered answers from.
 */
export function crewShell(sandbox: ShellSandbox, copy: string, note: (line: string) => void, ask?: CrewAsk): (RuntimeShell & { close(): Promise<void> }) | undefined {
  if (!sandbox.store) return undefined;
  const held = sandbox.forCopy(copy, note);
  const shell = runtimeShell({
    canAsk: () => ask?.host.canAsk() ?? false,
    pick: async (question, options, signal, settings) => ask ? ask.host.pick(named(ask.label, question), options, signal, settings) : undefined,
    write: (text) => { for (const line of text.split("\n")) if (line.trim()) note(line.trim()); },
    planning: () => false,
    ...(ask?.host.stopAsking ? { stopAsking: () => ask.host.stopAsking!() } : {}),
  }, held, sandbox.store);
  return { ...shell, close: async () => { await shell.close(); await held.close(); } };
}
