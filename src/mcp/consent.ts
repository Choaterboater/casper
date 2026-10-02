import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { openNoFollow } from "../platform/files";
import type { MCPServerDefinition } from "./config";
import { matchPreset, rememberBlock } from "./presets";
import { isChangeKind, isRiskyKind, RISKY_KINDS, type ChangeKind } from "../capabilities/kinds";

/**
 * Remembered approval for your own and imported MCP servers, kept in ~/.casper/mcp-consent.json.
 *
 * A record is only a keyed hash (HMAC-SHA256) of the server's definition: name, start folder and
 * transport (command, args, env, URL, headers). Any change there gives a different hash, so Casper
 * asks again. The key is 32 random bytes in ~/.casper/mcp-consent.key (0600), so the hashes can't
 * be used to guess secrets that sit in the definition. Limits, preset pins and where the definition
 * came from are not part of the hash. Project servers are never remembered. Unpinned package
 * runners (npx, uvx, docker :latest, ...) are never remembered either, because they can fetch new
 * code under the same definition.
 */

const VERSION = 1;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RECORDS = 256;
const KEY_BYTES = 32;
const HASH = /^[0-9a-f]{64}$/;

export type ConsentState = "none" | "remembered" | "changed";
interface ConsentRecord { hash: string; at: string }
/** Risky change kinds the user chose to remember for a server (/mcp allow, then 2 Remember), keyed to the same
 * definition hash: another program under the same name gets none of them. */
interface KindsRecord { hash: string; kinds: ChangeKind[] }
interface ConsentFile { version: 1; servers: Record<string, ConsentRecord>; imports?: string; kinds?: Record<string, KindsRecord> }

/** Stable JSON: object keys sorted at every level. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : item);
}

/**
 * What identifies a server's program: name, start folder and transport. Everything else (source,
 * scope, shadows, importedFrom, limits, disabled, preset pins) is left out, so moving a definition
 * between files or changing a timeout does not count as a change.
 */
export function definitionIdentity(definition: MCPServerDefinition): string {
  const transport = definition.transport.type === "stdio"
    ? { type: "stdio", command: definition.transport.command, args: [...definition.transport.args], env: { ...definition.transport.env } }
    : { type: "http", url: definition.transport.url, headers: { ...definition.transport.headers } };
  return canonical({ name: definition.name, cwd: definition.cwd, transport });
}

