/** Declared local inputs only, not inferred dependency or behavioral coverage.
 * Paths are literal, project-relative files/directories (no globs). */
export interface VerificationScope {
  inputs: string[];
  exclude?: string[];
}

export function isVerificationScope(value: unknown): value is VerificationScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  const paths = (items: unknown): items is string[] => Array.isArray(items) && items.length <= 32 && items.every((item) =>
    typeof item === "string" && Buffer.byteLength(item) <= 256 && (item === "." ||
      (!/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\\:*?\[\]{}]/u.test(item)
        && item.split("/").every((part) => part && part !== "." && part !== ".."))));
  const { inputs, exclude } = scope;
  return Object.keys(scope).every((key) => ["inputs", "exclude"].includes(key))
    && paths(inputs) && inputs.length > 0
    && (exclude === undefined || paths(exclude))
    && !(exclude ?? []).some((excluded) => excluded === "." || inputs.some((input) => input === excluded || input.startsWith(excluded + "/")))
    && Buffer.byteLength(JSON.stringify(scope)) <= 2048;
}
