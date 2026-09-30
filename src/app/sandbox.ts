import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import type { ProjectContext } from "../project/context";
import type { RuntimeShell } from "../runtime/types";
import { casperAgentDir } from "../runtime/agent-store";
import { describeSandbox, ShellSandbox, type HostAnswer, type ShellSandboxOptions } from "../sandbox/manager";
import { REGISTRY_HOSTS } from "../sandbox/policy";
import { SandboxStore } from "../sandbox/store";
import { seccompHelper } from "../sandbox/seccomp";
import type { TaskResult } from "../task/result";
import { terminalText } from "../tui/format";
import { blockedBySandbox } from "../verify/command";
import { hideCommandSecrets } from "../secrets/files";
import { remoteTargets, runsAlone, targetLabel, type RemoteTarget } from "../sandbox/remote";
import { HOST_CHOICES, REACH_CHOICES, SHELL_COMMAND_CHOICES } from "./safe-choices";

/**
 * The session's shell sandbox, as the app uses it: the host question, the ask-only fallback for the AI's shell
 * when no sandbox can run, the lines /status, /sandbox and the receipt show. Only the user's own answer to a
 * numbered question allows a host or remembers a command; the AI can't answer these.
 */

export interface SandboxHost {
  /** Someone can answer a question now (an interactive session at a terminal, not closing). */
  canAsk(): boolean;
  pick(question: string, options: Array<{ label: string; description?: string }>, signal?: AbortSignal): Promise<string | undefined>;
  write(text: string): void;
  /** A plan turn: the project is read-only for the shell. */
  planning(): boolean;
}

export const hostQuestion = (host: string) => `A shell command wants to reach ${terminalText(host)}.`;
/** A command as a question shows it: one line, with any secret the AI typed into it hidden. */
const shownCommand = (command: string) => terminalText(hideCommandSecrets(command).text).replace(/\s+/g, " ").trim();
export const shellQuestion = (command: string) => `Run this command?  ${shownCommand(command)}`;
/** "Reach 10.0.0.5 (lab-01)?  ssh root@lab-01 uptime" */
export const reachQuestion = (target: RemoteTarget, command: string) => `Reach ${terminalText(targetLabel(target))}?  ${shownCommand(command)}`;
/** The AI reads these when a command to another machine does not run. */
export const reachCantAsk = (target: RemoteTarget) => `Not run: this command reaches ${targetLabel(target)}, another machine, and this run can't ask you first. Casper doesn't let the AI reach other machines without your OK. Tell the user; they can run it themselves or in a Casper session.`;
export const reachDeclined = (target: RemoteTarget) => `Not run: the user said no to reaching ${targetLabel(target)}. Don't try it again another way; ask the user what to do instead.`;
export const SHELL_CANT_ASK = "Not run: shell commands need your OK here, and this run can't ask. Use --no-sandbox to allow them for this run.";
export const SHELL_DECLINED = "Not run: the user said no to this command. Don't run it again; ask the user what to do instead.";
export const PI_SANDBOX_IGNORED = "[sandbox] Ignored .pi/sandbox.json: a project can't loosen the sandbox.";

export function createSessionSandbox(host: SandboxHost, context: ProjectContext, options: { root: () => string; home: string; noSandbox?: boolean;
  seams?: Partial<ShellSandboxOptions> }): ShellSandbox {
  const store = new SandboxStore(context.stateDirectory);
  return new ShellSandbox({
    root: options.root, home: options.home, agentDir: casperAgentDir(), settings: context.sandbox ?? {}, store,
    ...(options.noSandbox ? { noSandboxFlag: true } : {}),
    askHost: (name) => host.canAsk() ? host.pick(hostQuestion(name), [...HOST_CHOICES]).then((answer): HostAnswer =>
      answer === HOST_CHOICES[1].label || answer === "2" ? "session" : answer === HOST_CHOICES[2].label || answer === "3" ? "project" : "no") : undefined,
    note: (line) => host.write(`${line}\n`),
    seccompPath: () => seccompHelper({ home: options.home }),
    ...options.seams,
  });
}

