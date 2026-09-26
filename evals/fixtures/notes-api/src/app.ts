import { createNote, getNote, health, listNotes } from "./handlers";
import { jsonError } from "./http";
import { createStore, type Note } from "./store";

export interface App {
  handle(request: Request): Promise<Response>;
}

export function createApp(seed: readonly Omit<Note, "id">[] = []): App {
  const store = createStore(seed);
  const started = performance.now();
  return {
    async handle(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/health") {
        if (request.method === "GET") return health(started);
        return jsonError(405, "method_not_allowed");
      }
      if (pathname === "/notes") {
        if (request.method === "GET") return listNotes(store);
        if (request.method === "POST") return createNote(store, request);
        return jsonError(405, "method_not_allowed");
      }
      const match = /^\/notes\/([^/]+)$/.exec(pathname);
      if (match) {
        if (request.method === "GET") return getNote(store, match[1]!);
        return jsonError(405, "method_not_allowed");
      }
      return jsonError(404, "not_found");
    },
  };
}
