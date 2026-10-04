import path from "node:path";

/**
 * True when a `path.relative` result leaves its base: exactly "..", a step up ("../" or "..\"),
 * or another root. A name that only starts with dots, like "..env", stays inside.
 */
export function isOutside(relative: string): boolean {
  return relative === ".." || relative.startsWith("../") || relative.startsWith("..\\") || path.isAbsolute(relative);
}
