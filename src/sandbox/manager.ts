import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, rmSync, watch, type FSWatcher } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { linuxSandboxProblem, quote } from "./linux";
import { hostListed, hostName, sandboxPolicy, systemTempDirs, type SandboxPolicy, type SandboxProjectSettings, type SandboxUserSettings } from "./policy";
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

/** What a host question answered: no, for this session, or remembered for this project. */
export type HostAnswer = "no" | "session" | "project";

export interface ShellSandboxOptions {
  root: () => string;
  home?: string;
  agentDir?: string;
  platform?: NodeJS.Platform;
  settings?: { user?: SandboxUserSettings; project?: SandboxProjectSettings };
  /** --no-sandbox: the explicit opt-out, reported on the receipt. */
  noSandboxFlag?: boolean;
  /** Tests: the runtime seam and the machine check. */
  engine?: SandboxEngine;
  problem?: () => string | undefined;
  store?: SandboxStore;
  /** A numbered question about one host; undefined when nobody can answer now (one-shot, --json, piped). */
  askHost?: (host: string) => Promise<HostAnswer> | undefined;
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
  private remembered: string[] = [];
  private closed = false;
  private startError?: string;
  /** Main git folders watched for a `commondir` a command writes, with whether one was there first (yours). */
  private readonly gitGuards = new Map<string, { hadPointer: boolean; watcher?: FSWatcher }>();

  constructor(private readonly options: ShellSandboxOptions) {
    this.engine = options.engine ?? sandboxDefaults.engine?.() ?? runtimeEngine();
    this.state = ShellSandbox.detect(options);
  }

  /** Whether and why the sandbox holds commands on this machine. */
  static detect(options: Pick<ShellSandboxOptions, "platform" | "settings" | "noSandboxFlag" | "problem">): SandboxState {
    if (options.noSandboxFlag) return { kind: "off", reason: "--no-sandbox" };
    if (options.settings?.user?.off) return { kind: "off", reason: "sandbox: off in ~/.casper/config.yaml" };
    const platform = options.platform ?? process.platform;
    if (platform === "win32") return { kind: "unsupported", reason: "Windows" };
    if (platform !== "linux" && platform !== "darwin") return { kind: "unsupported", reason: platform };
    const probe = options.problem ?? sandboxDefaults.problem;
    const problem = probe ? probe()
      : platform === "linux" ? linuxSandboxProblem() : existsSync("/usr/bin/sandbox-exec") ? undefined : "sandbox-exec is missing";
    return problem ? { kind: "missing", reason: problem } : { kind: "on" };
  }

  get on(): boolean { return this.state.kind === "on" && !this.startError; }
  /** Why the sandbox failed to start on first use, if it did. */
  get failure(): string | undefined { return this.startError; }
  /** The AI's shell asks before each command: no sandbox runs here and you did not turn it off yourself. */
  get asksFirst(): boolean { return asksBeforeShell(this.state) || Boolean(this.startError); }
  get platform(): NodeJS.Platform { return this.options.platform ?? process.platform; }
  get home(): string { return this.options.home ?? os.homedir(); }
  get user(): SandboxUserSettings { return this.options.settings?.user ?? {}; }

  /** The policy a command gets now. */
  policy(options: Pick<SandboxWrapOptions, "extraWrite" | "readOnlyProject"> = {}): SandboxPolicy {
    return sandboxPolicy({
      root: this.options.root(), home: this.home, agentDir: this.options.agentDir, platform: this.platform,
      tempDirs: [...(this.options.tempDirs ?? systemTempDirs(this.platform)), ...(this.tempDir ? [this.tempDir] : [])],
      ...(this.options.settings?.user ? { user: this.options.settings.user } : {}),
      ...(this.options.settings?.project ? { project: this.options.settings.project } : {}),
      rememberedHosts: this.remembered, ...(options.extraWrite ? { extraWrite: options.extraWrite } : {}),
      ...(options.readOnlyProject ? { readOnlyProject: true } : {}),
    });
  }

  /** Hosts a command reaches without asking: the registry list, yours and this project's remembered ones. */
  allowedHosts(): string[] { return this.policy().allowedDomains; }
  rememberedHosts(): string[] { return [...this.remembered]; }

  private start(): Promise<void> {
    this.started ??= (async () => {
      this.tempDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-")));
      this.remembered = await this.options.store?.hosts().catch(() => []) ?? [];
      const seccompPath = await this.options.seccompPath?.().catch(() => undefined);
      await this.engine.initialize(this.policy(), (host, port) => this.decideHost(host, port),
        { ...(this.user.allowUnixSockets ? { allowUnixSockets: this.user.allowUnixSockets } : {}), ...(seccompPath ? { seccompPath } : {}) });
    })();
    return this.started;
  }

  /** `command` as a shell line held by the sandbox, or as it is when no sandbox can run. */
  async wrap(command: string, options: SandboxWrapOptions): Promise<WrappedCommand> {
    const id = `casper-${randomUUID()}`;
    if (!this.on || this.closed) return { command, id, held: false };
    try { await this.start(); }
    catch (error) {
      this.startError ??= error instanceof Error ? error.message.split("\n")[0]! : String(error);
      this.options.note?.(`[sandbox] The sandbox could not start (${this.startError}). Shell commands now ask first.`);
      throw new Error(`the sandbox could not start (${this.startError})`);
    }
    for (const folder of [this.options.root(), ...(options.extraWrite ?? [])]) this.guardGit(folder);
    const policy = this.policy(options);
    // Temp files land in the session's own temp folder; socat inside the sandbox listens on IPv4 when this
    // machine has no IPv6 (it would fail to start otherwise and every host would look blocked).
    const prefix = [`TMPDIR=${quote(this.tempDir!)}; export TMPDIR`, ...(IPV6_MISSING ? ["SOCAT_DEFAULT_LISTEN_IP=4; export SOCAT_DEFAULT_LISTEN_IP"] : [])].join("; ");
    const network = options.network ?? "ask";
    const wrapped = await this.engine.wrap(command, policy, { id, cwd: options.cwd, network, prefix });
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
    if (id) this.engine.finished(id);
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

  private async decideHost(host: string, port: number | undefined): Promise<boolean> {
    const name = hostName(host);
    if (this.sessionHosts.has(name) || hostListed(name, this.remembered)) return true;
    const pending = this.pendingHosts.get(name);
    if (pending) return pending;
    const decision = (async () => {
      const answer = this.options.askHost?.(name);
      if (!answer) {
        if (!this.blockedSaid.has(name)) {
          this.blockedSaid.add(name);
          this.options.note?.(`[sandbox] Blocked ${name}${port && port !== 443 && port !== 80 ? `:${port}` : ""} (this run can't ask). Allow it in a session first (Always for this project), or add it to sandbox.allowedDomains in ~/.casper/config.yaml.`);
        }
        return false;
      }
      const choice = await answer.catch((): HostAnswer => "no");
      if (choice === "no") return false;
      this.sessionHosts.add(name);
      if (choice === "project") await this.remember(name);
      return true;
    })();
    this.pendingHosts.set(name, decision);
    try { return await decision; } finally { this.pendingHosts.delete(name); }
  }

  /** "Always for this project": kept in Casper's own folder, never in the repo. */
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
    if (this.started) {
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
  if (state.kind === "unsupported") return `not sandboxed (${state.reason === "Windows" ? "Windows has no sandbox yet" : state.reason ?? "this system"}) · Casper asks before each AI shell command`;
  return `not sandboxed (${state.reason ?? "no sandbox"}) · Casper asks before each AI shell command`;
}
