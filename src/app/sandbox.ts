import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import type { ProjectContext } from "../project/context";
import type { RuntimeShell } from "../runtime/types";
import { casperAgentDir } from "../runtime/agent-store";
import { displayPath } from "../platform/project-paths";
import { describeSandbox, ShellSandbox, type HostAnswer, type ShellSandboxOptions, type WriteAsker } from "../sandbox/manager";
import { REGISTRY_HOSTS } from "../sandbox/policy";
import { SandboxStore } from "../sandbox/store";
import { seccompHelper } from "../sandbox/seccomp";
import type { TaskResult } from "../task/result";
import { terminalText } from "../tui/format";
import { blockedBySandbox } from "../verify/command";
import { hideCommandSecrets } from "../secrets/files";
import { remoteTargets, runsAlone, targetLabel, type RemoteTarget } from "../sandbox/remote";
import { HOST_CHOICES, REACH_CHOICES, shellCommandChoices, writeChoices, YES_ALWAYS, YES_ONCE, YES_SESSION } from "./safe-choices";
import { commandPrefix, matchesPrefix, readOnlyCommand } from "../sandbox/read-only";

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
  /** Your lab list (names or addresses): ssh to these doesn't ask, unless /lab ssh off. */
  labHosts?(): readonly string[];
}

export const hostQuestion = (host: string) => `A shell command wants to reach ${terminalText(host)}. Allow it?`;
/** A command as a question shows it: one line, with any secret the AI typed into it hidden. */
const shownCommand = (command: string) => terminalText(hideCommandSecrets(command).text).replace(/\s+/g, " ").trim();
export const shellQuestion = (command: string) => `Run this command?  ${shownCommand(command)}`;
/** "Reach 10.0.0.5 (build-server)?  ssh root@build-server uptime" */
export const reachQuestion = (target: RemoteTarget, command: string) => `Reach ${terminalText(targetLabel(target))}?  ${shownCommand(command)}`;
/** The AI reads these when a command to another machine does not run. */
export const reachCantAsk = (target: RemoteTarget) => `Not run: this command reaches ${targetLabel(target)}${target.unclear ? "" : ", another machine,"} and this run can't ask you first. Casper doesn't let the AI reach other machines without your OK. Tell the user; they can run it themselves${target.unclear ? " or in a Casper session" : `, in a Casper session, or with --allow-reach ${target.typed} for one run`}.`;
export const reachDeclined = (target: RemoteTarget) => `Not run: the user said no to reaching ${targetLabel(target)}. Don't try it again another way; ask the user what to do instead.`;
export const SHELL_CANT_ASK = "Not run: shell commands need your OK here, and this run can't ask. Use --no-sandbox to allow them for this run.";
export const SHELL_DECLINED = "Not run: the user said no to this command. Don't run it again; ask the user what to do instead.";
export const writeQuestion = (from: WriteAsker, folder: string) => `${from === "shell" ? "A shell command" : "The AI"} wants to write to ${terminalText(folder)}. Allow it?`;
/** "A and B", "A, B and C": the places one question names. */
export const writePlaces = (places: string[]) => places.length > 1 ? `${places.slice(0, -1).join(", ")} and ${places.at(-1)}` : places[0] ?? "";
export const SANDBOX_REFUSED = "The sandbox refuses this every time. Don't retry it or work around it, not with the write or edit tool either. If the task needs it, say in one line what was blocked. No helper scripts for the user to run outside Casper.";
export const writeAllowedLine = (folder: string) => `[sandbox] The user allowed writes to ${folder} for this session. Run the command again.`;
export const writeDeclined = (folder: string) => `The user said no to writing ${folder}. Don't retry it or work around it.`;
export const writeCantAsk = (folder: string) => `${folder} is outside this project and this run can't ask. To allow it for one run: --allow-write ${folder}.`;
export const PI_SANDBOX_IGNORED = "[sandbox] Ignored .pi/sandbox.json: a project can't loosen the sandbox.";

/** --allow-host, --allow-write and --allow-reach: what this run allows without asking (folders absolute). */
export interface RunAllowances { hosts?: string[]; writes?: string[]; reach?: string[] }

