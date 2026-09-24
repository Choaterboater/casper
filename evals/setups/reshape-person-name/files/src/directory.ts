import type { User } from "./user";

/** Case-insensitive substring match on the name or the email. */
export function search(users: readonly User[], query: string): User[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...users];
  return users.filter((user) => user.fullName.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle));
}

const collator = new Intl.Collator("en", { sensitivity: "base" });

/** Last word of the name (the family name), then the whole name, then id. */
export function sortUsers(users: readonly User[]): User[] {
  const family = (user: User) => user.fullName.trim().split(/\s+/).at(-1) ?? "";
  return [...users].sort((left, right) =>
    collator.compare(family(left), family(right))
    || collator.compare(left.fullName, right.fullName)
    || left.id.localeCompare(right.id));
}
