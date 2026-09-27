export interface WrapOptions {
  tabWidth?: number;
  hangingIndent?: number;
  maxLines?: number;
}

/** Wraps `text` to `width` columns, honoring `options`. See CONTEXT.md and the task prompt for the full contract. */
export function wrap(_text: string, _width: number, _options: WrapOptions = {}): string {
  throw new Error("not implemented");
}
