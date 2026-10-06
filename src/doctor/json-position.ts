/**
 * Where a JSON file first goes wrong, as a line and column (both from 1). JSON.parse says what is wrong but not
 * where, so this walks the text once with the same rules (strict JSON: no comments, no trailing commas).
 * Undefined when the text is valid JSON.
 */
export function jsonErrorPosition(text: string): { line: number; column: number } | undefined {
  let index = 0;
  const fail = (at = index): never => { throw at; };
  const space = () => { while (index < text.length && " \t\n\r".includes(text[index]!)) index++; };
  const literal = (word: string) => { if (text.startsWith(word, index)) index += word.length; else fail(); };
  const string = () => {
    index++;
    for (;;) {
      if (index >= text.length) fail();
      const char = text[index]!;
      if (char === "\"") { index++; return; }
      if (char < " ") fail();
      if (char === "\\") {
        const next = text[index + 1];
        if (next === "u") { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) fail(index + 1); index += 6; continue; }
        if (next === undefined || !"\"\\/bfnrt".includes(next)) fail(index + 1);
        index += 2; continue;
      }
      index++;
    }
  };
  const number = () => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (!match) fail();
    index += match![0].length;
  };
  const value = (depth: number): void => {
    if (depth > 512) fail();
    space();
    const char = text[index];
    if (char === "{") {
      index++; space();
      if (text[index] === "}") { index++; return; }
      for (;;) {
        space();
        if (text[index] !== "\"") fail();
        string(); space();
        if (text[index] !== ":") fail();
        index++;
        value(depth + 1); space();
        if (text[index] === ",") { index++; continue; }
        if (text[index] === "}") { index++; return; }
        fail();
      }
    }
    if (char === "[") {
      index++; space();
      if (text[index] === "]") { index++; return; }
      for (;;) {
        value(depth + 1); space();
        if (text[index] === ",") { index++; continue; }
        if (text[index] === "]") { index++; return; }
        fail();
      }
    }
    if (char === "\"") return string();
    if (char === "t") return literal("true");
    if (char === "f") return literal("false");
    if (char === "n") return literal("null");
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return number();
    fail();
  };
  try {
    value(0);
    space();
    if (index < text.length) fail();
    return undefined;
  } catch (at) {
    if (typeof at !== "number") throw at;
    const before = text.slice(0, Math.min(at, text.length));
    const lines = before.split("\n");
    return { line: lines.length, column: lines.at(-1)!.length + 1 };
  }
}