export function createSessionSandbox(host: SandboxHost, context: ProjectContext, options: { root: () => string; home: string; noSandbox?: boolean;
  allow?: RunAllowances; seams?: Partial<ShellSandboxOptions> }): ShellSandbox {
  const store = new SandboxStore(context.stateDirectory);
  return new ShellSandbox({
    root: options.root, home: options.home, agentDir: casperAgentDir(), settings: context.sandbox ?? {}, store,
    ...(options.noSandbox ? { noSandboxFlag: true } : {}),
    ...(options.allow?.hosts?.length ? { allowHosts: options.allow.hosts } : {}),
    ...(options.allow?.writes?.length ? { allowWrites: options.allow.writes } : {}),
    ...(options.allow?.reach?.length ? { allowReach: options.allow.reach } : {}),
    askHost: (name) => host.canAsk() ? host.pick(hostQuestion(name), [...HOST_CHOICES]).then((answer): HostAnswer =>
      answer === YES_ONCE ? "once" : answer === YES_SESSION ? "session" : answer === YES_ALWAYS ? "project" : "no") : undefined,
    askWrite: (targets, from) => {
      if (!host.canAsk()) return undefined;
      const shown = writePlaces(targets.map((target) => displayPath(target, options.root(), options.home)));
      const choices = writeChoices(shown);
      return host.pick(writeQuestion(from, shown), choices).then((answer) => answer === YES_SESSION);
    },
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
export function runtimeShell(host: SandboxHost, sandbox: ShellSandbox, given: SandboxStore): RuntimeShell & { close(): Promise<void> } {
  // The sandbox's own store when it has one, so /sandbox forget and the shell see the same answers.
  const store = sandbox.store ?? given;
  let logs: Promise<string> | undefined;
  const show = (entry: string) => displayPath(entry, sandbox.root, sandbox.home);
  /** Hosts you said "Yes, for this session" to. */
  const sessionReach = new Set<string>();
  /** With no sandbox: commands (or command prefixes) you said "Yes, for this session" to. */
  const sessionCommands = new Set<string>();
  const sessionPrefixes = new Set<string>();
  /** Commands you said yes to just now, with the hosts they reach (wrap lets them through). */
  const cleared = new Map<string, RemoteTarget[]>();
  const said = new Set<string>();
  /** --allow-reach: a machine allowed for this run, by the name the command typed or the address it resolves to. */
  // An alias from ~/.ssh/config counts by its real address too.
  const runReach = sandbox.allowedReach.flatMap((entry) => [entry.toLowerCase(), ...remoteTargets(`ssh ${entry}`, sandbox.home).map((target) => target.host)]);
  const allowedForRun = (target: RemoteTarget): boolean => runReach.includes(target.typed.toLowerCase()) || runReach.includes(target.host);
  /** A device on your lab list, by the name the command typed or the address it resolves to (unless /lab ssh off). */
  const onLabList = async (target: RemoteTarget): Promise<boolean> => {
    const lab = (host.labHosts?.() ?? []).map((entry) => entry.toLowerCase());
    if (!lab.length || !await store.labReach()) return false;
    return lab.includes(target.typed.toLowerCase()) || lab.includes(target.host);
  };
  const sayOnce = (line: string) => { if (said.has(line)) return; said.add(line); host.write(`${line}\n`); };
  /** undefined: runs (and whether the question already showed the command); a string: refused, the AI reads why. */
  const reach = async (command: string, signal?: AbortSignal): Promise<{ refused?: string; asked: boolean }> => {
    const targets = remoteTargets(command, sandbox.home);
    if (!targets.length) return { asked: false };
    let asked = false;
    for (const target of targets) {
      // A machine named as $HOST could be any machine: it always asks.
      if (!target.unclear && (sessionReach.has(target.host) || allowedForRun(target) || (await store.reachHosts()).includes(target.host) || await onLabList(target))) continue;
      if (!host.canAsk()) {
        sayOnce(`[shell] Not run: the AI's command reaches ${targetLabel(target)}, and this run can't ask you. Nothing was sent.`);
        return { refused: reachCantAsk(target), asked };
      }
      const answer = await host.pick(reachQuestion(target, command), [...REACH_CHOICES], signal);
      asked = true;
      // A machine the command names as $HOST could be any machine next time: that yes counts for this command only.
      if (answer === YES_SESSION) { if (!target.unclear) sessionReach.add(target.host); }
      else if (answer === YES_ALWAYS) { if (!target.unclear) await store.addReach(target.host); }
      else if (answer !== YES_ONCE) return { refused: reachDeclined(target), asked };
    }
    // Only the command about to run (a service start approved here never comes back to wrap).
    cleared.clear();
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
        // ssh inside the sandbox goes through its proxy only on Linux (socat); nc, telnet and socat never do.
        const proxied = sandbox.platform === "linux" && targets.every((target) => ["ssh", "scp", "sftp", "rsync"].includes(target.tool));
        sayOnce(proxied
          ? `[sandbox] ${targets.map(targetLabel).join(", ")}: this command runs in the sandbox, where your ~/.ssh keys and settings are hidden, so a login may fail. A plain ssh or scp command of its own runs with your keys.`
          : `[sandbox] ${targets.map(targetLabel).join(", ")}: direct connections like this are blocked in the sandbox, so this command can't reach it. A plain ssh or scp command of its own runs outside the sandbox with your keys.`);
      }
      return wrapped.held ? { command: wrapped.command, id: wrapped.id } : { command };
    },
    finished(id) { sandbox.finished(id); },
    async refused(id, output) {
      const reason = await blockedBySandbox(sandbox, id, output);
      if (!reason) return undefined;
      const blocked = `[sandbox] ${reason[0]!.toUpperCase()}${reason.slice(1)}.`;
      // Refused only for writes to folders Casper may offer: one question for all of them (the next command gets
      // the new policy).
      const writes = sandbox.refused(id, output).map((line) => /^wanted to write (\/.*)$/.exec(line)?.[1]);
      const folders = writes.map((file) => file === undefined ? undefined : sandbox.writeFolder(file));
      if (host.planning() || !folders.length || folders.some((folder) => folder === undefined)) return `${blocked} ${SANDBOX_REFUSED}`;
      const unique = [...new Set(folders as string[])];
      const shown = writePlaces(unique.map(show));
      const decision = await sandbox.decideWrite(unique, "shell");
      if (decision !== "allowed") return `${blocked} ${decision === "no" ? writeDeclined(shown) : writeCantAsk(shown)}`;
      for (const folder of unique) sandbox.noteOutsideAllow(folder);
      return writeAllowedLine(shown);
    },
    async outsideWrite(absolute) {
      if (!sandbox.asksOutsideWrites || sandbox.writeAllowed(absolute)) return undefined;
      const offer = sandbox.writeTarget(absolute);
      if (!offer) return `Not done: ${show(absolute)} is outside this project, and Casper doesn't let the AI write there.`;
      const decision = await sandbox.decideWrite(offer.target, "ai", { file: offer.file });
      if (decision === "allowed") return undefined;
      return `Not done: ${decision === "no" ? writeDeclined(show(offer.target)) : writeCantAsk(show(offer.target))}`;
    },
    wroteOutside(absolute) { sandbox.noteOutsideWrite(absolute); },
    async approve(command, signal, options) {
      // The host question already showed this command and you said yes, like bash's own start after a failed sandbox.
      if (options?.reached) return remoteTargets(command, sandbox.home).length ? undefined : shell.approve!(command, signal);
      const remote = await reach(command, signal);
      if (remote.refused) return remote.refused;
      if (!sandbox.asksFirst) return undefined;
      // The host question showed this command and you said yes: it is not asked twice.
      if (remote.asked) return undefined;
      // Commands that only read run without a box, like they would in the sandbox.
      if (readOnlyCommand(command, { root: sandbox.root, home: sandbox.home, denyRead: sandbox.policy().denyRead })) return undefined;
      if (sessionCommands.has(command) || [...sessionPrefixes].some((prefix) => matchesPrefix(command, prefix))) return undefined;
      if (await store.allowsCommand(command)) return undefined;
      if (!host.canAsk()) return SHELL_CANT_ASK;
      const prefix = commandPrefix(command);
      const answer = await host.pick(shellQuestion(command), shellCommandChoices(prefix), signal);
      if (answer === YES_ONCE) return undefined;
      if (answer === YES_SESSION) { if (prefix) sessionPrefixes.add(prefix); else sessionCommands.add(command); return undefined; }
      if (answer === YES_ALWAYS) { await (prefix ? store.addPrefix(prefix) : store.addCommand(command)); return undefined; }
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

/** The receipt's outside writes since the last receipt, as a person would type them: places the AI's tools
 * wrote, and folders you allowed a shell command (the sandbox can't tell whether it wrote them). */
export function outsideWritesReceipt(sandbox: ShellSandbox | undefined): Pick<TaskResult, "outsideWrites" | "outsideAllowed"> {
  if (!sandbox) return {};
  const { wrote, allowed } = sandbox.takeOutsideWrites();
  const show = (entry: string) => displayPath(entry, sandbox.root, sandbox.home);
  return { ...(wrote.length ? { outsideWrites: wrote.map(show) } : {}), ...(allowed.length ? { outsideAllowed: allowed.map(show) } : {}) };
}

/** "shell     sandboxed · writes: ..." for the banner and /status. */
export function sandboxStatusLine(sandbox: ShellSandbox): string {
  if (sandbox.failure) return `not sandboxed (the sandbox could not start: ${sandbox.failure}) · Casper asks before AI shell commands that change things`;
  return describeSandbox(sandbox.state, sandbox.on ? sandbox.allowedHosts().length : undefined);
}

/** /sandbox: what the sandbox holds, on this machine, now. `reach`: machines ssh may reach without asking. */
export function sandboxReport(sandbox: ShellSandbox, root: string, reach: readonly string[] = []): string {
  const home = sandbox.home;
  const show = (entry: string) => entry === root ? "this project" : entry.startsWith(`${home}${path.sep}`) ? `~/${path.relative(home, entry).split(path.sep).join("/")}` : entry;
  const lines = [`Shell: ${sandboxStatusLine(sandbox)}`];
  const machines = `ssh, scp and the like to other machines: Casper asks (1 No · 2 Yes, this once · 3 Yes, for this session · 4 Yes, always for this project)${reach.length ? `; always for this project: ${reach.join(", ")} (/sandbox forget <address>)` : ""}. Lab devices don't ask (/lab ssh off).`;
  if (!sandbox.on) {
    lines.push(sandbox.state.kind === "off"
      ? "Shell commands, checks, services and dev servers run with your permissions, files and network."
      : "Shell commands, checks, services and dev servers run with your permissions, files and network. The AI's shell commands ask first.");
    lines.push(machines);
    return `${lines.join("\n")}\n`;
  }
  const policy = sandbox.policy();
  lines.push(`Writes:  ${[...new Set(policy.allowWrite.map(show))].join(", ")}`);
  lines.push(`Private: ${[...new Set(policy.denyRead.map(show))].slice(0, 12).join(", ")}${policy.denyRead.length > 12 ? ` … +${policy.denyRead.length - 12} more` : ""}`);
  lines.push(`Hosts:   ${REGISTRY_HOSTS.join(", ")}, localhost${sandbox.user.allowedDomains?.length ? `; yours: ${sandbox.user.allowedDomains.join(", ")}` : ""}`);
  const remembered = sandbox.rememberedHosts();
  lines.push(`Remembered for this project: ${remembered.length ? `${remembered.join(", ")} (/sandbox forget <host>)` : "none"}`);
  lines.push("Other hosts: Casper asks (1 No · 2 Yes, this once · 3 Yes, for this session · 4 Yes, always for this project); a run that can't ask blocks them.");
  const folders = sandbox.allowedWriteFolders();
  lines.push(`Other writes outside the project: Casper asks (1 No · 2 Yes, for this session)${folders.length ? `; allowed this session: ${[...new Set(folders.map(show))].join(", ")}` : ""}.`);
  lines.push(machines);
  lines.push("Not in the sandbox: MCP servers, language servers, the debugger, the browser and lab checks.");
  return `${lines.join("\n")}\n`;
}
