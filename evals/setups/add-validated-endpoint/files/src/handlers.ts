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
