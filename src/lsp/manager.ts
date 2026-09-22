import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LSPConfiguration, LSPServerDefinition } from "./config";
import { LSPConnection, record } from "./protocol";
import { ProcessCleanupError } from "../platform/processes";
import { applyTextEdits, type Position } from "./edits";
import { commitPlan, planWorkspaceEdit, snapshot, validatePlan, workspaceSnapshots, type PlannedFile, type Snapshot } from "./workspace";

export interface DiagnosticReport {
  path: string;
  status: "fresh" | "unversioned" | "timeout" | "unavailable";
  version: number;
  diagnostics: unknown[];
}
export interface RenamePreview { files: { path: string; edits: PlannedFile["edits"] }[] }
export type ConfirmRename = (preview: RenamePreview, signal?: AbortSignal) => Promise<boolean>;
export type FileLocks = <T>(paths: string[], work: () => Promise<T>) => Promise<T>;
interface Document { text: string; version: number }
interface SyncedDocument { current: Snapshot; uri: string; version: number }
interface Published { version?: number; items: unknown[]; at: number }
interface Server {
  definition: LSPServerDefinition;
  lifetime: AbortController;
  connection: LSPConnection;
  capabilities: Record<string, unknown>;
  needsDiagnosticRefresh: boolean;
  documents: Map<string, Document>;
  diagnostics: Map<string, Published>;
}

export class LSPManager {
  private readonly servers = new Map<string, Server>();
  private readonly starting = new Map<string, { work: Promise<void>; controller: AbortController }>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly lifetime = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  private closeWork?: Promise<void>;
  private root?: string;
  private cleanupError?: ProcessCleanupError;
  constructor(readonly projectRoot: string, readonly configuration: LSPConfiguration, private readonly timeoutMs = 10_000) {}

  assertCleanup(): void {
    if (this.cleanupError) throw this.cleanupError;
    try { for (const server of this.servers.values()) server.connection.assertCleanup(); }
    catch (error) { if (error instanceof ProcessCleanupError) this.cleanupError = error; throw error; }
  }

  private async closeConnection(connection?: LSPConnection): Promise<void> {
    try { await connection?.close(); }
    catch (error) { if (error instanceof ProcessCleanupError) this.cleanupError = error; throw error; }
  }

  status() {
    return this.configuration.servers.map((definition) => ({ name: definition.name, source: definition.source,
      cleanup: this.cleanupError ? "unknown" : undefined,
      state: this.stopping.has(definition.name) ? "disconnecting" : this.starting.has(definition.name) ? "connecting" : this.servers.get(definition.name)?.connection.alive ? "ready" : "disconnected" }));
  }

  connect(name: string): Promise<void> {
    if (this.cleanupError) return Promise.reject(this.cleanupError);
    if (this.lifetime.signal.aborted) return Promise.reject(new Error("LSP manager closed"));
    const pending = this.starting.get(name);
    if (pending) return pending.work;
    if (this.servers.get(name)?.connection.alive) return Promise.resolve();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const work = this.start(name, controller, signal).finally(() => this.starting.delete(name));
    this.starting.set(name, { work, controller });
    return work;
  }

