import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync, watch, type FSWatcher } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { linuxSandboxProblem, quote, ripgrepPath } from "./linux";
import { gitDirs, realpathLongest, within } from "../platform/project-paths";
import { hostListed, hostName, sandboxPolicy, systemTempDirs, writeFileToOffer, writeFolderToOffer, type SandboxPolicy, type SandboxProjectSettings, type SandboxUserSettings } from "./policy";
import { runtimeEngine, type SandboxEngine } from "./runtime";
import type { SandboxStore } from "./store";

/**
 * The shell sandbox for one session. Every shell path asks it to wrap a command: the AI's bash, checks
 * (proof and trace copies too), services, dev servers, lab and network checks, security tools and `casper new`.
 * When it can't run (Windows, bubblewrap missing, --no-sandbox), `wrap` returns the command as it is and the
 * state says why; the AI's shell then asks before each command instead (see src/runtime/pi.ts).
 */

export type SandboxKind = "on" | "missing" | "unsupported" | "off";
export interface SandboxState { kind: SandboxKind; reason?: string }

/** ask: listed hosts, others asked about (or refused when nobody can answer); host: the machine's own network
 * (dev servers and services the host must reach, lab checks); none: no network at all. */
export type SandboxNetwork = "ask" | "host" | "none";

export interface SandboxWrapOptions {
  cwd: string;
  network?: SandboxNetwork;
  /** Folders this command may also write (a new project's folder). */
  extraWrite?: string[];
  /** The project is read-only too (a plan turn). */
  readOnlyProject?: boolean;
}

export interface WrappedCommand {
  /** A shell line to run with `sh -c` (or Pi's bash). */
  command: string;
  /** Ties what the sandbox refused to this run. */
  id: string;
  /** False when no sandbox holds it. */
  held: boolean;
}

/** What a host question answered: no, this connection only, for this session, or remembered for this project. */
export type HostAnswer = "no" | "once" | "session" | "project";

/** Who wants to write outside the project: a shell command, or the AI's own edit and write tools. */
export type WriteAsker = "shell" | "ai";
/** What a write question came to: allowed for this session, no, or nobody could answer (refused, no question). */
/** "once": allowed for this one write (the AI's tools) or the next command (the shell), not kept. */
export type WriteDecision = "allowed" | "once" | "no" | "cant-ask";

export interface ShellSandboxOptions {
  root: () => string;
  home?: string;
  agentDir?: string;
  platform?: NodeJS.Platform;
  settings?: { user?: SandboxUserSettings; project?: SandboxProjectSettings };
  /** --no-sandbox: the explicit opt-out, reported on the receipt. */
  noSandboxFlag?: boolean;
  /** --allow-host and --allow-write: hosts and absolute folders allowed for this run, as if you said yes for the session. */
  allowHosts?: string[];
  allowWrites?: string[];
  /** --allow-reach: machines the AI's ssh and scp may reach for this run (the shell's Reach question reads this). */
  allowReach?: string[];
  /** Tests: the runtime seam and the machine check. */
  engine?: SandboxEngine;
  problem?: () => string | undefined;
  store?: SandboxStore;
  /** A numbered question about one host; undefined when nobody can answer now (one-shot, --json, piped). */
  askHost?: (host: string) => Promise<HostAnswer> | undefined;
  /** One numbered question about writes to folders (or, for the AI's tools, one file) outside the project (true
   * allows them for this session); undefined when nobody can answer now. Never remembered past the session. */
  /** true: for this session; "once": this one write or the next command. */
  askWrite?: (targets: string[], from: WriteAsker) => Promise<boolean | "once"> | undefined;
  /** Plain lines for the user ([sandbox] ...). */
  note?: (line: string) => void;
  /** The temp folders commands may write; the system's by default. */
  tempDirs?: string[];
  /** The compiled binary's own apply-seccomp helper (Linux). */
  seccompPath?: () => Promise<string | undefined>;
}

/** Test seams for the whole process: the engine and machine check a ShellSandbox uses when none is given.
 * Casper itself never sets them; tests/support/preload.ts makes the suite's default hold nothing. */
