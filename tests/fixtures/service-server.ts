import { appendFileSync, writeFileSync } from "node:fs";

// A real development-server stand-in for the owned-process runner and service
// tests. Env switches: SLOW_READY_MS delays listening, READY_LOG is printed once
// listening, CRASH_AFTER_MS exits with code 3, NOISE_BYTES floods stdout first,
// SPAWN_CHILD names a file that receives a long-lived grandchild's PID, PRINT_ENV
// (comma-separated names) prints those variables as one JSON line, PID_LOG names a
// file that every started server appends its PID to. Paths: /health, /json (compact
// JSON), /big (20 KiB of text), /echo (method, x-test header and body as JSON; 201 on
// POST); anything else answers plain text.
const env = process.env;
console.log("booting");
if (env.PID_LOG) appendFileSync(env.PID_LOG, `${process.pid}\n`);
if (env.PRINT_ENV) console.log(`env ${JSON.stringify(Object.fromEntries(env.PRINT_ENV.split(",").map(name => [name, env[name] ?? null])))}`);
if (env.SPAWN_CHILD) {
  // The grandchild leaves on its own once this server has been gone for 15 s (a test that failed or timed out
  // before it stopped the service would otherwise leave it running). 15 s is well past the 5 s the tests wait
  // for a stopped service's tree to be gone, so a tree kill that missed it is still caught.
  const watch = `const parent = ${process.pid}; let gone = 0; setInterval(() => { try { process.kill(parent, 0); gone = 0; } catch { if (++gone >= 15) process.exit(0); } }, 1000)`;
  const child = Bun.spawn([process.execPath, "-e", watch], { stdio: ["ignore", "ignore", "ignore"] });
  writeFileSync(env.SPAWN_CHILD, String(child.pid));
}
if (env.NOISE_BYTES) for (let written = 0, line = 0; written < Number(env.NOISE_BYTES); line++) {
  const text = `noise ${line} ${"x".repeat(60)}`;
  console.log(text); written += text.length + 1;
}
if (env.CRASH_AFTER_MS) setTimeout(() => { console.error("fatal: synthetic crash"); process.exit(3); }, Number(env.CRASH_AFTER_MS));
setTimeout(() => {
  Bun.serve({ hostname: env.HOST ?? "127.0.0.1", port: Number(env.PORT ?? 0), fetch: async request => {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return Response.json({ ok: true });
    if (pathname === "/json") return Response.json({ items: [{ id: 1, title: "first" }], count: 1 });
    if (pathname === "/big") return new Response("x".repeat(20_480));
    if (pathname === "/echo") return Response.json({ method: request.method, test: request.headers.get("x-test"), body: await request.text() }, { status: request.method === "POST" ? 201 : 200 });
    return new Response("hello from service");
  } });
  console.log(env.READY_LOG ?? "listening");
}, Number(env.SLOW_READY_MS ?? 0));
