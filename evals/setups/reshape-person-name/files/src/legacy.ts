import type { User } from "./user";

/** A row exported by the old CRM. */
export interface LegacyRow {
  readonly id: string;
  readonly full_name: string;
  readonly email: string;
}

export function fromLegacy(row: LegacyRow): User {
  return { id: row.id, email: row.email, fullName: row.full_name.trim().split(/\s+/).join(" ") };
}
