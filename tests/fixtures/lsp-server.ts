import { MessageReader } from "../../src/lsp/protocol";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { appendFileSync } from "node:fs";
if (process.argv[3]) appendFileSync(process.argv[3], `${process.pid}\n`);
const mode = process.argv[2] ?? "normal";
const documents = new Map<string, { version: number; text: string }>();
function send(value: unknown) {
  const body = JSON.stringify(value);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function publish(uri: string, version: number, text: string) {
  if (["silent", "pull", "pull-fail"].includes(mode)) return;
  send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: {
    uri, ...(mode === "unversioned" ? {} : { version: mode === "stale" ? version - 1 : version }),
    diagnostics: (text.includes("BROKEN") || (mode === "dependency" && [...documents.values()].some((doc) => doc.text.includes("BROKEN"))) || (mode === "rename-dependency" && documents.size > 1 && [...documents.values()].every((doc) => doc.text.includes("new")))) ? [{ severity: 1, message: "fixture error" }] : [],
  } });
}
const reader = new MessageReader((raw) => {
  const message = raw as { id?: number; method: string; params: any };
  const { id, method, params } = message;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id, result });
  if (method === "initialize") {
    if (mode === "hang-init") return;
    reply({ capabilities: { positionEncoding: mode === "utf8" ? "utf-8" : "utf-16", textDocumentSync: { openClose: true, change: mode === "no-sync" ? 0 : 2, save: true }, documentSymbolProvider: true, workspaceSymbolProvider: true, definitionProvider: true, referencesProvider: true, renameProvider: true, ...(["pull", "pull-fail"].includes(mode) ? { diagnosticProvider: {} } : {}) } });
  } else if (method === "shutdown") {
    if (mode === "stubborn") return;
    reply(null);
  } else if (method === "exit") {
    if (mode !== "stubborn") process.exit(0);
  } else if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
    if (mode === "crash-change" && method.endsWith("didChange")) process.exit(1);
    const { uri, version } = params.textDocument;
    const text = method.endsWith("didOpen") ? params.textDocument.text : params.contentChanges[0].text;
    documents.set(uri, { text, version });
    if (mode === "delayed") setTimeout(() => publish(uri, version, text), 100);
    else publish(uri, version, text);
  } else if (method === "textDocument/diagnostic") {
    if (mode === "pull-fail") send({ jsonrpc: "2.0", id, error: { code: -32603, message: "SECRET should not leak" } });
    else reply({ kind: "full", items: [] });
  } else if (method === "textDocument/rename") {
    const changes: Record<string, unknown> = {};
    for (const [uri, doc] of documents) {
      const edits = [...doc.text.matchAll(/\bold\b/g)].map((match) => ({ range: { start: { line: 0, character: match.index }, end: { line: 0, character: match.index + 3 } }, newText: params.newName }));
      if (edits.length) changes[uri] = edits;
    }
    if (mode === "escape") changes[pathToFileURL(path.join(path.dirname(fileURLToPath(params.textDocument.uri)), "../outside.ts")).href] = [];
    reply({ changes });
  } else if (method === "late") { setTimeout(() => reply(params), 300); }
  else if (method === "hang") { /* await client timeout */ }
  else if (method === "crash") process.exit(1);
  else if (method === "apply") {
    send({ jsonrpc: "2.0", id: 9876, method: "workspace/applyEdit", params: { edit: {} } });
    reply(null);
  } else if (method === "textDocument/documentSymbol" || method === "workspace/symbol") reply([{ name: "old", kind: 12 }]);
  else if (method === "textDocument/definition" || method === "textDocument/references") reply([{ uri: params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }]);
  else if (id !== undefined) reply(params ?? null);
});
process.stdin.on("data", (chunk: Buffer) => reader.push(chunk));
