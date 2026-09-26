import { createApp } from "./app";

/** Serves the app on `PORT`/`HOST` (defaults 3000 and 127.0.0.1), so it can be run and observed as a real server. */
const app = createApp();
const server = Bun.serve({
  hostname: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3000),
  fetch: (request) => app.handle(request),
});
console.info(`notes-api listening on http://${server.hostname}:${server.port}`);

/** Graceful shutdown: stop accepting connections, let in-flight requests finish, then exit 0.
 * A request that outlives the grace period is cut off so the process still exits within 2 s. */
process.once("SIGTERM", () => {
  setTimeout(() => process.exit(0), 1_500).unref();
  void server.stop().then(() => process.exit(0));
});
