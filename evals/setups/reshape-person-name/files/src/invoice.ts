import type { User } from "./user";

export function billTo(user: User): string {
  return `Bill to: ${user.fullName} <${user.email}>`;
}
