import type { User } from "./user";

export function greeting(user: User): string {
  return `Hi ${user.fullName.trim().split(/\s+/)[0]},`;
}
