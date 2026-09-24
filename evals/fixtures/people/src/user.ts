export interface PersonName {
  readonly given: string;
  readonly family: string;
}

export interface User {
  readonly id: string;
  readonly name: PersonName;
  readonly email: string;
}

/** "Given Family", skipping an empty part. */
export function displayName(user: User): string {
  return [user.name.given, user.name.family].filter(Boolean).join(" ");
}

/** "Family, Given" for sorted listings; just the non-empty part when one is empty. */
export function sortName(user: User): string {
  return [user.name.family, user.name.given].filter(Boolean).join(", ");
}
