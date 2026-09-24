import { displayName, type User } from "./user";

export function billTo(user: User): string {
  return `Bill to: ${displayName(user)} <${user.email}>`;
}