export const sandboxDefaults: { engine?: () => SandboxEngine; problem?: () => string | undefined } = {};

/** The session's sandbox, for spawn paths that are not handed one (checks, services, tools). Set by the app while
 * a session is open. */
let current: ShellSandbox | undefined;
export function currentSandbox(): ShellSandbox | undefined { return current; }
export function useSandbox(sandbox: ShellSandbox | undefined): void { current = sandbox; }

const IPV6_MISSING = process.platform === "linux" && !existsSync("/proc/net/if_inet6");

export class ShellSandbox {
  readonly state: SandboxState;
  private readonly engine: SandboxEngine;
  private started?: Promise<void>;
  private tempDir?: string;
  private readonly sessionHosts = new Set<string>();
  private readonly pendingHosts = new Map<string, Promise<boolean>>();
  private readonly blockedSaid = new Set<string>();
  /** Hosts you said yes to for one command (ssh to a host you named), until that command ends. */
  private readonly runHosts = new Map<string, string[]>();
  private remembered: string[] = [];
  /** Folders outside the project you allowed writes to, this session only (the shell's and the AI's tools'). */
  private readonly sessionWrites: string[] = [];
  /** Single files outside the project you allowed the AI's edit and write tools, this session (not the shell's). */
  private readonly sessionFiles: string[] = [];
  /** Folders you allowed "Yes, this once" for a shell command: the next command only. */
  private readonly nextWrites: string[] = [];
  /** Places you allowed "Yes, this once" for the AI's tools, until its write is noted on the receipt. */
  private readonly onceTargets: string[] = [];
  private readonly pendingWrites = new Map<string, Promise<WriteDecision>>();
  /** Allowed places the AI's tools wrote, and folders you allowed a shell command, since the last receipt. */
  private readonly wroteOutside = new Set<string>();
  private readonly allowedOutside = new Set<string>();
  private closed = false;
  private startError?: string;
  /** Main git folders watched for a `commondir` a command writes, with whether one was there first (yours). */
  private readonly gitGuards = new Map<string, { hadPointer: boolean; watcher?: FSWatcher }>();
  /** A crew copy's sandbox: the session's, whose runtime it shares, and your folder's private paths. */
  private parent?: ShellSandbox;
  private parentDenyRead: string[] = [];
  /** The session's sandbox: builders' commands running now, by run id. */
  private readonly crewRuns = new Map<string, ShellSandbox>();
  /** The exec lines in git's to-do files when each running command started, by run id. */
  private readonly todoExecs = new Map<string, Map<string, Set<string>>>();

  constructor(private readonly options: ShellSandboxOptions) {
    this.engine = options.engine ?? sandboxDefaults.engine?.() ?? runtimeEngine();
    this.state = ShellSandbox.detect(options);
    for (const host of options.allowHosts ?? []) this.sessionHosts.add(hostName(host));
    for (const folder of options.allowWrites ?? []) this.sessionWrites.push(realpathLongest(path.resolve(folder)));
  }

  /**
   * The same sandbox around a crew copy: its root (where commands may write) is the copy, and nobody can be asked,
   * so a host or a write outside the copy that would ask is refused instead. Your settings, your private paths and
   * the hosts you allowed still count. Git's folder it shares with yours stays read-only (your branches, commits).
   * It shares this sandbox's runtime (there is one per process): closing it leaves yours running.
   */
  forCopy(root: string, note: (line: string) => void = () => {}): ShellSandbox {
    const copy = new ShellSandbox({ ...this.options, engine: this.engine, root: () => root, askHost: () => undefined, askWrite: () => undefined, note });
    copy.parent = this;
    copy.parentDenyRead = this.policy().denyRead;
    return copy;
  }