  private async start(name: string, controller: AbortController, signal: AbortSignal): Promise<void> {
    await this.stopping.get(name);
    await this.closeConnection(this.servers.get(name)?.connection);
    this.assertCleanup();
    signal.throwIfAborted();
    const definition = this.configuration.servers.find((entry) => entry.name === name);
    if (!definition) throw new Error("Unknown LSP server");
    this.root = await realpath(this.projectRoot);
    signal.throwIfAborted();
    const connection = new LSPConnection(definition.command, definition.args, this.root, this.timeoutMs);
    const server: Server = { definition, lifetime: controller, connection, capabilities: {}, needsDiagnosticRefresh: false, documents: new Map(), diagnostics: new Map() };
    this.servers.set(name, server);
    connection.onClose = () => server.lifetime.abort();
    connection.onNotification = (method, params) => {
      if (method !== "textDocument/publishDiagnostics" || !record(params) || typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) return;
      const doc = server.documents.get(params.uri);
      if (!doc || (params.version !== undefined && params.version !== doc.version)) return;
      server.diagnostics.set(params.uri, { version: typeof params.version === "number" ? params.version : undefined, items: params.diagnostics, at: Date.now() });
    };
    try {
      const result = await connection.request("initialize", {
        processId: process.pid, rootUri: pathToFileURL(this.root).href,
        workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }],
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          workspace: { applyEdit: false, workspaceEdit: { documentChanges: true, resourceOperations: [] } },
          textDocument: { publishDiagnostics: { versionSupport: true }, diagnostic: {}, synchronization: { didSave: true }, rename: { prepareSupport: false } },
        },
      }, signal);
      if (!record(result) || !record(result.capabilities)) throw new Error("Invalid LSP initialization");
      server.capabilities = result.capabilities;
      if (result.capabilities.positionEncoding !== undefined && result.capabilities.positionEncoding !== "utf-16") throw new Error("Only UTF-16 language servers are supported");
      signal.throwIfAborted();
      connection.notify("initialized", {});
    } catch (error) {
      if (this.servers.get(name) === server) this.servers.delete(name);
      await this.closeConnection(connection);
      throw error;
    }
  }

  disconnect(name: string): Promise<void> {
    const previous = this.stopping.get(name);
    if (previous) return previous;
    const server = this.servers.get(name);
    const starting = this.starting.get(name);
    starting?.controller.abort();
    server?.lifetime.abort();
    this.servers.delete(name); // immediately revokes pending rename approval
    const work = (async () => {
      await this.closeConnection(server?.connection);
      await starting?.work.catch(() => {});
      const late = this.servers.get(name);
      this.servers.delete(name);
      await this.closeConnection(late?.connection);
    })().finally(() => this.stopping.delete(name));
    this.stopping.set(name, work);
    return work;
  }

  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.lifetime.abort();
    this.closeWork = (async () => {
      await Promise.all(this.configuration.servers.map((server) => this.disconnect(server.name)));
      await this.queue.catch(() => {});
      this.assertCleanup();
    })();
    return this.closeWork;
  }

  private serial<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const waiting = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    return new Promise<T>((resolve, reject) => {
      if (waiting.aborted) { reject(new Error("LSP operation cancelled")); return; }
      const abort = () => reject(new Error("Queued LSP operation cancelled"));
      waiting.addEventListener("abort", abort, { once: true });
      const task = this.queue.then(async () => {
        waiting.throwIfAborted();
        waiting.removeEventListener("abort", abort);
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), 60_000);
        try { return await work(AbortSignal.any([waiting, deadline.signal])); }
        finally { clearTimeout(timer); }
      });
      this.queue = task.catch(() => {});
      task.then(resolve, reject).finally(() => waiting.removeEventListener("abort", abort));
    });
  }

  private server(name: string): Server {
    this.assertCleanup();
    const server = this.servers.get(name);
    if (!server?.connection.alive || this.starting.has(name)) throw new Error("LSP server is not connected; use /lsp connect");
    return server;
  }

  private async sync(server: Server, input: string, force = false): Promise<SyncedDocument> {
    const current = await snapshot(this.root!, input);
    const languageId = server.definition.languages[path.extname(current.path)];
    if (!languageId) throw new Error("File language is not configured for this server");
    const uri = pathToFileURL(current.path).href;
    const doc = server.documents.get(uri);
    if (!doc && server.documents.size >= 100) throw new Error("LSP open-document limit reached");
    if (!doc || doc.text !== current.text || force) {
      const version = (doc?.version ?? 0) + 1;
      server.diagnostics.delete(uri);
      const sync = server.capabilities.textDocumentSync;
      const kind = typeof sync === "number" ? sync : record(sync) ? sync.change : undefined;
      if (doc && kind !== 1 && kind !== 2) throw new Error("Server does not support document changes");
      try {
        if (!doc) server.connection.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text: current.text } });
        else {
          const lines = doc.text.split(/\r\n|\r|\n/);
          // A full-range edit is valid even for servers requiring incremental sync.
          const change = kind === 2 ? { range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1)!.length } }, text: current.text } : { text: current.text };
          server.connection.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [change] });
          const save = record(sync) ? sync.save : false;
          if (save) server.connection.notify("textDocument/didSave", { textDocument: { uri }, ...(record(save) && save.includeText ? { text: current.text } : {}) });
        }
        if ((doc && doc.text !== current.text) || (!doc && server.documents.size > 0)) server.needsDiagnosticRefresh = true;
        server.documents.set(uri, { text: current.text, version });
      } catch {
        // didChange may have been delivered even if didSave fails. Never retry
        // using an uncertain server version or an old incremental-edit range.
        await this.closeConnection(server.connection);
        throw new Error("LSP synchronization failed; reconnect required");
      }
    }
    return { current, uri, version: server.documents.get(uri)!.version };
  }

  private async syncOpen(server: Server): Promise<void> {
    const changed: string[] = [];
    for (const [uri, doc] of server.documents) {
      const current = await snapshot(this.root!, uri);
      if (current.text !== doc.text) changed.push(uri);
    }
    if (!changed.length && !server.needsDiagnosticRefresh) return;
    for (const uri of changed) await this.sync(server, uri);
    await this.refreshReports(server);
  }

  /** Two-phase evidence barrier: all contents first, then all new versions.
   * A dependent may itself have changed, so refreshing only unchanged files is
   * insufficient. No publication from phase one can verify phase two.
   */
  private async refreshReports(server: Server): Promise<void> {
    const contents = new Map([...server.documents].map(([uri, doc]) => [uri, doc.text]));
    server.needsDiagnosticRefresh = true;
    server.diagnostics.clear();
    try {
      for (const [uri, text] of contents) {
        const synced = await this.sync(server, uri, true);
        if (synced.current.text !== text) throw new Error("Workspace changed during diagnostic synchronization");
      }
      server.needsDiagnosticRefresh = false;
    } catch (error) {
      server.diagnostics.clear();
      throw error;
    }
  }

  query(name: string, operation: "symbols" | "workspaceSymbols" | "definition" | "references", input: { path?: string; position?: Position; query?: string }, signal?: AbortSignal): Promise<unknown> {
    return this.serial(signal, async (signal) => {
      const server = this.server(name);
      const methods = { symbols: ["documentSymbolProvider", "textDocument/documentSymbol"], workspaceSymbols: ["workspaceSymbolProvider", "workspace/symbol"], definition: ["definitionProvider", "textDocument/definition"], references: ["referencesProvider", "textDocument/references"] };
      const [capability, method] = methods[operation];
      if (!server.capabilities[capability]) throw new Error("LSP operation unsupported");
      await this.syncOpen(server);
      if (operation === "workspaceSymbols") return server.connection.request(method, { query: input.query ?? "" }, signal);
      const doc = await this.sync(server, input.path!);
      if (operation !== "symbols") {
        if (!input.position) throw new Error("Position required");
        applyTextEdits(doc.current.text, [{ range: { start: input.position, end: input.position }, newText: "" }]);
      }
      return server.connection.request(method, { textDocument: { uri: doc.uri }, position: input.position, ...(operation === "references" ? { context: { includeDeclaration: true } } : {}) }, signal);
    });
  }

  diagnostics(name: string, input: string, signal?: AbortSignal): Promise<DiagnosticReport> {
    return this.serial(signal, async (signal) => {
      const server = this.server(name);
      await this.syncOpen(server);
      return this.collect(server, input, signal);
    });
  }

  private async collect(server: Server, input: string, signal: AbortSignal): Promise<DiagnosticReport> {
    return (await this.collectMany(server, [input], signal))[0];
  }

  /** One coherent evidence batch: one wait budget and one final dependency scan.
   * No filesystem snapshot is cached across operations or approval boundaries.
   */
  private async collectMany(server: Server, inputs: string[], signal: AbortSignal): Promise<DiagnosticReport[]> {
    const docs: SyncedDocument[] = [];
    for (const input of inputs) { signal.throwIfAborted(); docs.push(await this.sync(server, input)); }
    if (server.needsDiagnosticRefresh) await this.refreshReports(server);
    const expected = new Map(server.documents);
    for (const doc of docs) doc.version = expected.get(doc.uri)!.version;
    const deadline = Date.now() + this.timeoutMs;
    const reports = new Array<DiagnosticReport>(docs.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, docs.length) }, async () => {
      while (next < docs.length) {
        const index = next++;
        reports[index] = await this.waitReport(server, docs[index], signal, deadline);
      }
    }));
    const targets = new Map(docs.map((doc) => [doc.uri, doc.current]));
    let valid = server.connection.alive;
    try {
      for (const [uri, opened] of expected) {
        signal.throwIfAborted();
        const current = await snapshot(this.root!, uri);
        const target = targets.get(uri);
        if (current.text !== opened.text || (target && (current.path !== target.path || current.text !== target.text || current.dev !== target.dev || current.ino !== target.ino))) {
          valid = false;
          break;
        }
      }
    } catch { signal.throwIfAborted(); valid = false; }
    if (!valid || !server.connection.alive) return reports.map((report) => ({ ...report, status: "unavailable", diagnostics: [] }));
    return reports;
  }

  private async waitReport(server: Server, doc: SyncedDocument, signal: AbortSignal, deadline: number): Promise<DiagnosticReport> {
    const result = (status: DiagnosticReport["status"], diagnostics: unknown[] = []): DiagnosticReport => ({
      path: path.relative(this.root!, doc.current.path), version: doc.version, status, diagnostics,
    });
    signal.throwIfAborted();
    if (!server.connection.alive) return result("unavailable");
    if (server.capabilities.diagnosticProvider) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return result("timeout");
      try {
        const response = await server.connection.request("textDocument/diagnostic", { textDocument: { uri: doc.uri } }, signal, remaining);
        if (record(response) && response.kind === "full" && Array.isArray(response.items)) return result("fresh", response.items);
      } catch { signal.throwIfAborted(); }
      return result("unavailable");
    }
    while (true) {
      signal.throwIfAborted();
      if (!server.connection.alive) return result("unavailable");
      const report = server.diagnostics.get(doc.uri);
      if (report?.version === doc.version) return result("fresh", report.items);
      if (report && report.version === undefined && Date.now() - report.at >= 250) return result("unversioned", report.items);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return result("timeout");
      await new Promise((resolve) => setTimeout(resolve, Math.min(20, remaining)));
    }
  }

  afterEdit(input: string, signal?: AbortSignal): Promise<DiagnosticReport[]> {
    return this.serial(signal, async (signal) => {
      const result: DiagnosticReport[] = [];
      for (const server of this.servers.values()) {
        if (!server.connection.alive || !server.definition.languages[path.extname(input)]) continue;
        await this.syncOpen(server);
        await this.sync(server, input, true);
        result.push(await this.collect(server, input, signal));
      }
      return result;
    });
  }

  private approve(confirm: ConfirmRename, preview: RenamePreview, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error("Rename approval cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => confirm(preview, signal)).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private withLocks<T>(locks: FileLocks, paths: string[], signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      // Cancellation can abandon waiting for a native writer, but once mutation
      // starts we drain it so callers receive honest partial-write evidence.
      const abort = () => reject(new Error("Rename lock wait cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => locks(paths, async () => {
        signal.throwIfAborted();
        signal.removeEventListener("abort", abort);
        return work();
      })).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  rename(name: string, input: string, position: Position, newName: string, confirm: ConfirmRename, locks: FileLocks = async (_paths, work) => work(), signal?: AbortSignal): Promise<{ changed: string[]; diagnostics: DiagnosticReport[] }> {
    return this.serial(signal, async (signal) => {
      if (!newName || newName.length > 256 || /[\x00-\x1f]/.test(newName)) throw new Error("Invalid rename name");
      const server = this.server(name);
      signal = AbortSignal.any([signal, server.lifetime.signal]);
      if (!server.capabilities.renameProvider) throw new Error("LSP rename unsupported");
      await this.syncOpen(server);
      const doc = await this.sync(server, input);
      applyTextEdits(doc.current.text, [{ range: { start: position, end: position }, newText: "" }]);
      const originals = await workspaceSnapshots(this.root!, Object.keys(server.definition.languages));
      const versions = new Map<string, number>();
      const before = new Map<string, string>();
      for (const current of originals) {
        const synced = await this.sync(server, current.path);
        if (synced.current.text !== current.text) throw new Error("Workspace changed during rename preparation");
        versions.set(current.path, synced.version);
        before.set(current.path, current.text);
      }
      const response = await server.connection.request("textDocument/rename", { textDocument: { uri: doc.uri }, position, newName }, signal);
      const files = await planWorkspaceEdit(this.root!, response, versions);
      for (const file of files) if (!before.has(file.path) || before.get(file.path) !== file.text) throw new Error("Unknown target or file changed during rename request");
      const preview = { files: files.map((file) => ({ path: path.relative(this.root!, file.path), edits: file.edits })) };
      // Approval gets a detached copy; callbacks cannot mutate the plan to be committed.
      if (!await this.approve(confirm, structuredClone(preview), signal)) throw new Error("Rename not approved; no files changed");
      signal.throwIfAborted();
      return this.withLocks(locks, originals.map((file) => file.path), signal, async () => {
        signal.throwIfAborted();
        if (this.servers.get(name) !== server || !server.connection.alive) throw new Error("LSP connection changed during approval");
        const currentWorkspace = await workspaceSnapshots(this.root!, Object.keys(server.definition.languages));
        const currentPaths = new Set(currentWorkspace.map((file) => file.path));
        if (currentPaths.size !== originals.length || originals.some((file) => !currentPaths.has(file.path))) throw new Error("Workspace membership changed during approval; request a new rename");
        for (const original of originals) {
          const current = await snapshot(this.root!, original.path);
          if (current.text !== original.text || current.ino !== original.ino || current.dev !== original.dev) throw new Error("Workspace changed during approval; request a new rename");
        }
        await validatePlan(this.root!, files);
        const changed = await commitPlan(this.root!, files, signal);
        let diagnostics: DiagnosticReport[];
        // Invalidate every observed file, including unchanged dependents: a
        // semantic rename can introduce diagnostics outside the edited targets.
        const failedSync = new Set<string>();
        for (const file of originals) {
          try { await this.sync(server, file.path); }
          catch { failedSync.add(file.path); }
        }
        if (!failedSync.size) {
          try { await this.refreshReports(server); }
          catch { for (const file of originals) failedSync.add(file.path); }
        } else {
          // Any unknown dependency invalidates the whole workspace report.
          for (const file of originals) failedSync.add(file.path);
        }
        try {
          if (failedSync.size) throw new Error("Synchronization failed");
          diagnostics = await this.collectMany(server, originals.map((file) => file.path), signal);
        } catch {
          diagnostics = originals.map((file) => ({ path: path.relative(this.root!, file.path), version: server.documents.get(pathToFileURL(file.path).href)?.version ?? 0, status: "unavailable", diagnostics: [] }));
        }
        return { changed: changed.map((file) => path.relative(this.root!, file)), diagnostics };
      });
    });
  }
}
