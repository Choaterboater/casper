import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, writeFile, readFile, mkdir, rm, realpath, symlink, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LSPConnection, MessageReader } from "../src/lsp/protocol";
import { LSPManager } from "../src/lsp/manager";
import { discoverLSPConfiguration } from "../src/lsp/config";
import { planWorkspaceEdit, commitPlan } from "../src/lsp/workspace";
import { lspTools } from "../src/lsp/tools";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const serverFile = path.join(import.meta.dir, "fixtures/lsp-server.ts");
async function fixture(mode = "normal", timeout = 2000) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-lsp-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.ts"), "old();");
  await writeFile(path.join(root, "b.ts"), "old();");
  const manager = new LSPManager(root, { servers: [{ name: "fixture", source: "test", command: process.execPath, args: [serverFile, mode], languages: { ".ts": "typescript" } }], diagnostics: [] }, timeout);
  cleanup.push(() => manager.close());
  return { root, manager };
}
function connection(root: string, mode = "normal") {
  const value = new LSPConnection(process.execPath, [serverFile, mode], root, 200);
  cleanup.push(() => value.close());
  return value;
}
const position = { line: 0, character: 1 };

describe("Phase 5 LSP", () => {
  test("framing handles fragmented multibyte bodies and multiple messages; rejects bad bounds", () => {
    const result: unknown[] = [];
    const reader = new MessageReader((value) => result.push(value));
    const body = JSON.stringify({ value: "😀" });
    const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    for (const byte of frame) reader.push(Buffer.from([byte]));
    reader.push(Buffer.concat([frame, frame]));
    expect(result).toEqual([{ value: "😀" }, { value: "😀" }, { value: "😀" }]);
    for (const header of ["Content-Length: 99999999", "Content-Length: -1", "Content-Length: 1\r\nContent-Length: 1", "Bad: 2"]) {
      expect(() => new MessageReader(() => {}).push(Buffer.from(header + "\r\n\r\n"))).toThrow();
    }
  });

  test("configuration is metadata-only, layered and invalid overrides fail closed", async () => {
    const { root } = await fixture();
    const home = path.join(root, "home");
    await mkdir(path.join(home, ".casper"), { recursive: true });
    await mkdir(path.join(root, ".casper"));
    const valid = { command: "must-never-execute", languages: { ".ts": "typescript" } };
    await writeFile(path.join(home, ".casper/lsp.json"), JSON.stringify({ lspServers: { lower: valid, removed: valid } }));
    await writeFile(path.join(root, ".casper/lsp.json"), JSON.stringify({ lspServers: { lower: { ...valid, command: "override" }, removed: { command: 42 } } }));
    const config = await discoverLSPConfiguration({ projectRoot: root, homeDir: home });
    expect(config.servers.map((s) => [s.name, s.command])).toEqual([["lower", "override"]]);
    expect(config.diagnostics).toHaveLength(1);
  });

  test("requests timeout, cancel, survive late work, and close is shared", async () => {
    const { root } = await fixture();
    const rpc = connection(root);
    await expect(rpc.request("late", { stale: true })).rejects.toThrow("timed out");
    await Bun.sleep(150);
    await expect(rpc.request("hang")).rejects.toThrow("timed out");
    const controller = new AbortController();
    const work = rpc.request("hang", {}, controller.signal);
    controller.abort();
    await expect(work).rejects.toThrow("cancelled");
    expect(await rpc.request("echo", { value: "ok" })).toEqual({ value: "ok" });
    await rpc.request("apply"); // client rejects server-initiated workspace writes
    const a = rpc.close();
    expect(rpc.close()).toBe(a);
    await a;
    await expect(rpc.request("echo")).rejects.toThrow("closed");
  });

  test("stubborn shutdown and initialization failure are bounded", async () => {
    const { root } = await fixture();
    const rpc = connection(root, "stubborn");
    await rpc.request("echo");
    const start = Date.now();
    await rpc.close();
    expect(Date.now() - start).toBeLessThan(800);
    const { manager } = await fixture("utf8");
    await expect(manager.connect("fixture")).rejects.toThrow("UTF-16");
    expect(manager.status()[0].state).toBe("disconnected");
  });

  test("symbols, definitions, references, and diagnostics use connected server only", async () => {
    const { manager, root } = await fixture();
    await expect(manager.query("fixture", "symbols", { path: "a.ts" })).rejects.toThrow("not connected");
    await manager.connect("fixture");
    expect(await manager.query("fixture", "symbols", { path: "a.ts" })).toEqual([{ name: "old", kind: 12 }]);
    expect(await manager.query("fixture", "workspaceSymbols", { query: "old" })).toEqual([{ name: "old", kind: 12 }]);
    expect(await manager.query("fixture", "definition", { path: "a.ts", position })).toHaveLength(1);
    expect(await manager.query("fixture", "references", { path: "a.ts", position })).toHaveLength(1);
    expect((await manager.diagnostics("fixture", "a.ts")).status).toBe("fresh");
    await writeFile(path.join(root, "a.ts"), "BROKEN");
    const reports = await manager.afterEdit("a.ts");
    expect(reports[0].status).toBe("fresh");
    expect(reports[0].diagnostics).toHaveLength(1);
    await manager.disconnect("fixture");
    expect(lspTools(manager, async () => true)).toEqual([]);
  });

  test.each(["silent", "stale", "unversioned", "pull", "pull-fail"])("diagnostics never confuse %s with verified clean", async (mode) => {
    const { manager } = await fixture(mode, 400);
    await manager.connect("fixture");
    const report = await manager.diagnostics("fixture", "a.ts");
    expect(report.status).toBe(mode === "pull" ? "fresh" : mode === "pull-fail" ? "unavailable" : mode === "unversioned" ? "unversioned" : "timeout");
  });

  test("rename preflights all files, requires exact approval, then refreshes diagnostics", async () => {
    const { manager, root } = await fixture();
    await manager.connect("fixture");
    await expect(manager.rename("fixture", "a.ts", position, "new", async () => false)).rejects.toThrow("not approved");
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("old();");
    const result = await manager.rename("fixture", "a.ts", position, "new", async (preview) => {
      expect(preview.files).toHaveLength(2);
      preview.files[0].edits[0].newText = "tampered";
      return true;
    });
    expect(result.changed).toEqual(["a.ts", "b.ts"]);
    expect(result.diagnostics.every((r) => r.status === "fresh" && !r.diagnostics.length)).toBe(true);
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("new();");
    expect(await readFile(path.join(root, "b.ts"), "utf8")).toBe("new();");
  });

  test("edits or reconnect during approval revoke a rename without clobbering user work", async () => {
    const { manager, root } = await fixture();
    await manager.connect("fixture");
    await expect(manager.rename("fixture", "a.ts", position, "new", async () => {
      await writeFile(path.join(root, "b.ts"), "user work");
      return true;
    })).rejects.toThrow("changed");
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("old();");
    await writeFile(path.join(root, "b.ts"), "old();");
    await expect(manager.rename("fixture", "a.ts", position, "new", async () => {
      await manager.disconnect("fixture");
      await manager.connect("fixture");
      return true;
    })).rejects.toThrow("cancelled");
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("old();");
  });

  test("workspace edits reject resource operations, stale versions, outside/symlink targets and conflicts", async () => {
    const { root } = await fixture();
    const uri = pathToFileURL(path.join(root, "a.ts")).href;
    const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "new" };
    await expect(planWorkspaceEdit(root, { documentChanges: [{ kind: "delete", uri }] }, new Map())).rejects.toThrow();
    await expect(planWorkspaceEdit(root, { documentChanges: [{ textDocument: { uri, version: 10 }, edits: [edit] }] }, new Map())).rejects.toThrow("Stale");
    await expect(planWorkspaceEdit(root, { changes: { [uri]: [edit, edit] } }, new Map())).rejects.toThrow("Overlapping");
    await symlink(serverFile, path.join(root, "link.ts"));
    await expect(planWorkspaceEdit(root, { changes: { [pathToFileURL(path.join(root, "link.ts")).href]: [edit] } }, new Map())).rejects.toThrow("outside");
    const plan = await planWorkspaceEdit(root, { changes: { [uri]: [edit] } }, new Map());
    await writeFile(path.join(root, "a.ts"), "user work");
    await expect(commitPlan(root, plan)).rejects.toThrow("changed");
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("user work");
  });

  test("disconnect/reconnect in flight and close during initialization settle", async () => {
    const { manager } = await fixture();
    await manager.connect("fixture");
    const stopping = manager.disconnect("fixture");
    const starting = manager.connect("fixture");
    await Promise.all([stopping, starting]);
    expect(manager.status()[0].state).toBe("ready");
    const hanging = await fixture("hang-init", 1000);
    const work = hanging.manager.connect("fixture").catch(() => "failed");
    await Bun.sleep(30);
    await hanging.manager.close();
    expect(await work).toBe("failed");
    expect(hanging.manager.status()[0].state).toBe("disconnected");
  });

  test("failed synchronization never advances the local document snapshot", async () => {
    const { manager, root } = await fixture("no-sync");
    await manager.connect("fixture");
    await manager.query("fixture", "symbols", { path: "a.ts" });
    await writeFile(path.join(root, "a.ts"), "changed");
    await expect(manager.query("fixture", "symbols", { path: "a.ts" })).rejects.toThrow("does not support document changes");
    await expect(manager.query("fixture", "symbols", { path: "a.ts" })).rejects.toThrow("does not support document changes");
  });

  test("a file changed while diagnostics are pending cannot be reported fresh", async () => {
    const { manager, root } = await fixture("delayed");
    await manager.connect("fixture");
    const pending = manager.diagnostics("fixture", "a.ts");
    await Bun.sleep(30);
    await writeFile(path.join(root, "a.ts"), "BROKEN");
    expect((await pending).status).toBe("unavailable");
  });

  test("server death after writes reports changed paths and unavailable diagnostics", async () => {
    const { manager, root } = await fixture("crash-change");
    await manager.connect("fixture");
    const result = await manager.rename("fixture", "a.ts", position, "new", async () => true);
    expect(result.changed).toEqual(["a.ts", "b.ts"]);
    expect(result.diagnostics.every((report) => report.status === "unavailable")).toBe(true);
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("new();");
  });

  test("partial I/O failure discloses modified paths and never rolls back user data", async () => {
    const { root } = await fixture();
    const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "new" };
    const changes = Object.fromEntries(["a.ts", "b.ts"].map((file) => [pathToFileURL(path.join(root, file)).href, [edit]]));
    const plan = await planWorkspaceEdit(root, { changes }, new Map());
    await chmod(path.join(root, "b.ts"), 0o444);
    await expect(commitPlan(root, plan)).rejects.toThrow('possibly modified files: ["a.ts"]');
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("new();");
    expect(await readFile(path.join(root, "b.ts"), "utf8")).toBe("old();");
  });

  test("diagnostics synchronize changed open dependencies before claiming freshness", async () => {
    const { manager, root } = await fixture("dependency");
    await manager.connect("fixture");
    await manager.query("fixture", "symbols", { path: "a.ts" });
    await manager.query("fixture", "symbols", { path: "b.ts" });
    expect((await manager.diagnostics("fixture", "a.ts")).diagnostics).toEqual([]);
    await writeFile(path.join(root, "b.ts"), "BROKEN");
    const report = await manager.diagnostics("fixture", "a.ts");
    expect(report.status).toBe("fresh");
    expect(report.diagnostics).toHaveLength(1);
  });

  test("simultaneous dependent/dependency changes invalidate premature reports", async () => {
    const { manager, root } = await fixture("dependency");
    await manager.connect("fixture");
    await manager.query("fixture", "symbols", { path: "a.ts" });
    await manager.query("fixture", "symbols", { path: "b.ts" });
    await writeFile(path.join(root, "a.ts"), "changed();");
    await writeFile(path.join(root, "b.ts"), "BROKEN");
    const report = await manager.diagnostics("fixture", "a.ts");
    expect(report.status).toBe("fresh");
    expect(report.diagnostics).toHaveLength(1);
  });

  test("post-rename evidence waits until all dependency contents are synchronized", async () => {
    const { manager } = await fixture("rename-dependency");
    await manager.connect("fixture");
    const result = await manager.rename("fixture", "a.ts", position, "new", async () => true);
    expect(result.diagnostics.every((report) => report.diagnostics.length === 1)).toBe(true);
  });

  test("partial didChange/didSave failure invalidates connection rather than retrying an old range", async () => {
    const { manager, root } = await fixture();
    await manager.connect("fixture");
    await manager.query("fixture", "symbols", { path: "a.ts" });
    await writeFile(path.join(root, "a.ts"), "BROKEN longer content");
    const original = LSPConnection.prototype.notify;
    const notification = spyOn(LSPConnection.prototype, "notify").mockImplementation(function (this: LSPConnection, method, params) {
      if (method === "textDocument/didSave") throw new Error("LSP output budget exceeded");
      return original.call(this, method, params);
    });
    try { await expect(manager.diagnostics("fixture", "a.ts")).rejects.toThrow(); }
    finally { notification.mockRestore(); }
    await expect(manager.query("fixture", "symbols", { path: "a.ts" })).rejects.toThrow("not connected");
    await manager.connect("fixture");
    expect((await manager.diagnostics("fixture", "a.ts")).diagnostics).toHaveLength(1);
  });

  test("new source files added during approval revoke the whole rename", async () => {
    const { manager, root } = await fixture();
    await manager.connect("fixture");
    await expect(manager.rename("fixture", "a.ts", position, "new", async () => {
      await writeFile(path.join(root, "added.ts"), "old();");
      return true;
    })).rejects.toThrow("membership changed");
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("old();");
  });

  test("disconnect after the commit gate cancels remaining validation and writes", async () => {
    const { manager, root } = await fixture();
    await manager.connect("fixture");
    await expect(manager.rename("fixture", "a.ts", position, "new", async () => true, async (_paths, work) => {
      const pending = work();
      const handled = pending.catch((error) => { throw error; });
      // Attach a rejection observer while teardown is awaited.
      void handled.catch(() => {});
      await manager.disconnect("fixture");
      return handled;
    })).rejects.toThrow();
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("old();");
    expect(await readFile(path.join(root, "b.ts"), "utf8")).toBe("old();");
  });

  test.each(["approval", "locks"])("cancellation bounds an uncooperative %s callback and prevents late writes", async (stage) => {
    const { manager, root } = await fixture();
    await manager.connect("fixture");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const pending = manager.rename("fixture", "a.ts", position, "new", async () => {
      if (stage === "approval") { entered.resolve(); await release.promise; }
      return true;
    }, async (_paths, work) => {
      if (stage === "locks") { entered.resolve(); await release.promise; }
      return work();
    }, controller.signal).then(() => "written", () => "cancelled");
    await entered.promise;
    controller.abort();
    try { expect(await Promise.race([pending, Bun.sleep(200).then(() => "blocked")])).toBe("cancelled"); }
    finally { release.resolve(); await pending; }
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("old();");
  });

  test("tool arguments cannot grant approval and bounds are checked without Pi", async () => {
    const { manager } = await fixture();
    await manager.connect("fixture");
    const tool = lspTools(manager, async () => false)[0];
    expect((await tool.execute({ server: "fixture", operation: "rename", path: "a.ts", line: 0, character: 0, newName: "new", approved: true })).isError).toBe(true);
    expect((await tool.execute({ server: "fixture", operation: "definition", path: "a.ts", line: -1, character: 0 })).isError).toBe(true);
    expect((await tool.execute({ server: "fixture", operation: "rename", path: "a.ts", line: 0, character: 0, newName: "new" })).text).toContain("not approved");
  });
});