  /** Whether and why the sandbox holds commands on this machine. */
  static detect(options: Pick<ShellSandboxOptions, "platform" | "settings" | "noSandboxFlag" | "problem" | "agentDir">): SandboxState {
    if (options.noSandboxFlag) return { kind: "off", reason: "--no-sandbox" };
    if (options.settings?.user?.off) return { kind: "off", reason: `sandbox: off in ${options.settings.user.offSource ?? "~/.casper/config.yaml"}` };
    const platform = options.platform ?? process.platform;
    if (platform === "win32") return { kind: "unsupported", reason: "Windows" };
    if (platform !== "linux" && platform !== "darwin") return { kind: "unsupported", reason: platform };
    const probe = options.problem ?? sandboxDefaults.problem;
    const problem = probe ? probe()
      : platform === "linux" ? linuxSandboxProblem(undefined, options.agentDir ? { agentDir: options.agentDir } : {}) : existsSync("/usr/bin/sandbox-exec") ? undefined : "sandbox-exec is missing";
    return problem ? { kind: "missing", reason: problem } : { kind: "on" };
  }

  get on(): boolean { return this.state.kind === "on" && !this.startError; }
  /** Why the sandbox failed to start on first use, if it did. */
  get failure(): string | undefined { return this.startError; }
  /** The AI's shell asks before each command: no sandbox runs here and you did not turn it off yourself. */
  get asksFirst(): boolean { return asksBeforeShell(this.state) || Boolean(this.startError); }
  get platform(): NodeJS.Platform { return this.options.platform ?? process.platform; }
  get home(): string { return this.options.home ?? os.homedir(); }
  get root(): string { return this.options.root(); }
  /** The AI's edits and writes outside the project ask first, unless you turned the sandbox off
   * (--no-sandbox, sandbox: off): then they go through as before. */
  get asksOutsideWrites(): boolean { return this.state.kind !== "off"; }
  get user(): SandboxUserSettings { return this.options.settings?.user ?? {}; }
  /** --allow-reach: machines allowed for this run. */
  get allowedReach(): readonly string[] { return this.options.allowReach ?? []; }
  /** What this project's answers keep in ~/.casper (hosts, machines ssh may reach, commands). */
  get store(): SandboxStore | undefined { return this.options.store; }

  /** The policy a command gets now. */
  policy(options: Pick<SandboxWrapOptions, "extraWrite" | "readOnlyProject"> = {}): SandboxPolicy {
    return sandboxPolicy({
      root: this.options.root(), home: this.home, agentDir: this.options.agentDir, platform: this.platform,
      tempDirs: [...(this.options.tempDirs ?? systemTempDirs(this.platform)), ...(this.tempDir ? [this.tempDir] : [])],
      ...(this.options.settings?.user ? { user: this.options.settings.user } : {}),
      ...(this.options.settings?.project ? { project: this.options.settings.project } : {}),
      rememberedHosts: this.remembered, sessionWrites: [...this.sessionWrites, ...this.nextWrites], ...(options.extraWrite ? { extraWrite: options.extraWrite } : {}),
      ...(options.readOnlyProject ? { readOnlyProject: true } : {}),
      ...(this.parent ? { copy: true, denyRead: this.parentDenyRead } : {}),
    });
  }

  /** Hosts a command reaches without asking: the registry list, yours and this project's remembered ones. */
  allowedHosts(): string[] { return this.policy().allowedDomains; }
  rememberedHosts(): string[] { return [...this.remembered]; }

  private start(): Promise<void> {
    this.started ??= (async () => {
      const parent = this.parent;
      // A copy's commands go through the session's proxy: the runtime is one per process.
      if (parent) await parent.start();
      this.tempDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-")));
      if (parent) { this.remembered = parent.remembered; return; }
      this.remembered = await this.options.store?.hosts().catch(() => []) ?? [];
      const seccompPath = await this.options.seccompPath?.().catch(() => undefined);
      // On Linux the runtime scans the project with ripgrep: the one on PATH, or Pi's own copy.
      const ripgrep = this.platform === "linux" ? ripgrepPath(undefined, this.options.agentDir) : undefined;
      await this.engine.initialize(this.policy(), (host, port) => this.decideHost(host, port),
        { ...(this.user.allowUnixSockets ? { allowUnixSockets: this.user.allowUnixSockets } : {}), ...(seccompPath ? { seccompPath } : {}), ...(ripgrep ? { ripgrep } : {}) });
    })();
    return this.started;
  }

