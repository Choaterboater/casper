import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hostName } from "./policy";
import { matchesPrefix } from "./read-only";

/**
 * What you told the sandbox to remember for one project, kept in Casper's own folder
 * (~/.casper/projects/<id>/), never in the repo: hosts ("Yes, always for this project"), machines the AI's ssh may
 * reach without asking (the same answer in the Reach box), whether ssh to your lab devices asks (/lab ssh off|on)
 * and, when no sandbox can run, exact shell commands you said not to ask about again; the kinds of plain git and gh command
 * (`git push`, `gh pr create`) that run outside the sandbox with your GitHub login without asking. Private (0600), written only from your
 * own answer to a numbered question. The sandbox keeps the AI's shell from reading or writing this folder.
 */
interface StoreFile { version: 1; hosts: string[]; commands: string[]; prefixes?: string[]; reach?: string[]; labReach?: false; writes?: string[]; checksOutside?: true; github?: string[] }

/** One thing you said yes to: a command and anything after it (prefix) or exactly that command. */
export interface AllowedEntry { kind: "prefix" | "command" | "checks" | "github"; value: string; session: boolean }

/** The /allowed line for "Yes, always for this project" to running its checks outside the sandbox. */
export const CHECKS_OUTSIDE_ENTRY = "run this project's checks outside the sandbox";

const MAX_ENTRIES = 500;

export class SandboxStore {
  private cached?: StoreFile;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  get file(): string { return path.join(this.directory, "sandbox.json"); }

  async load(): Promise<StoreFile> {
    if (this.cached) return this.cached;
    let data: StoreFile = { version: 1, hosts: [], commands: [] };
    try {
      // A link here is not Casper's own file: read nothing through it.
      if (!(await lstat(this.file)).isFile()) throw new Error("not a file");
      const value = JSON.parse(await readFile(this.file, "utf8")) as Partial<StoreFile>;
      if (value.version === 1) data = {
        version: 1,
        hosts: Array.isArray(value.hosts) ? value.hosts.filter((host): host is string => typeof host === "string").slice(0, MAX_ENTRIES) : [],
        commands: Array.isArray(value.commands) ? value.commands.filter((command): command is string => typeof command === "string").slice(0, MAX_ENTRIES) : [],
        ...(Array.isArray(value.prefixes) ? { prefixes: value.prefixes.filter((prefix): prefix is string => typeof prefix === "string").slice(0, MAX_ENTRIES) } : {}),
        ...(Array.isArray(value.reach) ? { reach: value.reach.filter((host): host is string => typeof host === "string").slice(0, MAX_ENTRIES) } : {}),
        ...(value.labReach === false ? { labReach: false as const } : {}),
        ...(Array.isArray(value.writes) ? { writes: value.writes.filter((folder): folder is string => typeof folder === "string").slice(0, MAX_ENTRIES) } : {}),
        ...(value.checksOutside === true ? { checksOutside: true as const } : {}),
        ...(Array.isArray(value.github) ? { github: value.github.filter((action): action is string => typeof action === "string").slice(0, MAX_ENTRIES) } : {}),
      };
    } catch { /* none yet, or unreadable: nothing is remembered */ }
    return this.cached = data;
  }

  async hosts(): Promise<string[]> { return [...(await this.load()).hosts]; }
  async hasCommand(command: string): Promise<boolean> { return (await this.load()).commands.includes(command); }
  /** A command you said "Yes, always for this project" to: the exact command, or one starting with a kept prefix. `core`: the
   * line's one command that is not a plain read (commandCore), which a kept prefix covers too. */
  async allowsCommand(command: string, core?: string): Promise<boolean> {
    const data = await this.load();
    return data.commands.includes(command) || (data.prefixes ?? []).some((prefix) => matchesPrefix(command, prefix) || (core !== undefined && matchesPrefix(core, prefix)));
  }
  addPrefix(prefix: string): Promise<void> {
    return this.update((data) => { data.prefixes = [...new Set([...data.prefixes ?? [], prefix])]; });
  }
  /** Machines the AI's ssh, scp and the like may reach without asking (lower case, as Casper resolved them). */
  async reachHosts(): Promise<string[]> { return [...(await this.load()).reach ?? []]; }
  addReach(host: string): Promise<void> {
    return this.update((data) => { const name = host.toLowerCase(); data.reach = [...new Set([...data.reach ?? [], name])]; });
  }
  /** Folders outside the project you said the write box Yes, always for this project to (real paths): the AI's edit and write tools and its shell may write them and below. */
  async writeFolders(): Promise<string[]> { return [...(await this.load()).writes ?? []]; }
  addWrite(folder: string): Promise<void> {
    return this.update((data) => { data.writes = [...new Set([...data.writes ?? [], folder])]; });
  }
  forgetWrite(folder: string): Promise<boolean> {
    let found = false;
    return this.update((data) => {
      found = Boolean(data.writes?.includes(folder));
      if (data.writes) { data.writes = data.writes.filter((entry) => entry !== folder); if (!data.writes.length) delete data.writes; }
    }).then(() => found);
  }
  /** Whether ssh to a device on your lab list runs without asking (on unless /lab ssh off). */
  async labReach(): Promise<boolean> { return (await this.load()).labReach !== false; }
  setLabReach(on: boolean): Promise<void> {
    return this.update((data) => { if (on) delete data.labReach; else data.labReach = false; });
  }

