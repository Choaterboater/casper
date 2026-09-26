import { json, jsonError } from "./http";
import type { Store } from "./store";

export function getDoc(store: Store, id: number, _request: Request): Response {
  const doc = store.get(id);
  if (!doc) return jsonError(404, "not_found");
  return json(200, doc);
}

export async function putDoc(store: Store, id: number, request: Request): Promise<Response> {
  if (!store.get(id)) return jsonError(404, "not_found");
  let input: unknown;
  try { input = await request.json(); } catch { return jsonError(400, "invalid_json"); }
  if (typeof input !== "object" || input === null || typeof (input as { body?: unknown }).body !== "string") return jsonError(422, "validation_failed");
  return json(200, store.put(id, (input as { body: string }).body));
}
