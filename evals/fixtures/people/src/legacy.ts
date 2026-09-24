import type { User } from "./user";

/** A row exported by the old CRM. */
export interface LegacyRow {
  readonly id: string;
  readonly full_name: string;
  readonly email: string;
}

/** The last word is the family name; everything before it is the given name. */
export function fromLegacy(row: LegacyRow): User {
  const words = row.full_name.trim().split(/\s+/).filter(Boolean);
  const family = words.length > 1 ? words.pop()! : "";
  return { id: row.id, email: row.email, name: { given: words.join(" "), family } };
}
