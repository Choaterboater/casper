import { createApp } from "./app";

/** Serves the app on http://127.0.0.1:3000, so it can be run and observed as a real server. */
const app = createApp();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 3000,
  fetch: (request) => app.handle(request),
});
console.info(`notes-api listening on http://${server.hostname}:${server.port}`);
