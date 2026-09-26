import { createApp } from "./app";

/** Serves the app on `PORT`/`HOST` (defaults 3000 and 127.0.0.1). */
const app = createApp();
const server = Bun.serve({
  hostname: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3000),
  fetch: (request) => app.handle(request),
});
console.info(`docs-api listening on http://${server.hostname}:${server.port}`);
