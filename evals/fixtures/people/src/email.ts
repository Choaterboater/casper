import type { User } from "./user";

export function greeting(user: User): string {
  return `Hi ${user.name.given || user.name.family},`;
}
