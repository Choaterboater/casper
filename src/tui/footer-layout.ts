import { terminalText, tint } from "./format";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Keep the state at the left and identity at the right. Drop cost, context, then model as space runs out. */
export function readableFooter(state: string, details: string, width: number, color: boolean, badge?: string): string {
  const groups = terminalText(details).replace(/[\r\n\t]/g, " ").split(" │ ").filter(Boolean);
  let badgeText = terminalText(badge ?? "").replace(/[\r\n\t]/g, " ").replaceAll("ASKING OFF", "asking off");
  if (visibleWidth(state) + badgeText.length + 13 > width) badgeText = ["asking off", "ALLOW ALL", "WRITES", "Ctrl+X"].filter(word => badgeText.includes(word)).join(" · ");
  const marker = badgeText ? tint(badgeText, "warning", color) : "";
  let left = state + (marker ? ` · ${marker}` : "");
  while (groups.length > 1 && visibleWidth(left) + 2 + visibleWidth(groups.join(" │ ")) > width) groups.pop();
  let right = groups.join(" │ ");
  if (visibleWidth(left) + 2 + visibleWidth(right) > width) {
    const room = width - visibleWidth(left) - 2;
    right = room > 0 ? truncateToWidth(right, room) : "";
  }
  if (visibleWidth(left) > width) left = truncateToWidth(left, width);
  return right ? `${left}${" ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right)))}${tint(right, "muted", color)}` : left;
}
