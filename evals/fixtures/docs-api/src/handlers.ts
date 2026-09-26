import { createHash } from "node:crypto";
import { json, jsonError } from "./http";
import type { Doc, Store } from "./store";

/** A strong validator derived from the representation: same JSON, same tag. */
function etagOf(doc: Doc): string {
  return `"${createHash("sha256").update(JSON.stringify(doc)).digest("hex").slice(0, 16)}"`;
}

const tags = (header: string) => header.split(",").map((tag) => tag.trim()).filter((tag) => tag !== "");
const opaque = (tag: string) => (tag.startsWith("W/") ? tag.slice(2) : tag);

function noneMatch(header: string, current: string): boolean {
  return tags(header).some((tag) => tag === "*" || opaque(tag) === current);
}

function anyMatch(header: string, current: string): boolean {
  return tags(header).some((tag) => tag === "*" || (!tag.startsWith("W/") && tag === current));
}

export function getDoc(store: Store, id: number, request: Request): Response {
  const doc = store.get(id);
  if (!doc) return jsonError(404, "not_found");
  const etag = etagOf(doc);
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch !== null && noneMatch(ifNoneMatch, etag)) return new Response(null, { status: 304, headers: { etag } });
  return json(200, doc, { etag });
}

export async function putDoc(store: Store, id: number, request: Request): Promise<Response> {
  const current = store.get(id);
  if (!current) return jsonError(404, "not_found");
  const ifMatch = request.headers.get("if-match");
  if (ifMatch === null) return jsonError(428, "precondition_required");
  if (!anyMatch(ifMatch, etagOf(current))) return jsonError(412, "precondition_failed");
  let input: unknown;
  try { input = await request.json(); } catch { return jsonError(400, "invalid_json"); }
  if (typeof input !== "object" || input === null || typeof (input as { body?: unknown }).body !== "string") return jsonError(422, "validation_failed");
  const doc = store.put(id, (input as { body: string }).body);
  return json(200, doc, { etag: etagOf(doc) });
}
