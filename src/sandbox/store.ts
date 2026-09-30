import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hostName } from "./policy";

/**
 * What you told the sandbox to remember for one project, kept in Casper's own folder
 * (~/.casper/projects/<id>/), never in the repo: hosts ("Always for this project") and, when no sandbox
 * can run, exact shell commands you said not to ask about again. Private (0600), written only from your
 * own answer to a numbered question. The sandbox keeps the AI's shell from reading or writing this folder.
 */
interface StoreFile { version: 1; hosts: string[]; commands: string[] }

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
      };
    } catch { /* none yet, or unreadable: nothing is remembered */ }
    return this.cached = data;
  }

  async hosts(): Promise<string[]> { return [...(await this.load()).hosts]; }
  async hasCommand(command: string): Promise<boolean> { return (await this.load()).commands.includes(command); }

  addHost(host: string): Promise<void> { return this.update((data) => { const name = hostName(host); if (!data.hosts.includes(name)) data.hosts.push(name); }); }
  forgetHost(host: string): Promise<boolean> {
    let found = false;
    return this.update((data) => { const name = hostName(host); found = data.hosts.includes(name); data.hosts = data.hosts.filter((entry) => entry !== name); }).then(() => found);
  }
  addCommand(command: string): Promise<void> { return this.update((data) => { if (!data.commands.includes(command)) data.commands.push(command); }); }
  forgetCommands(): Promise<number> {
    let count = 0;
    return this.update((data) => { count = data.commands.length; data.commands = []; }).then(() => count);
  }

  private update(change: (data: StoreFile) => void): Promise<void> {
    const work = async () => {
      this.cached = undefined;
      const data = await this.load();
      change(data);
      data.hosts = data.hosts.slice(-MAX_ENTRIES); data.commands = data.commands.slice(-MAX_ENTRIES);
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
