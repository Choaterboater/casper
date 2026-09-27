export class SemverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemverError";
  }
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
  build: string[];
}

export function parse(_version: string): ParsedVersion {
  throw new Error("not implemented");
}

export function compare(_a: string, _b: string): -1 | 0 | 1 {
  throw new Error("not implemented");
}

export function satisfies(_version: string, _range: string, _options?: { includePrerelease?: boolean }): boolean {
  throw new Error("not implemented");
}

export function maxSatisfying(_versions: string[], _range: string): string | null {
  throw new Error("not implemented");
}

export function minSatisfying(_versions: string[], _range: string): string | null {
  throw new Error("not implemented");
}

export function sort(_versions: string[]): string[] {
  throw new Error("not implemented");
}