/** The startup notes: a repo's own .pi/sandbox.json is never read. */
export function sandboxStartupNotes(root: string): string[] {
  return existsSync(path.join(root, ".pi", "sandbox.json")) ? [PI_SANDBOX_IGNORED] : [];
}

/** How the AI's bash runs this session (see RuntimeShell). Before a command reaches another machine (ssh, scp, sftp,
 * rsync, nc, telnet, socat) Casper asks "Reach <host>?", sandbox or not; a run that can't ask refuses it. */
export function runtimeShell(host: SandboxHost, sandbox: ShellSandbox, store: SandboxStore): RuntimeShell & { close(): Promise<void> } {
  let logs: Promise<string> | undefined;
  /** Hosts you said "Yes, for this session" to. */
  const sessionReach = new Set<string>();
  /** Commands you said yes to just now, with the hosts they reach (wrap lets them through). */
  const cleared = new Map<string, RemoteTarget[]>();
  const said = new Set<string>();
  const sayOnce = (line: string) => { if (said.has(line)) return; said.add(line); host.write(`${line}\n`); };
  /** undefined: runs (and whether the question already showed the command); a string: refused, the AI reads why. */
  const reach = async (command: string, signal?: AbortSignal): Promise<{ refused?: string; asked: boolean }> => {
    const targets = remoteTargets(command, sandbox.home);
    if (!targets.length) return { asked: false };
    let asked = false;
    for (const target of targets) {
      if (sessionReach.has(target.host)) continue;
      if (!host.canAsk()) {
        sayOnce(`[shell] Not run: the AI's command reaches ${targetLabel(target)}, and this run can't ask you. Nothing was sent.`);
        return { refused: reachCantAsk(target), asked };
      }
      const answer = await host.pick(reachQuestion(target, command), [...REACH_CHOICES], signal);
      asked = true;
      if (answer === REACH_CHOICES[2].label || answer === "3") sessionReach.add(target.host);
      else if (!(answer === REACH_CHOICES[1].label || answer === "2")) return { refused: reachDeclined(target), asked };
    }
    cleared.set(command, targets);
    return { asked };
  };
  const shell: RuntimeShell & { close(): Promise<void> } = {
    keepEnv: sandbox.user.keepEnv ?? [],
    async wrap(command, cwd) {
      const targets = cleared.get(command);
      cleared.delete(command);
      if (!sandbox.on) return { command };
      // You said yes to this ssh or scp: a plain one runs outside the sandbox, with your own keys (the sandbox hides
      // ~/.ssh), like lab checks. Anything more stays in the sandbox and may only reach the hosts you named.
      if (targets && runsAlone(command, cwd)) {
        sayOnce(`[sandbox] ${targets.map(targetLabel).join(", ")}: plain ssh and scp you allow run outside the sandbox, with your own keys.`);
        return { command };
      }
      let wrapped;
      try { wrapped = await sandbox.wrap(command, { cwd, network: "ask", ...(host.planning() ? { readOnlyProject: true } : {}) }); }
      catch (error) {
        // The sandbox failed to start on this command (it said so): from now on the AI's shell asks, this one too.
        if (!sandbox.failure) throw error;
        const refused = targets ? undefined : await shell.approve!(command);
        if (refused) throw new Error(refused);
        return { command };
      }
      if (targets && wrapped.held) {
        sandbox.allowForRun(wrapped.id, targets.flatMap((target) => [target.host, target.typed]));
        sayOnce(`[sandbox] ${targets.map(targetLabel).join(", ")}: this command runs in the sandbox, where your ~/.ssh keys and settings are hidden, so a login may fail. A plain ssh or scp command of its own runs with your keys.`);
      }
      return wrapped.held ? { command: wrapped.command, id: wrapped.id } : { command };
    },
    finished(id) { sandbox.finished(id); },
    async refused(id, output) {
      const reason = await blockedBySandbox(sandbox, id, output);
      return reason ? `[sandbox] ${reason[0]!.toUpperCase()}${reason.slice(1)}. The sandbox refuses this every time; don't retry it, and tell the user if the task needs it.` : undefined;
    },
    async approve(command, signal) {
      const remote = await reach(command, signal);
      if (remote.refused) return remote.refused;
      if (!sandbox.asksFirst) return undefined;
      // The host question showed this command and you said yes: it is not asked twice.
      if (remote.asked) return undefined;
      if (await store.hasCommand(command)) return undefined;
      if (!host.canAsk()) return SHELL_CANT_ASK;
      const answer = await host.pick(shellQuestion(command), [...SHELL_COMMAND_CHOICES], signal);
      if (answer === SHELL_COMMAND_CHOICES[1].label || answer === "2") return undefined;
      if (answer === SHELL_COMMAND_CHOICES[2].label || answer === "3") { await store.addCommand(command); return undefined; }
      return SHELL_DECLINED;
    },
    logDir() {
      logs ??= mkdtemp(path.join(os.tmpdir(), "casper-shell-")).catch(() => "");
      return logs.then((dir) => dir || undefined);
    },
    async close() { const dir = await logs; if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {}); },
  };
  return shell;
}

