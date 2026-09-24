import { json, jsonError } from "./http";
import type { NoteStore } from "./store";

export function listNotes(store: NoteStore): Response {
  return json(200, { notes: store.list() });
}

export function getNote(store: NoteStore, rawId: string): Response {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) return jsonError(400, "invalid_id");
  const note = store.get(id);
  return note ? json(200, note) : jsonError(404, "not_found");
}

const FIELDS = new Set(["title", "body", "tags"]);
const TAG = /^[a-z0-9-]{1,20}$/;

/** Validate a create request. Returns the field errors, or the normalized note. */
function validate(input: unknown): { fields: Record<string, string> } | { note: { title: string; body: string; tags: string[] } } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { fields: { body: "must be a JSON object" } };
  const record = input as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const key of Object.keys(record)) if (!FIELDS.has(key)) fields[key] = "unknown field";
  const title = typeof record.title === "string" ? record.title.trim() : undefined;
  if (title === undefined) fields.title = "required string";
  else if (title.length < 1 || title.length > 100) fields.title = "must be 1-100 characters";
  const body = record.body === undefined ? "" : record.body;
  if (typeof body !== "string") fields.body = "must be a string";
  else if (body.length > 1000) fields.body = "must be at most 1000 characters";
  const tags = record.tags === undefined ? [] : record.tags;
  if (!Array.isArray(tags)) fields.tags = "must be an array";
  else if (tags.length > 5) fields.tags = "at most 5 tags";
  else if (!tags.every((tag) => typeof tag === "string" && TAG.test(tag))) fields.tags = "tags are 1-20 of a-z, 0-9 and -";
  else if (new Set(tags).size !== tags.length) fields.tags = "tags must be unique";
  if (Object.keys(fields).length) return { fields };
  return { note: { title: title!, body: body as string, tags: tags as string[] } };
}

export async function createNote(store: NoteStore, request: Request): Promise<Response> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) return jsonError(415, "unsupported_media_type");
  let input: unknown;
  try { input = JSON.parse(await request.text()); }
  catch { return jsonError(400, "invalid_json"); }
  const result = validate(input);
  if ("fields" in result) return jsonError(422, "validation_failed", { fields: result.fields });
  const note = store.add(result.note);
  return json(201, note, { location: `/notes/${note.id}` });
}
