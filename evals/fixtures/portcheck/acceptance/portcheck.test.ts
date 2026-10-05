import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { main } from "../src/cli";

// A throwaway self-signed certificate, made fresh for each run: no private key is kept in the repository.
const certs = mkdtempSync(path.join(os.tmpdir(), "portcheck-certs-"));
const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=portcheck.example.com", "-days", "30",
  "-keyout", path.join(certs, "key.pem"), "-out", path.join(certs, "cert.pem")], { encoding: "utf8" });
if (made.status !== 0) throw new Error(`openssl could not make a test certificate: ${made.error?.message ?? made.stderr}`);
const cert = readFileSync(path.join(certs, "cert.pem"));
const key = readFileSync(path.join(certs, "key.pem"));
rmSync(certs, { recursive: true, force: true });
const expires = new Date(new X509Certificate(cert).validTo);

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}
const plain = net.createServer((socket) => socket.end());
const secure = tls.createServer({ cert, key }, (socket) => socket.end());
const silent: net.Socket[] = [];
const hanging = net.createServer((socket) => { silent.push(socket); });
const plainPort = await listen(plain);
const tlsPort = await listen(secure);
const hangPort = await listen(hanging);
const closed = net.createServer();
const closedPort = await listen(closed);
await new Promise((resolve) => closed.close(resolve));
afterAll(() => { for (const socket of silent) socket.destroy(); plain.close(); secure.close(); hanging.close(); });

function capture() {
  const io = { stdout: "", stderr: "", out(text: string) { io.stdout += text; }, err(text: string) { io.stderr += text; } };
  return io;
}
async function json(argv: string[]) {
  const io = capture();
  const code = await main(["--json", ...argv], io);
  expect(io.stdout.endsWith("\n")).toBe(true);
  return { code, rows: JSON.parse(io.stdout) as Array<Record<string, unknown>>, io };
}

test("--json prints one array with a row per target, in argument order", async () => {
  const { code, rows } = await json([`127.0.0.1:${plainPort}`, `127.0.0.1:${closedPort}`]);
  expect(code).toBe(1);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ target: `127.0.0.1:${plainPort}`, host: "127.0.0.1", port: plainPort, status: "open" });
  expect(typeof rows[0]!.ms).toBe("number");
  expect(rows[1]).toMatchObject({ target: `127.0.0.1:${closedPort}`, host: "127.0.0.1", port: closedPort, status: "closed" });
  expect(rows[0]).not.toHaveProperty("tls");
});

test("an unparseable target is reported as invalid with null fields, not a usage error", async () => {
  const { code, rows } = await json(["no-port", "127.0.0.1:70000", `127.0.0.1:${plainPort}`]);
  expect(code).toBe(1);
  expect(rows.map((row) => row.status)).toEqual(["invalid", "invalid", "open"]);
  expect(rows[0]).toMatchObject({ target: "no-port", host: null, port: null, ms: null });
});

test("--tls reports the certificate expiry and whole days left", async () => {
  const { code, rows } = await json(["--tls", `127.0.0.1:${tlsPort}`]);
  expect(code).toBe(0);
  const row = rows[0]!;
  expect(row.status).toBe("open");
  const info = row.tls as { expires: string; daysLeft: number };
  expect(new Date(info.expires).getTime()).toBe(expires.getTime());
  expect(info.expires).toBe(expires.toISOString());
  expect(info.daysLeft).toBe(Math.floor((expires.getTime() - Date.now()) / 86_400_000));
});

test("--tls against a non-TLS listener is a tls-error, not open", async () => {
  const { code, rows } = await json(["--tls", "--timeout", "2000", `127.0.0.1:${plainPort}`]);
  expect(code).toBe(1);
  expect(rows[0]!.status).toBe("tls-error");
});

test("a handshake that never completes times out within --timeout", async () => {
  const started = performance.now();
  const { code, rows } = await json(["--tls", "--timeout", "300", `127.0.0.1:${hangPort}`]);
  expect(code).toBe(1);
  expect(rows[0]!.status).toBe("timeout");
  expect(performance.now() - started).toBeLessThan(2000);
});

test("human output shows the TLS expiry date and days", async () => {
  const io = capture();
  expect(await main(["--tls", `127.0.0.1:${tlsPort}`], io)).toBe(0);
  expect(io.stdout).toContain(`127.0.0.1:${tlsPort} open`);
  expect(io.stdout).toContain(`expires ${expires.toISOString().slice(0, 10)}`);
  expect(io.stdout).toMatch(/\(\d+ days\)/);
});

test("unknown flags and bad timeouts are usage errors on stderr with exit 64", async () => {
  for (const argv of [["--bogus", `127.0.0.1:${plainPort}`], ["--timeout", "0", `127.0.0.1:${plainPort}`], ["--timeout", "soon", `127.0.0.1:${plainPort}`], ["--json"]]) {
    const io = capture();
    expect(await main(argv, io)).toBe(64);
    expect(io.stdout).toBe("");
    expect(io.stderr).toContain("usage:");
  }
});
