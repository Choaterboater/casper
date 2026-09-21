import type { Handler } from "./router";

/** Registered as `GET /health`. */
export const health: Handler = () => ({ status: 200, body: { status: "ok" } });
