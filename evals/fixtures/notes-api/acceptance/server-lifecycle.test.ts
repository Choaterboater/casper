import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import path from "node:path";
import type { Subprocess } from "bun";

/** Hidden acceptance for the running server: every behavior here is only observable by starting
 * `src/server.ts` as a real process, so each test spawns it and talks to it over loopback. */

const entry = path.join(import.meta.dir, "../src/server.ts");
const spawned: Subprocess[] = [];

// Every server this file starts is killed by its PID, also when a test failed or timed out.
afterEach(async () => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

/** A loopback port nothing listens on right now. */
async function freePort(host: string): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, host, resolve); });
  const { port } = probe.address() as net.AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const connects = (host: string, port: number) => new Promise<boolean>((resolve) => {
  const socket = net.connect({ host, port });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});

/** Start the server with PORT/HOST and wait until it accepts connections there, or fail with its output. */
async function start(host = "127.0.0.1") {
  let port = await freePort(host);
  // On ::1 the port must be free on IPv4 loopback too, so that an answer there is never someone else's.
  while (host !== "127.0.0.1" && await connects("127.0.0.1", port)) port = await freePort(host);
  const child = Bun.spawn([process.execPath, entry], {
    cwd: path.dirname(path.dirname(entry)), env: { ...process.env, PORT: String(port), HOST: host },
    stdout: "pipe", stderr: "pipe",
  });
  spawned.push(child);
  // Drain the pipes from the start: a server that logs every request must never block on a full pipe.
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then((parts) => parts.join(""));
  console.log(`[server-lifecycle] spawned pid ${child.pid}`);
  const started = performance.now();
  while (!await connects(host, port)) {
    if (child.exitCode !== null || child.signalCode !== null || performance.now() - started > 5_000) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      throw new Error(`server did not listen on ${host}:${port} within 5 s (PORT=${port} HOST=${host}):\n${(await output).slice(-2000)}`);
    }
    await Bun.sleep(50);
  }
  const origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  return { child, host, port, origin, started };
}

test("GET /health answers 200 JSON with status ok and a growing whole-millisecond uptime", async () => {
  const server = await start();
  const read = async () => {
    const response = await fetch(`${server.origin}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    return await response.json() as { status: unknown; uptimeMs: unknown };
  };
  const first = await read();
  expect(first.status).toBe("ok");
  expect(Number.isInteger(first.uptimeMs)).toBe(true);
  expect(first.uptimeMs as number).toBeGreaterThanOrEqual(0);
  // Measured from the server's start: never more than the time since it was spawned.
  expect(first.uptimeMs as number).toBeLessThanOrEqual(performance.now() - server.started + 50);
  await Bun.sleep(300);
  const second = await read();
  expect((second.uptimeMs as number) - (first.uptimeMs as number)).toBeGreaterThanOrEqual(250);
  // The existing routes are still served.
  expect((await fetch(`${server.origin}/notes`)).status).toBe(200);
}, 10_000);

test("the server listens on the PORT it is given", async () => {
  const server = await start("127.0.0.1");
  const response = await fetch(`${server.origin}/notes`);
  expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { notes: [] } });
}, 10_000);

test("the server listens on the HOST it is given, including IPv6 loopback", async () => {
  const server = await start("::1");
  expect((await fetch(`${server.origin}/notes`)).status).toBe(200);
  // Bound to ::1 only, so IPv4 loopback on the same port is not this server.
  const ipv4 = await fetch(`http://127.0.0.1:${server.port}/notes`).then((response) => response.status, () => null);
  expect(ipv4).toBeNull();
}, 10_000);

test("on SIGTERM an in-flight request still completes, then the server exits 0 within 2 s", async () => {
  const server = await start();
  const body = JSON.stringify({ title: "drained" });
  const socket = net.connect({ host: server.host, port: server.port });
  let answer = "";
  socket.on("data", (chunk) => { answer += chunk; });
  socket.on("error", () => {});
  const closed = new Promise((resolve) => socket.once("close", resolve));
  await new Promise((resolve) => socket.once("connect", resolve));
  // Half the body now: the request is in progress when the signal arrives.
  socket.write(`POST /notes HTTP/1.1\r\nHost: ${server.host}\r\nContent-Type: application/json\r\n`
    + `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.slice(0, 5)}`);
  await Bun.sleep(150);
  const signalled = performance.now();
  server.child.kill("SIGTERM");
  await Bun.sleep(300);
  socket.write(body.slice(5));
  await Promise.race([closed, Bun.sleep(2_500)]);
  socket.destroy();
  expect(answer.split("\r\n")[0]).toBe("HTTP/1.1 201 Created");
  const exited = await Promise.race([server.child.exited.then(() => true), Bun.sleep(2_000 - (performance.now() - signalled)).then(() => false)]);
  expect({ exitedWithin2s: exited, exitCode: server.child.exitCode, signal: server.child.signalCode })
    .toEqual({ exitedWithin2s: true, exitCode: 0, signal: null });
}, 10_000);
