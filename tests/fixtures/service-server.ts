import { writeFileSync } from "node:fs";

// A real development-server stand-in for the owned-process runner and service
// tests. Env switches: SLOW_READY_MS delays listening, READY_LOG is printed once
// listening, CRASH_AFTER_MS exits with code 3, NOISE_BYTES floods stdout first,
// SPAWN_CHILD names a file that receives a long-lived grandchild's PID, PRINT_ENV
// (comma-separated names) prints those variables as one JSON line.
const env = process.env;
console.log("booting");
if (env.PRINT_ENV) console.log(`env ${JSON.stringify(Object.fromEntries(env.PRINT_ENV.split(",").map(name => [name, env[name] ?? null])))}`);
if (env.SPAWN_CHILD) {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] });
  writeFileSync(env.SPAWN_CHILD, String(child.pid));
}
if (env.NOISE_BYTES) for (let written = 0, line = 0; written < Number(env.NOISE_BYTES); line++) {
  const text = `noise ${line} ${"x".repeat(60)}`;
  console.log(text); written += text.length + 1;
}
if (env.CRASH_AFTER_MS) setTimeout(() => { console.error("fatal: synthetic crash"); process.exit(3); }, Number(env.CRASH_AFTER_MS));
setTimeout(() => {
  Bun.serve({ hostname: env.HOST ?? "127.0.0.1", port: Number(env.PORT ?? 0), fetch: request =>
    new URL(request.url).pathname === "/health" ? Response.json({ ok: true }) : new Response("hello from service") });
  console.log(env.READY_LOG ?? "listening");
}, Number(env.SLOW_READY_MS ?? 0));
