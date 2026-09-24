import { afterEach, expect, test } from "bun:test";
import { radiusTest } from "../src/client";
import { startMockRadius, text, vsa, type Script } from "../tests/mock-radius";

const SECRET = "s3cret-lab-only";
let close: (() => void) | undefined;
afterEach(() => { close?.(); close = undefined; });
async function server(script: Script) {
  const mock = await startMockRadius(SECRET, script);
  close = mock.close;
  return mock;
}
const base = (port: number) => ({ host: "127.0.0.1", port, secret: SECRET, username: "alice", password: "correct horse battery staple", timeoutMs: 150, retries: 2 });

test("Access-Accept with Reply-Message, Aruba-User-Role and every Cisco-AVPair", async () => {
  const mock = await server((_request, password) => password === "correct horse battery staple" ? [{ code: 2, attributes: [
    text(18, "Welcome, "), text(18, "alice"),
    vsa(9, [1, "shell:priv-lvl=15"], [1, "shell:roles=network-admin"]),
    vsa(14823, [1, "employee"]), vsa(14823, [1, "guest"]),
    vsa(9, [2, "not-an-avpair"]), vsa(311, [1, "other-vendor"]), vsa(9, [1, "tunnel-type=vlan"]),
  ] }] : [{ code: 3 }]);
  expect(await radiusTest(base(mock.port))).toEqual({
    status: "accept", attempts: 1, replyMessages: ["Welcome, ", "alice"], arubaUserRole: "employee",
    ciscoAvPairs: ["shell:priv-lvl=15", "shell:roles=network-admin", "tunnel-type=vlan"],
  });
});

test("a wrong password is an Access-Reject with its message", async () => {
  const mock = await server((_request, password) => password === "right" ? [{ code: 2 }] : [{ code: 3, attributes: [text(18, "Denied")] }]);
  expect(await radiusTest(base(mock.port))).toEqual({ status: "reject", attempts: 1, replyMessages: ["Denied"], arubaUserRole: null, ciscoAvPairs: [] });
});

test("Access-Challenge is reported as a challenge", async () => {
  const mock = await server(() => [{ code: 11, attributes: [text(18, "Enter OTP")] }]);
  expect(await radiusTest(base(mock.port))).toMatchObject({ status: "challenge", replyMessages: ["Enter OTP"] });
});

test("lost requests are retransmitted identically until a reply arrives", async () => {
  const mock = await server((_request, _password, attempt) => attempt < 3 ? null : [{ code: 2 }]);
  expect(await radiusTest(base(mock.port))).toMatchObject({ status: "accept", attempts: 3 });
  expect(mock.requests).toHaveLength(3);
  expect(new Set(mock.requests.map((request) => `${request.identifier}:${request.authenticator.toString("hex")}`)).size).toBe(1);
});

test("no reply at all is a timeout after retries + 1 attempts", async () => {
  const mock = await server(() => null);
  const started = performance.now();
  expect(await radiusTest({ ...base(mock.port), retries: 1 })).toEqual({ status: "timeout", attempts: 2, replyMessages: [], arubaUserRole: null, ciscoAvPairs: [] });
  expect(mock.requests).toHaveLength(2);
  expect(performance.now() - started).toBeLessThan(1500);
});

test("a reply signed with a different secret is discarded and reported as bad-response", async () => {
  const mock = await server(() => [{ code: 2, secret: "some-other-secret", attributes: [text(18, "forged")] }]);
  expect(await radiusTest(base(mock.port))).toEqual({ status: "bad-response", attempts: 3, replyMessages: [], arubaUserRole: null, ciscoAvPairs: [] });
});

test("a reply with the wrong identifier is ignored; the real one still counts", async () => {
  const mock = await server((request) => [
    { code: 3, identifier: (request.identifier + 1) % 256, attributes: [text(18, "not yours")] },
    { code: 2, attributes: [text(18, "yours")] },
  ]);
  expect(await radiusTest(base(mock.port))).toMatchObject({ status: "accept", attempts: 1, replyMessages: ["yours"] });
});

test("a forged reply followed by a valid one is accepted", async () => {
  const mock = await server(() => [{ code: 3, secret: "wrong" }, { code: 2 }]);
  expect(await radiusTest(base(mock.port))).toMatchObject({ status: "accept", attempts: 1 });
});

function capture() {
  const io = { stdout: "", stderr: "", out(value: string) { io.stdout += value; }, err(value: string) { io.stderr += value; } };
  return io;
}
const cli = async () => (await import(`${import.meta.dir}/../src/cli`)) as { main(argv: string[], io: ReturnType<typeof capture>): Promise<number> };
const argv = (port: number, extra: string[] = []) => ["--host", "127.0.0.1", "--port", String(port), "--secret", SECRET, "--user", "alice", "--password", "pw", "--timeout", "100", "--retries", "0", ...extra];

test("CLI: human output lists the verdict and attributes; exit 0 on accept", async () => {
  const mock = await server(() => [{ code: 2, attributes: [text(18, "Hi"), vsa(14823, [1, "employee"]), vsa(9, [1, "shell:priv-lvl=15"])] }]);
  const io = capture();
  expect(await (await cli()).main(argv(mock.port), io)).toBe(0);
  expect(io.stdout.trimEnd()).toBe(`Access-Accept from 127.0.0.1:${mock.port} (attempts 1)\n  Reply-Message: Hi\n  Aruba-User-Role: employee\n  Cisco-AVPair: shell:priv-lvl=15`);
});

test("CLI: --json prints the result; exit codes 1 reject, 2 timeout and bad-response", async () => {
  const { main } = await cli();
  let mock = await server(() => [{ code: 3 }]);
  let io = capture();
  expect(await main(argv(mock.port, ["--json"]), io)).toBe(1);
  expect(JSON.parse(io.stdout)).toEqual({ status: "reject", attempts: 1, replyMessages: [], arubaUserRole: null, ciscoAvPairs: [] });
  close?.();
  mock = await server(() => null);
  io = capture();
  expect(await main(argv(mock.port, ["--json"]), io)).toBe(2);
  expect(JSON.parse(io.stdout).status).toBe("timeout");
  close?.();
  mock = await server(() => [{ code: 2, secret: "nope" }]);
  io = capture();
  expect(await main(argv(mock.port), io)).toBe(2);
  expect(io.stdout.toLowerCase()).toContain("secret");
});

test("CLI: missing or malformed options are usage errors (64) on stderr", async () => {
  const { main } = await cli();
  for (const args of [[], ["--host", "127.0.0.1", "--user", "a", "--password", "b"], [...argv(1812).slice(0, -2), "--retries", "x"], [...argv(1812), "--bogus"], ["--host"]]) {
    const io = capture();
    expect(await main(args, io)).toBe(64);
    expect(io.stdout).toBe("");
    expect(io.stderr.toLowerCase()).toContain("usage:");
  }
});