  /** `command` as a shell line held by the sandbox, or as it is when no sandbox can run. */
  async wrap(command: string, options: SandboxWrapOptions): Promise<WrappedCommand> {
    const id = `casper-${randomUUID()}`;
    if (!this.on || this.closed) return { command, id, held: false };
    if (this.parent?.closed) throw new Error("the session's sandbox is closed");
    try { await this.start(); }
    catch (error) {
      this.startError ??= error instanceof Error ? error.message.split("\n")[0]! : String(error);
      this.options.note?.(`[sandbox] The sandbox could not start (${this.startError}). Shell commands now ask first.`);
      throw new Error(`the sandbox could not start (${this.startError})`);
    }
    const folders = [this.options.root(), ...(options.extraWrite ?? [])];
    for (const folder of folders) this.guardGit(folder);
    this.todoExecs.set(id, todoExecs(folders));
    const policy = this.policy(options);
    // "Yes, this once" for a shell write: this command may write there, the one after asks again.
    this.nextWrites.length = 0;
    // Temp files land in the session's own temp folder; socat inside the sandbox listens on IPv4 when this
    // machine has no IPv6 (it would fail to start otherwise and every host would look blocked).
    const prefix = [`TMPDIR=${quote(this.tempDir!)}; export TMPDIR`, ...(IPV6_MISSING ? ["SOCAT_DEFAULT_LISTEN_IP=4; export SOCAT_DEFAULT_LISTEN_IP"] : [])].join("; ");
    const network = options.network ?? "ask";
    const wrapped = await this.engine.wrap(command, policy, { id, cwd: options.cwd, network, prefix });
    this.parent?.crewRuns.set(id, this);
    return { command: IPV6_MISSING && network === "ask" && wrapped !== command ? `SOCAT_DEFAULT_LISTEN_IP=4; export SOCAT_DEFAULT_LISTEN_IP; ${wrapped}` : wrapped, id, held: true };
  }

  /**
   * A main `.git` folder never has a `commondir` (only a worktree's folder does): one that appears while the
   * sandbox runs was written by a command, and it would point git (yours, and Casper's own git outside the
   * sandbox) at another folder's settings and hooks. It is removed as soon as it appears, and said. A missing
   * file can't be held read-only without breaking git, so it is watched instead.
   */
  guardGit(folder: string): void {
    const dotGit = path.join(folder, ".git");
    const pointer = path.join(dotGit, "commondir");
    const present = () => { try { lstatSync(pointer); return true; } catch { return false; } };
    let guard = this.gitGuards.get(dotGit);
    if (!guard) {
      try { if (!lstatSync(dotGit).isDirectory()) return; } catch { return; }
      guard = { hadPointer: present() };
      this.gitGuards.set(dotGit, guard);
      if (!guard.hadPointer) {
        try {
          guard.watcher = watch(dotGit, (_event, name) => { if (!name || String(name) === "commondir") this.guardGit(folder); });
          guard.watcher.on("error", () => {});
          guard.watcher.unref();
        } catch { /* checked before each command instead */ }
      }
    }
    if (guard.hadPointer || this.closed || !present()) return;
    try {
      rmSync(pointer, { force: true, recursive: true });
      this.options.note?.(`[sandbox] Removed ${pointer}: a command wrote it, and it would point git at another folder's settings and hooks.`);
    } catch { /* gone meanwhile */ }
  }

  /** Run `id` has ended: the sandbox cleans up after it (see SandboxEngine.finished). Safe to call more than once. */
  finished(id: string | undefined): void {
    if (id) { this.runHosts.delete(id); this.parent?.crewRuns.delete(id); this.engine.finished(id); this.sayNewExecs(id); }
    // A commondir the run wrote is gone when it ends, even if the watch missed it (macOS can drop an event that
    // comes just after a watch starts).
    for (const dotGit of this.gitGuards.keys()) this.guardGit(path.dirname(dotGit));
  }