/** Keyed hash of a definition (and the preset it matched). Never a plain hash of secrets. */
export function definitionHash(definition: MCPServerDefinition, key: Buffer, presetId?: string): string {
  return createHmac("sha256", key)
    .update(`casper/mcp-consent v${VERSION}\n${presetId ?? ""}\n${definitionIdentity(definition)}`)
    .digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSmall(file: string, maxBytes: number): Promise<{ text: string; mode: number } | undefined> {
  let handle;
  try { handle = await openNoFollow(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("not a regular file");
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw new Error("too large");
    return { text: bytes.subarray(0, bytesRead).toString("utf8"), mode: stats.mode };
  } finally { await handle.close(); }
}

async function writePrivate(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export type RememberResult = { remembered: true } | { remembered: false; reason: string };

export class ConsentStore {
  readonly file: string;
  readonly keyFile: string;
  /** Plain messages about the store itself. They never contain definition values. */
  readonly diagnostics: string[] = [];
  private key: Buffer | undefined;
  private data: ConsentFile = { version: VERSION, servers: Object.create(null) };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(home: string, private readonly platform: NodeJS.Platform = process.platform) {
    this.file = path.join(home, ".casper", "mcp-consent.json");
    this.keyFile = path.join(home, ".casper", "mcp-consent.key");
  }

  /** Read the key and the records. A missing, unsafe or corrupt file counts as empty. */
  async load(): Promise<void> {
    this.diagnostics.length = 0;
    this.key = await this.readKey();
    this.data = await this.readRecords();
  }

  /** remembered: same definition approved before; changed: approved before, but it changed since. */
  state(definition: MCPServerDefinition): ConsentState {
    if (definition.scope === "project") return "none";
    const stored = this.data.servers[definition.name];
    if (!stored) return "none";
    if (!this.key) return "changed";
    return stored.hash === this.hashOf(definition) ? "remembered" : "changed";
  }

  has(definition: MCPServerDefinition): boolean {
    return this.state(definition) === "remembered" && !rememberBlock(definition, matchPreset(definition));
  }

  /** Remember a server the user just approved. Refuses project servers and unpinned runners. */
  remember(definition: MCPServerDefinition): Promise<RememberResult> {
    return this.serial(async () => {
      if (definition.scope === "project") {
        return { remembered: false, reason: `Not remembered: ${definition.name} comes from the project, so Casper asks each time.` };
      }
      const block = rememberBlock(definition, matchPreset(definition));
      if (block) return { remembered: false, reason: block };
      const key = await this.ensureKey();
      const data = await this.readRecords();
      if (!(definition.name in data.servers) && Object.keys(data.servers).length >= MAX_RECORDS) {
        return { remembered: false, reason: "Not remembered: too many remembered servers. Use /mcp forget on one first." };
      }
      data.servers[definition.name] = { hash: definitionHash(definition, key, matchPreset(definition)?.preset.id), at: new Date().toISOString() };
      await this.save(data);
      return { remembered: true };
    });
  }

  /** Drop a remembered server. Returns whether there was one. */
  forget(name: string): Promise<boolean> {
    return this.serial(async () => {
      const data = await this.readRecords();
      if (!(name in data.servers)) { this.data = data; return false; }
      delete data.servers[name];
      await this.save(data);
      return true;
    });
  }

  /** The risky kinds remembered for this exact definition (empty for a project server or a changed definition). */
  rememberedKinds(definition: MCPServerDefinition): ChangeKind[] {
    if (definition.scope === "project" || !this.key) return [];
    const stored = this.data.kinds?.[definition.name];
    return stored && stored.hash === this.hashOf(definition) ? [...stored.kinds] : [];
  }

  /** Remember risky kinds for a server (only firmware, delete, admin are kept). Refuses project servers and unpinned runners. */
  rememberKinds(definition: MCPServerDefinition, kinds: readonly ChangeKind[]): Promise<RememberResult> {
    return this.serial(async () => {
      if (definition.scope === "project") {
        return { remembered: false, reason: `Not remembered: ${definition.name} comes from the project. Allowed for this session only.` };
      }
      const block = rememberBlock(definition, matchPreset(definition));
      if (block) return { remembered: false, reason: block };
      const key = await this.ensureKey();
      const data = await this.readRecords();
      const kept = data.kinds ?? Object.create(null) as Record<string, KindsRecord>;
      if (!(definition.name in kept) && Object.keys(kept).length >= MAX_RECORDS) {
        return { remembered: false, reason: "Not remembered: too many servers with remembered kinds. Use /mcp allow <name> off on one first." };
      }
      const hash = definitionHash(definition, key, matchPreset(definition)?.preset.id);
      const before = kept[definition.name]?.hash === hash ? kept[definition.name]!.kinds : [];
      kept[definition.name] = { hash, kinds: RISKY_KINDS.filter((kind) => before.includes(kind) || kinds.includes(kind)) };
      data.kinds = kept;
      await this.save(data);
      return { remembered: true };
    });
  }

  /** /mcp allow <name> off: drop the remembered kinds. Returns whether there were any. */
  forgetKinds(name: string): Promise<boolean> {
    return this.serial(async () => {
      const data = await this.readRecords();
      if (!data.kinds || !(name in data.kinds)) { this.data = data; return false; }
      delete data.kinds[name];
      await this.save(data);
      return true;
    });
  }

  /** Whether this set of imported server names differs from the last one the user was told about. */
  importSetIsNew(names: readonly string[]): boolean {
    if (!names.length) return false;
    if (!this.key) return true;
    return this.data.imports !== this.importHash(names, this.key);
  }

  markImportSet(names: readonly string[]): Promise<void> {
    return this.serial(async () => {
      const key = await this.ensureKey();
      const data = await this.readRecords();
      data.imports = this.importHash(names, key);
      await this.save(data);
    });
  }

  private hashOf(definition: MCPServerDefinition): string {
    return definitionHash(definition, this.key!, matchPreset(definition)?.preset.id);
  }

  private importHash(names: readonly string[], key: Buffer): string {
    return createHmac("sha256", key).update(`casper/mcp-imports v${VERSION}\n${[...new Set(names)].sort().join("\n")}`).digest("hex");
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async save(data: ConsentFile): Promise<void> {
    await writePrivate(this.file, `${JSON.stringify(data, null, 2)}\n`);
    this.data = data;
  }

  private async readKey(): Promise<Buffer | undefined> {
    let read;
    try { read = await readSmall(this.keyFile, 256); } catch {
      this.diagnostics.push("Cannot read ~/.casper/mcp-consent.key. Casper will ask again for each server.");
      return undefined;
    }
    if (!read) return undefined;
    if (this.platform !== "win32" && (read.mode & 0o077) !== 0) {
      this.diagnostics.push("~/.casper/mcp-consent.key can be read by other users, so it was not used. Casper will ask again for each server.");
      return undefined;
    }
    const text = read.text.trim();
    if (!/^[0-9a-f]{64}$/.test(text)) {
      this.diagnostics.push("~/.casper/mcp-consent.key is damaged. Casper will ask again for each server.");
      return undefined;
    }
    return Buffer.from(text, "hex");
  }

  /** The key, creating a new one when there is none usable. A new key drops old records. */
  private async ensureKey(): Promise<Buffer> {
    if (this.key) return this.key;
    const key = randomBytes(KEY_BYTES);
    await writePrivate(this.keyFile, `${key.toString("hex")}\n`);
    this.key = key;
    // Old records were made with another key and can never match again.
    this.data = { version: VERSION, servers: Object.create(null) };
    await this.save(this.data);
    return key;
  }

  private async readRecords(): Promise<ConsentFile> {
    const empty: ConsentFile = { version: VERSION, servers: Object.create(null) };
    let read;
    try { read = await readSmall(this.file, MAX_FILE_BYTES); } catch {
      this.note("Cannot read ~/.casper/mcp-consent.json. Casper will ask again for each server.");
      return empty;
    }
    if (!read) return empty;
    let document: unknown;
    try { document = JSON.parse(read.text); } catch { document = undefined; }
    if (!record(document) || document.version !== VERSION || !record(document.servers)) {
      this.note("~/.casper/mcp-consent.json is damaged. Casper will ask again for each server.");
      return empty;
    }
    const servers: Record<string, ConsentRecord> = Object.create(null);
    for (const [name, value] of Object.entries(document.servers).slice(0, MAX_RECORDS)) {
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name) || !record(value) || typeof value.hash !== "string" || !HASH.test(value.hash)) continue;
      servers[name] = { hash: value.hash, at: typeof value.at === "string" ? value.at.slice(0, 40) : "" };
    }
    const imports = typeof document.imports === "string" && HASH.test(document.imports) ? document.imports : undefined;
    const kinds: Record<string, KindsRecord> = Object.create(null);
    if (record(document.kinds)) for (const [name, value] of Object.entries(document.kinds).slice(0, MAX_RECORDS)) {
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name) || !record(value) || typeof value.hash !== "string" || !HASH.test(value.hash) || !Array.isArray(value.kinds)) continue;
      const listed = value.kinds.filter((kind): kind is ChangeKind => isChangeKind(kind) && isRiskyKind(kind));
      kinds[name] = { hash: value.hash, kinds: RISKY_KINDS.filter((kind) => listed.includes(kind)) };
    }
    return { version: VERSION, servers, ...(imports ? { imports } : {}), ...(Object.keys(kinds).length ? { kinds } : {}) };
  }

  private note(message: string): void {
    if (!this.diagnostics.includes(message)) this.diagnostics.push(message);
  }
}
