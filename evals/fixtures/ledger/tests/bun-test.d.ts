/** Minimal `bun:test` surface so `tsc --noEmit` can cover `tests/` without installed packages. */
declare module "bun:test" {
  export function test(name: string, body: () => void | Promise<void>): void;
  export function expect(value: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toThrow(expected?: string | RegExp): void;
  };
}
