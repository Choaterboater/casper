import { getDoc, putDoc } from "./handlers";
import { jsonError } from "./http";
import { createStore } from "./store";

export interface App {
  handle(request: Request): Promise<Response>;
}

export function createApp(seed?: readonly string[]): App {
  const store = createStore(seed);
  return {
    async handle(request) {
      const match = /^\/docs\/(\d+)$/.exec(new URL(request.url).pathname);
      if (!match) return jsonError(404, "not_found");
      const id = Number(match[1]);
      if (request.method === "GET") return getDoc(store, id, request);
      if (request.method === "PUT") return putDoc(store, id, request);
      return jsonError(405, "method_not_allowed");
    },
  };
}
