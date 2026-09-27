export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

export type Match =
  | { status: 200; route: string; name: string; params: Record<string, string> }
  | { status: 204 | 405; allow: string[] }
  | { status: 400 | 404 };

export class Router {
  add(_method: string, _pattern: string, _name: string): void {
    throw new Error("not implemented");
  }

  match(_method: string, _path: string): Match {
    throw new Error("not implemented");
  }

  list(): string[] {
    throw new Error("not implemented");
  }
}
