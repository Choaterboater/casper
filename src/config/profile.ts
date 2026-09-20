/** One literal path component, shared by policy and capability configuration. */
export function isValidProfileName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name);
}
