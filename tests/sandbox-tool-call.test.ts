import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { ShellSandbox } from "../src/sandbox/manager";
import { toolCallId, withToolCall } from "../src/runtime/tool-reason";
import { fakeEngine } from "./support/sandbox-fakes";
import { removeTempDir } from "./support/temp-dir";

/**
 * The sandbox's proxy starts lazily, at the first command, which may run inside a tool call. Its host questions must
 * not carry that call's id for the rest of the session: the proxy can't tell whose command reached out, so an ACP
 * "Allow <host>?" box names no step (decision 85).
 */

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
  await Promise.all(roots.splice(0).map((root) => removeTempDir(root)));
});

/** A fake engine that starts a proxy server in initialize, as the sandbox runtime does, and asks about each request's host. */
function proxyEngine() {
  const engine = fakeEngine();
  let port = 0;
  engine.initialize = async (_policy, ask) => {
    const server = createServer((request, response) => {
      void ask(request.headers["x-host"] as string, 443).then((allowed) => response.end(allowed ? "yes" : "no"));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  };
  const reach = async (host: string) => (await fetch(`http://127.0.0.1:${port}/`, { headers: { "x-host": host } })).text();
  return { engine, reach };
}

test("A host question from a proxy started inside a tool call names no tool call, from inside another call or outside any", async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-call-")));
  roots.push(base);
  const { engine, reach } = proxyEngine();
  const seen: Array<string | undefined> = [];
  const sandbox = new ShellSandbox({ root: () => base, platform: "linux", engine, problem: () => undefined,
    askHost: () => { seen.push(toolCallId()); return Promise.resolve("no"); } });
  // The first command starts the sandbox inside its own tool call.
  await withToolCall("call_first", () => sandbox.wrap("true", { cwd: base }));
  expect(await withToolCall("call_second", () => reach("one.example.com"))).toBe("no");
  expect(await reach("two.example.com")).toBe("no");
  expect(seen).toEqual([undefined, undefined]);
  await sandbox.close();
});
