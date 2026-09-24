import { afterAll, expect, test } from "bun:test";
import net from "node:net";
import { main } from "../src/cli";

const server = net.createServer((socket) => socket.end());
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as net.AddressInfo).port;
afterAll(() => server.close());

function capture() {
  const io = { stdout: "", stderr: "", out(text: string) { io.stdout += text; }, err(text: string) { io.stderr += text; } };
  return io;
}

test("reports an open port and exits 0", async () => {
  const io = capture();
  expect(await main([`127.0.0.1:${port}`], io)).toBe(0);
  expect(io.stdout).toMatch(new RegExp(`^127\\.0\\.0\\.1:${port} open \\d+ms\\n$`));
});

test("a missing target is a usage error", async () => {
  const io = capture();
  expect(await main([], io)).toBe(64);
  expect(io.stderr).toContain("usage:");
});
