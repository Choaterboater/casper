import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LSPManager } from "../src/lsp/manager";
import { LSPConnection, MessageReader } from "../src/lsp/protocol";
import { snapshot, MAX_FILE_BYTES } from "../src/lsp/workspace";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); });
async function fixture(mode = "normal", timeoutMs = 2000) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-lsp-stress-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.ts"), "old();");
  const client = new LSPManager(root, { servers: [{ name: "fixture", source: "test", command: process.execPath,
    args: [path.join(import.meta.dir, "fixtures/lsp-server.ts"), mode, path.join(root, "started")], languages: { ".ts": "typescript" } }], diagnostics: [] }, timeoutMs);
  cleanup.push(() => client.close());
  return { root, client };
}

test("disconnect immediately cancels startup consent without launching a late server", async () => {
  const { root, client } = await fixture();
  const connecting = client.connect("fixture").then(() => "connected", () => "cancelled");
  await client.disconnect("fixture");
  expect(await connecting).toBe("cancelled");
  expect(await readFile(path.join(root, "started"), "utf8").catch(() => "absent")).toBe("absent");
  await client.connect("fixture");
  expect(client.status()[0].state).toBe("ready");
});

test("cancelled queued reads settle before the active approval finishes", async () => {
  const { client } = await fixture();
  await client.connect("fixture");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<boolean>();
  const rename = client.rename("fixture", "a.ts", { line: 0, character: 1 }, "new", async () => {
    entered.resolve(); return release.promise;
  }).catch(() => {});
  await entered.promise;
  const controller = new AbortController();
  const read = client.query("fixture", "symbols", { path: "a.ts" }, controller.signal).then(() => "ran", () => "cancelled");
  controller.abort();
  try { expect(await Promise.race([read, Bun.sleep(150).then(() => "blocked")])).toBe("cancelled"); }
  finally { release.resolve(false); await rename; await read; }
});

test("post-rename missing diagnostics share one wait budget rather than one per file", async () => {
  const { root, client } = await fixture("silent", 300);
  for (let i = 1; i < 10; i++) await writeFile(path.join(root, `file${i}.ts`), "old();");
  await client.connect("fixture");
  const start = performance.now();
  const result = await client.rename("fixture", "a.ts", { line: 0, character: 1 }, "new", async () => true);
  expect(result.changed).toHaveLength(10);
  expect(result.diagnostics.every((report) => report.status === "timeout")).toBe(true);
  expect(performance.now() - start).toBeLessThan(1500);
});

test("a concurrent disk change invalidates the entire post-rename diagnostic batch", async () => {
  const { root, client } = await fixture("pull");
  await writeFile(path.join(root, "b.ts"), "old();");
  await client.connect("fixture");
  const entered = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const original = LSPConnection.prototype.request;
  const request = spyOn(LSPConnection.prototype, "request").mockImplementation(async function (this: LSPConnection, method, params, signal, timeout) {
    if (method === "textDocument/diagnostic") {
      entered.resolve((params as { textDocument: { uri: string } }).textDocument.uri);
      await release.promise;
    }
    return original.call(this, method, params, signal, timeout);
  });
  const pending = client.rename("fixture", "a.ts", { line: 0, character: 1 }, "new", async () => true);
  try {
    const first = await entered.promise;
    await writeFile(path.join(root, first.endsWith("/a.ts") ? "b.ts" : "a.ts"), "BROKEN");
    release.resolve();
    const result = await pending;
    expect(result.changed).toHaveLength(2);
    expect(result.diagnostics.every((report) => report.status === "unavailable")).toBe(true);
  } finally { release.resolve(); await pending.catch(() => {}); request.mockRestore(); }
});

test("repeated concurrent starts, queued cancellation, and teardown leave no fixture children", async () => {
  const { root, client } = await fixture();
  for (let round = 0; round < 10; round++) {
    const start = client.connect("fixture");
    expect(client.connect("fixture")).toBe(start);
    await start;
    const work = Array.from({ length: 20 }, (_, index) => {
      const controller = new AbortController();
      const pending = client.query("fixture", "symbols", { path: "a.ts" }, controller.signal).then(() => "read", () => "cancelled");
      if (index % 2) controller.abort();
      return pending;
    });
    expect((await Promise.all(work)).filter((result) => result === "read")).toHaveLength(10);
    await client.disconnect("fixture");
  }
  const pids = (await readFile(path.join(root, "started"), "utf8")).trim().split("\n").map(Number);
  expect(pids).toHaveLength(10);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
}, 15_000);

test("batched pull diagnostics are concurrent but never exceed eight in flight", async () => {
  const { root, client } = await fixture("pull");
  for (let i = 1; i < 20; i++) await writeFile(path.join(root, `file${i}.ts`), "old();");
  await client.connect("fixture");
  let active = 0;
  let peak = 0;
  const original = LSPConnection.prototype.request;
  const request = spyOn(LSPConnection.prototype, "request").mockImplementation(async function (this: LSPConnection, method, params, signal, timeout) {
    if (method !== "textDocument/diagnostic") return original.call(this, method, params, signal, timeout);
    peak = Math.max(peak, ++active);
    try { await Bun.sleep(5); return await original.call(this, method, params, signal, timeout); }
    finally { active--; }
  });
  try {
    const result = await client.rename("fixture", "a.ts", { line: 0, character: 1 }, "new", async () => true);
    expect(result.diagnostics).toHaveLength(20);
    expect(result.diagnostics.every((report) => report.status === "fresh")).toBe(true);
    expect(peak).toBe(8);
    expect(active).toBe(0);
  } finally { request.mockRestore(); }
});

test("framing is chunk-boundary independent across deterministic fragmented streams", () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ i, text: `😀\r\n${"x".repeat(i * 271)}` }));
  const stream = Buffer.concat(messages.map((message) => {
    const body = JSON.stringify(message);
    return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }));
  for (const seed of [1, 17, 101, 1009]) {
    const received: unknown[] = [];
    const reader = new MessageReader((value) => received.push(value));
    let random = seed;
    for (let offset = 0; offset < stream.length;) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const length = 1 + random % 4096;
      reader.push(stream.subarray(offset, offset + length));
      offset += length;
    }
    expect(received).toEqual(messages);
  }
  expect(() => new MessageReader(() => {}).push(Buffer.from("x".repeat(8197)))).toThrow("header");
  expect(() => new MessageReader(() => {}).push(Buffer.concat([Buffer.from("Content-Length: 1\r\n\r\n"), Buffer.from([0xff])]))).toThrow();
});

test("snapshots retain exact byte/file bounds including UTF-8 BOM and empty files", async () => {
  const { root } = await fixture();
  for (const text of ["", "\ufeff😀\r\n", "x".repeat(MAX_FILE_BYTES)]) {
    await writeFile(path.join(root, "a.ts"), text);
    expect((await snapshot(root, "a.ts")).text).toBe(text);
  }
  await writeFile(path.join(root, "a.ts"), "x".repeat(MAX_FILE_BYTES + 1));
  await expect(snapshot(root, "a.ts")).rejects.toThrow();
  await writeFile(path.join(root, "a.ts"), Buffer.from([0xff]));
  await expect(snapshot(root, "a.ts")).rejects.toThrow();
});