  /**
   * git runs a to-do's exec lines on the next `git rebase --continue` (or cherry-pick's), which you run outside the
   * sandbox. git writes the to-do itself, so a command's text can't show one being added: each line a command
   * added is said once. Not removed, so the AI's own `git rebase --exec` keeps working.
   */
  private sayNewExecs(id: string): void {
    const before = this.todoExecs.get(id);
    if (!before) return;
    this.todoExecs.delete(id);
    const folders = [...new Set([...this.gitGuards.keys()].map((dotGit) => path.dirname(dotGit)).concat(this.options.root()))];
    for (const [file, lines] of todoExecs(folders)) {
      const added = [...lines].filter((line) => !before.get(file)?.has(line));
      if (!added.length) continue;
      const shown = added.map((line) => line.length > 120 ? `${line.slice(0, 117)}...` : line).join("; ");
      this.options.note?.(`[sandbox] A command added to git's to-do (${file}): ${shown}. git runs it outside the sandbox on your next --continue, so look at it first.`);
    }
  }

  /** You said yes to these hosts for the command `id` (Casper's own "Reach <host>?" question): the proxy lets that
   * command reach them without asking again, until it ends. */
  allowForRun(id: string, hosts: string[]): void {
    this.runHosts.set(id, hosts.map(hostName));
  }