  /** "Yes, always for this project" to running its checks outside the sandbox. Only your own answer sets it. */
  async checksOutside(): Promise<boolean> { return (await this.load()).checksOutside === true; }
  setChecksOutside(on: boolean): Promise<void> {
    return this.update((data) => { if (on) data.checksOutside = true; else delete data.checksOutside; });
  }

  /** Kinds of plain git and gh command (`git push`, `gh pr create`) you said "Yes, always for this project" to: they run
   * outside the sandbox with your GitHub login without asking. Only your own answer adds one. */
  async allowsGithub(action: string): Promise<boolean> { return Boolean((await this.load()).github?.includes(action)); }
  addGithub(action: string): Promise<void> {
    return this.update((data) => { data.github = [...new Set([...data.github ?? [], action])]; });
  }
  /** Take back one, saved or for this session. False when it was not there. */
  async removeGithub(action: string): Promise<boolean> {
    let found = this.sessionGithub.delete(action);
    await this.update((data) => {
      if (data.github?.includes(action)) { found = true; data.github = data.github.filter((entry) => entry !== action); if (!data.github.length) delete data.github; }
    });
    return found;
  }

  addHost(host: string): Promise<void> { return this.update((data) => { const name = hostName(host); if (!data.hosts.includes(name)) data.hosts.push(name); }); }
  forgetHost(host: string): Promise<boolean> {
    let found = false;
    return this.update((data) => {
      const name = hostName(host);
      const reach = host.toLowerCase();
      found = data.hosts.includes(name) || Boolean(data.reach?.includes(reach));
      data.hosts = data.hosts.filter((entry) => entry !== name);
      if (data.reach) data.reach = data.reach.filter((entry) => entry !== reach);
    }).then(() => found);
  }
  addCommand(command: string): Promise<void> { return this.update((data) => { if (!data.commands.includes(command)) data.commands.push(command); }); }
  /** What you said "Yes, for this session" to: kept only in memory, gone when Casper exits. */
  readonly sessionCommands = new Set<string>();
  readonly sessionPrefixes = new Set<string>();
  /** The same for git and gh commands with your GitHub login (`git push`). */
  readonly sessionGithub = new Set<string>();
  /** Everything allowed for this project, in the order /allowed numbers it: saved prefixes, saved commands, then the
   * session ones that are not also saved. */
  async allowed(): Promise<AllowedEntry[]> {
    const data = await this.load();
    const entries: AllowedEntry[] = [
      ...(data.prefixes ?? []).map((value) => ({ kind: "prefix" as const, value, session: false })),
      ...data.commands.map((value) => ({ kind: "command" as const, value, session: false })),
    ];
    if (data.checksOutside) entries.push({ kind: "checks", value: CHECKS_OUTSIDE_ENTRY, session: false });
    for (const value of data.github ?? []) entries.push({ kind: "github", value, session: false });
    for (const value of this.sessionGithub) if (!data.github?.includes(value)) entries.push({ kind: "github", value, session: true });
    for (const value of this.sessionPrefixes) if (!data.prefixes?.includes(value)) entries.push({ kind: "prefix", value, session: true });
    for (const value of this.sessionCommands) if (!data.commands.includes(value)) entries.push({ kind: "command", value, session: true });
    return entries;
  }
  /** Take back a command prefix, saved or for this session. False when it was not there. */
  async removePrefix(prefix: string): Promise<boolean> {
    let found = this.sessionPrefixes.delete(prefix);
    await this.update((data) => {
      if (data.prefixes?.includes(prefix)) { found = true; data.prefixes = data.prefixes.filter((entry) => entry !== prefix); if (!data.prefixes.length) delete data.prefixes; }
    });
    return found;
  }
  /** Take back an exact command, saved or for this session. False when it was not there. */
  async removeCommand(command: string): Promise<boolean> {
    let found = this.sessionCommands.delete(command);
    await this.update((data) => {
      if (data.commands.includes(command)) { found = true; data.commands = data.commands.filter((entry) => entry !== command); }
    });
    return found;
  }
  /** Take back every allowed command and prefix, saved and for this session; how many were there. */
  async forgetAll(): Promise<number> {
    let count = 0;
    await this.update((data) => {
      if (data.checksOutside) { delete data.checksOutside; count++; }
      count += new Set([...data.github ?? [], ...this.sessionGithub]).size;
      delete data.github;
      count += new Set([...data.commands, ...this.sessionCommands].map((v) => `c:${v}`).concat([...data.prefixes ?? [], ...this.sessionPrefixes].map((v) => `p:${v}`))).size;
      data.commands = []; delete data.prefixes;
    });
    this.sessionCommands.clear(); this.sessionPrefixes.clear(); this.sessionGithub.clear();
    return count;
  }

  private update(change: (data: StoreFile) => void): Promise<void> {
    const work = async () => {
      this.cached = undefined;
      const data = await this.load();
      change(data);
      data.hosts = data.hosts.slice(-MAX_ENTRIES); data.commands = data.commands.slice(-MAX_ENTRIES);
      if (data.reach) data.reach = data.reach.slice(-MAX_ENTRIES);
      if (data.prefixes) data.prefixes = data.prefixes.slice(-MAX_ENTRIES);
      if (data.github) data.github = data.github.slice(-MAX_ENTRIES);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(this.directory, `.sandbox.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        await rename(temporary, this.file);
      } catch (error) { await rm(temporary, { force: true }); throw error; }
      this.cached = data;
    };
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
}
