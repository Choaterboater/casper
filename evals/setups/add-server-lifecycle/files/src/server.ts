import { createApp } from "./app";

/** Serves the app on 127.0.0.1 at a port the OS picks (printed below), so it can be run and observed as a
 * real server without two copies ever sharing a port. */
const app = createApp();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => app.handle(request),
});
console.info(`notes-api listening on http://${server.hostname}:${server.port}`);
