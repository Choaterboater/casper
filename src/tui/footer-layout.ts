import { terminalText, tint } from "./format";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** The context group's bar: filled ━ then empty ─ cells, and the share after it. */
const BAR = /ctx ([━─]+) /;
const SHARE = /· (\d+)%~/;
/** From this share the filled cells take the warning colour. */
const BAR_WARNING = 80;

/** The right side, muted, with the bar's filled cells in the accent colour (warning from 80%). */
function tintDetails(right: string, color: boolean): string {
  const bar = BAR.exec(right);
  const filled = bar?.[1]!.match(/^━*/)?.[0] ?? "";
  if (!bar || !filled) return tint(right, "muted", color);
  const start = bar.index + "ctx ".length;
  const role = Number(SHARE.exec(right.slice(start))?.[1] ?? 0) >= BAR_WARNING ? "warning" : "accent";
  return `${tint(right.slice(0, start), "muted", color)}${tint(filled, role, color)}${tint(right.slice(start + filled.length), "muted", color)}`;
}

/** Keep the state at the left and identity at the right. Drop the context bar, then cost, context and model as space
 * runs out. */
export function readableFooter(state: string, details: string, width: number, color: boolean, badge?: string): string {
  const groups = terminalText(details).replace(/[\r\n\t]/g, " ").split(" │ ").filter(Boolean);
  let badgeText = terminalText(badge ?? "").replace(/[\r\n\t]/g, " ").replaceAll("ASKING OFF", "asking off");
  if (visibleWidth(state) + badgeText.length + 13 > width) badgeText = ["asking off", "ALLOW ALL", "WRITES", "Ctrl+X"].filter(word => badgeText.includes(word)).join(" · ");
  const marker = badgeText ? tint(badgeText, "warning", color) : "";
  let left = state + (marker ? ` · ${marker}` : "");
  const fits = () => visibleWidth(left) + 2 + visibleWidth(groups.join(" │ ")) <= width;
  if (!fits()) { const at = groups.findIndex((group) => BAR.test(group)); if (at >= 0) groups[at] = groups[at]!.replace(BAR, "ctx "); }
  while (groups.length > 1 && !fits()) groups.pop();
  let right = groups.join(" │ ");
  if (visibleWidth(left) + 2 + visibleWidth(right) > width) {
    const room = width - visibleWidth(left) - 2;
    right = room > 0 ? truncateToWidth(right, room) : "";
  }
  if (visibleWidth(left) > width) left = truncateToWidth(left, width);
  return right ? `${left}${" ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right)))}${tintDetails(right, color)}` : left;
}
