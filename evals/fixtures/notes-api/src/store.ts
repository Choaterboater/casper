export interface Note {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
}

export interface NoteStore {
  list(): Note[];
  get(id: number): Note | undefined;
  add(note: Omit<Note, "id">): Note;
}

export function createStore(seed: readonly Omit<Note, "id">[] = []): NoteStore {
  const notes: Note[] = [];
  let next = 1;
  const add = (note: Omit<Note, "id">): Note => {
    const saved = { id: next++, ...note, tags: [...note.tags] };
    notes.push(saved);
    return saved;
  };
  for (const note of seed) add(note);
  return {
    list: () => [...notes],
    get: (id) => notes.find((note) => note.id === id),
    add,
  };
}
