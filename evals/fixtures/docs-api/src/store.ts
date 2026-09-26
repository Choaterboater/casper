export interface Doc {
  readonly id: number;
  readonly body: string;
}

export interface Store {
  get(id: number): Doc | undefined;
  put(id: number, body: string): Doc;
}

export function createStore(seed: readonly string[] = ["Welcome"]): Store {
  const docs = new Map<number, Doc>(seed.map((body, index) => [index + 1, { id: index + 1, body }]));
  return {
    get: (id) => docs.get(id),
    put(id, body) {
      const doc = { id, body };
      docs.set(id, doc);
      return doc;
    },
  };
}
