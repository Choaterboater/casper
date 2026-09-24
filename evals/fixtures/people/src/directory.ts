import { displayName, type User } from "./user";

/** Case-insensitive substring match on the display name or the email. */
export function search(users: readonly User[], query: string): User[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...users];
  return users.filter((user) => displayName(user).toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle));
}

const collator = new Intl.Collator("en", { sensitivity: "base" });

/** Family name, then given name, then id. */
export function sortUsers(users: readonly User[]): User[] {
  return [...users].sort((left, right) =>
    collator.compare(left.name.family, right.name.family)
    || collator.compare(left.name.given, right.name.given)
    || left.id.localeCompare(right.id));
}