/** The receipt's sandbox field. */
export function sandboxReceipt(sandbox: ShellSandbox | undefined): TaskResult["sandbox"] | undefined {
  if (!sandbox) return undefined;
  if (sandbox.on) return { held: true };
  return { held: false, reason: sandbox.failure ? `the sandbox could not start: ${sandbox.failure}` : sandbox.state.reason ?? sandbox.state.kind };
}

/** "shell     sandboxed · writes: ..." for the banner and /status. */
export function sandboxStatusLine(sandbox: ShellSandbox): string {
  if (sandbox.failure) return `not sandboxed (the sandbox could not start: ${sandbox.failure}) · Casper asks before each AI shell command`;
  return describeSandbox(sandbox.state, sandbox.on ? sandbox.allowedHosts().length : undefined);
}

/** /sandbox: what the sandbox holds, on this machine, now. */
export function sandboxReport(sandbox: ShellSandbox, root: string): string {
  const home = sandbox.home;
  const show = (entry: string) => entry === root ? "this project" : entry.startsWith(`${home}${path.sep}`) ? `~/${path.relative(home, entry).split(path.sep).join("/")}` : entry;
  const lines = [`Shell: ${sandboxStatusLine(sandbox)}`];
  if (!sandbox.on) {
    lines.push(sandbox.state.kind === "off"
      ? "Shell commands, checks, services and dev servers run with your permissions, files and network."
      : "Shell commands, checks, services and dev servers run with your permissions, files and network. The AI's shell commands ask first.");
    return `${lines.join("\n")}\n`;
  }
  const policy = sandbox.policy();
  lines.push(`Writes:  ${[...new Set(policy.allowWrite.map(show))].join(", ")}`);
  lines.push(`Private: ${[...new Set(policy.denyRead.map(show))].slice(0, 12).join(", ")}${policy.denyRead.length > 12 ? ` … +${policy.denyRead.length - 12} more` : ""}`);
  lines.push(`Hosts:   ${REGISTRY_HOSTS.join(", ")}, localhost${sandbox.user.allowedDomains?.length ? `; yours: ${sandbox.user.allowedDomains.join(", ")}` : ""}`);
  const remembered = sandbox.rememberedHosts();
  lines.push(`Remembered for this project: ${remembered.length ? `${remembered.join(", ")} (/sandbox forget <host>)` : "none"}`);
  lines.push("Other hosts: Casper asks (1 No · 2 Allow for this session · 3 Always for this project); a run that can't ask blocks them.");
  lines.push("Not in the sandbox: MCP servers, language servers, the debugger, the browser and lab checks.");
  return `${lines.join("\n")}\n`;
}