  /** What the sandbox refused for run `id`, in plain words: "wanted to write /etc/hosts", "wanted to reach api.mist.com".
   * On Linux's own bubblewrap line there is no monitor, so a read-only-file-system error names the file instead. */
  refused(id: string, output = ""): string[] {
    const plain = new Set<string>();
    for (const line of this.engine.violations(id)) {
      const network = /network-outbound\s+(\S+?)(?::\d+)?(?:\s|$)/.exec(line);
      if (network) { plain.add(`wanted to reach ${network[1]}`); continue; }
      // macOS: "deny(1) file-read-data /Users/me/.ssh/id"; Linux reports only writes: "deny openat /etc/hosts".
      const mac = /deny(?:\(\d+\))?\s+file-(read|write)[\w-]*\s+(\/\S*)/.exec(line);
      if (mac) { plain.add(`wanted to ${mac[1]} ${mac[2]}`); continue; }
      const file = /^deny\s+\S+\s+(\/\S*)/.exec(line.trim());
      // Kernel and device files programs probe on their own (Bun opens a tracing marker): not what a check tried.
      if (file && /^\/(?:proc|sys|dev)\//.test(file[1]!)) continue;
      plain.add(file ? `wanted to write ${file[1]}` : line.trim().slice(0, 120));
    }
    if (!plain.size) {
      for (const match of output.matchAll(/(?:^|\s|')(\/[^\s:'"]+)'?:?\s*Read-only file system|Read-only file system:\s*'(\/[^']+)'/gm)) {
        const file = match[1] ?? match[2];
        if (file) plain.add(`wanted to write ${file}`);
      }
    }
    return [...plain].slice(0, 3);
  }

  /** "blocked by the sandbox (wanted to write /etc/hosts)", or undefined when it refused nothing. */
  blockedReason(id: string, output = ""): string | undefined {
    const refused = this.refused(id, output);
    return refused.length ? `blocked by the sandbox (${refused.join("; ")})` : undefined;
  }

  /** True when a command or the AI's file tools may write `absolute` without a question: where it really lands
   * (through links) is in the policy's writable places (temp, package caches, your sandbox.allowWrite, what you
   * allowed this session), and no spelling of it is denied. A link in temp to elsewhere still asks. */
  writeAllowed(absolute: string): boolean {
    const policy = this.policy();
    const real = realpathLongest(absolute);
    const names = [...new Set([path.resolve(absolute), real])];
    const allowed = policy.allowWrite.some((place) => within(place, real)) || this.sessionFiles.includes(real);
    return allowed && !policy.denyWrite.some((place) => names.some((name) => within(place, name)));
  }

  /** The folder a write question offers for `absolute` (its nearest existing parent), or undefined when that is a
   * place Casper never offers (see writeFolderToOffer): those stay refused without a question. */
  writeFolder(absolute: string): string | undefined {
    return writeFolderToOffer(absolute, this.policy(), { root: this.options.root(), home: this.home });
  }

  /** For the AI's edit and write tools: that folder, or else the file itself (see writeFileToOffer). */
  writeTarget(absolute: string): { target: string; file: boolean } | undefined {
    const folder = this.writeFolder(absolute);
    if (folder) return { target: folder, file: false };
    const file = writeFileToOffer(absolute, this.policy(), { root: this.options.root(), home: this.home });
    return file ? { target: file, file: true } : undefined;
  }

  /** Folders and files allowed this session, for /sandbox. */
  allowedWriteFolders(): string[] { return [...this.sessionWrites, ...this.sessionFiles]; }

  private writeTargetAllowed(target: string): boolean {
    return this.sessionWrites.some((entry) => within(entry, target)) || this.sessionFiles.includes(target);
  }

  /** One question for what is not allowed yet (several folders of one command share it): calls at the same time
   * share it too, and an allowed place never asks again this session. A run that can't ask refuses at once.
   * `file` (the AI's tools only) allows the one file, not its folder, and never the shell. */
  async decideWrite(targets: string | string[], from: WriteAsker, options: { file?: boolean } = {}): Promise<WriteDecision> {
    const left = [...new Set(typeof targets === "string" ? [targets] : targets)].filter((target) => !this.writeTargetAllowed(target));
    if (!left.length) return "allowed";
    const key = `${options.file ? "file" : "folder"}\0${left.join("\0")}`;
    const pending = this.pendingWrites.get(key);
    if (pending) return pending;
    const decision = (async (): Promise<WriteDecision> => {
      const answer = this.options.askWrite?.(left, from);
      if (!answer) return "cant-ask";
      const given = await answer.catch(() => false);
      if (!given) return "no";
      if (given === "once") { this.onceTargets.push(...left); return "once"; }
      const list = options.file ? this.sessionFiles : this.sessionWrites;
      for (const target of left) if (!list.includes(target)) list.push(target);
      return "allowed";
    })();
    this.pendingWrites.set(key, decision);
    try { return await decision; } finally { this.pendingWrites.delete(key); }
  }

  /** The AI's edit or write went through at `absolute`, outside the project: the receipt names its allowed place. */
  noteOutsideWrite(absolute: string): void {
    const real = realpathLongest(absolute);
    const place = this.sessionFiles.find((entry) => entry === real) ?? this.sessionWrites.find((entry) => within(entry, real))
      ?? this.onceTargets.find((entry) => entry === real || within(entry, real));
    if (place) this.wroteOutside.add(place);
    const once = this.onceTargets.indexOf(place ?? "");
    if (once >= 0) this.onceTargets.splice(once, 1);
  }

  /** You allowed a shell command to write `folder`: the receipt says allowed, not written (the sandbox can't tell). */
  noteOutsideAllow(folder: string): void { this.allowedOutside.add(folder); }

  /** "Yes, this once" for a shell write: the next command may write these folders, then they ask again. */
  allowNextCommand(folders: readonly string[]): void {
    for (const folder of folders) {
      if (!this.nextWrites.includes(folder)) this.nextWrites.push(folder);
      const once = this.onceTargets.indexOf(folder);
      if (once >= 0) this.onceTargets.splice(once, 1);
    }
  }

  /** What one task's receipt says since the last call: places written, and folders only allowed. */
  takeOutsideWrites(): { wrote: string[]; allowed: string[] } {
    const wrote = [...this.wroteOutside];
    const allowed = [...this.allowedOutside].filter((folder) => !this.wroteOutside.has(folder));
    this.wroteOutside.clear(); this.allowedOutside.clear();
    return { wrote, allowed };
  }

  private async decideHost(host: string, port: number | undefined): Promise<boolean> {
    const name = hostName(host);
    if (this.sessionHosts.has(name) || hostListed(name, this.remembered)) return true;
    for (const hosts of this.runHosts.values()) if (hosts.includes(name)) return true;
    const pending = this.pendingHosts.get(name);
    if (pending) return pending;
    const decision = (async () => {
      // The proxy can't tell whose command reaches out: while a builder's runs, nobody is asked.
      const builders = new Set(this.crewRuns.values());
      if (builders.size) {
        if (!this.blockedSaid.has(`crew\0${name}`)) {
          this.blockedSaid.add(`crew\0${name}`);
          const line = `[sandbox] Blocked ${name} (a crew is running, so nobody is asked). To allow it: --allow-host ${name}, or Yes, always for this project in a session.`;
          this.options.note?.(line);
          for (const builder of builders) builder.options.note?.(line);
        }
        return false;
      }
      const answer = this.options.askHost?.(name);
      if (!answer) {
        if (!this.blockedSaid.has(name)) {
          this.blockedSaid.add(name);
          this.options.note?.(`[sandbox] Blocked ${name}${port && port !== 443 && port !== 80 ? `:${port}` : ""} (this run can't ask). To allow it for one run: --allow-host ${name}. Or allow it in a session (Yes, always for this project).`);
        }
        return false;
      }
      const choice = await answer.catch((): HostAnswer => "no");
      if (choice === "no") return false;
      if (choice === "once") return true;
      this.sessionHosts.add(name);
      if (choice === "project") await this.remember(name);
      return true;
    })();
    this.pendingHosts.set(name, decision);
    try { return await decision; } finally { this.pendingHosts.delete(name); }
  }

  /** "Yes, always for this project": kept in Casper's own folder, never in the repo. */
  async remember(host: string): Promise<void> {
    const name = hostName(host);
    await this.options.store?.addHost(name);
    if (!this.remembered.includes(name)) this.remembered.push(name);
    this.engine.setAllowedHosts(this.policy().allowedDomains);
  }

  /** /sandbox forget <host>. */
  async forget(host: string): Promise<boolean> {
    const name = hostName(host);
    this.sessionHosts.delete(name);
    const was = this.remembered.includes(name);
    this.remembered = this.remembered.filter((entry) => entry !== name);
    const stored = await this.options.store?.forgetHost(name) ?? false;
    this.engine.setAllowedHosts(this.policy().allowedDomains);
    return was || stored;
  }

  async loadRemembered(): Promise<void> { this.remembered = await this.options.store?.hosts().catch(() => []) ?? this.remembered; }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const [dotGit, guard] of this.gitGuards) {
      guard.watcher?.close();
      if (!guard.hadPointer) this.guardGit(path.dirname(dotGit));
    }
    this.closed = true;
    if (this.parent) for (const [id, owner] of this.parent.crewRuns) if (owner === this) this.parent.crewRuns.delete(id);
    if (this.started && !this.parent) {
      await this.started.catch(() => {});
      await this.engine.reset().catch(() => {});
    }
    if (this.tempDir) await rm(this.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Whether the AI's shell asks before each command: no sandbox can run here, and you did not turn it off yourself. */
export function asksBeforeShell(state: SandboxState): boolean {
  return state.kind === "missing" || state.kind === "unsupported";
}

/** The shell line of the status and the banner. */
export function describeSandbox(state: SandboxState, hosts?: number): string {
  if (state.kind === "on") return `sandboxed · writes: this project, temp, package caches${hosts !== undefined ? ` · hosts: ${hosts} listed` : ""} (/sandbox)`;
  if (state.kind === "off") return `not sandboxed (${state.reason ?? "off"})`;
  if (state.kind === "unsupported") return `not sandboxed (${state.reason === "Windows" ? "Windows has no sandbox yet" : state.reason ?? "this system"}) · Casper asks before AI shell commands that change things`;
  return `not sandboxed (${state.reason ?? "no sandbox"}) · Casper asks before AI shell commands that change things`;
}

/** git's to-do files that can hold exec lines: a rebase's and a cherry-pick or revert's. */
const TODO_FILES = [["rebase-merge", "git-rebase-todo"], ["sequencer", "todo"]];

/** The exec (x) lines in each to-do file of these folders' git folders. */
function todoExecs(folders: readonly string[]): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const dir of new Set(folders.flatMap((folder) => gitDirs(folder)))) {
    for (const parts of TODO_FILES) {
      const file = path.join(dir, ...parts);
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(?:exec|x)\s/.test(line));
      if (lines.length) found.set(file, new Set(lines));
    }
  }
  return found;
}
