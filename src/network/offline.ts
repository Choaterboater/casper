/**
 * A network read that shows a device offline. A real session ended "Blocked: the core switch shows OFFLINE in Central,
 * so I can't read its port configuration" and asked the person to reconnect it, though it knew the switch's name, serial
 * and neighbours and had other ways in. When a routed read result says a device is offline, disconnected or
 * unreachable, the broker adds one line to it (OTHER_WAY_IN) for the AI. Read locally: no model call.
 */
import { isRecord } from "../mcp/config";

/** The line the AI gets under such a result. Its "Next step:" ending goes on the Next row (src/task/next-step.ts). */
export const OTHER_WAY_IN = "A device in this result is offline or unreachable. Before you end blocked, try another way in you have: "
  + "ssh to its management address (a plain `ssh user@address \"show …\"` with no BatchMode: Casper asks for the login in its own box, "
  + "so never ask for a password in chat), the other product's API (Mist or Central), or a read-only CLI tool. "
  + "Offer the best one as your last line, \"Next step: <the step>\", and Casper puts it on the Next row for the person to pick.";

const STATUS_KEY = /^(?:status|state|device_?status|connection_?(?:status|state)|connectivity)$/i;
const OFFLINE_VALUE = /^(?:offline|disconnected|unreachable|not[ _-]?connected)$/i;
const FLAG_KEY = /^(?:is_?)?(?:connected|online|reachable)$/i;
/** Keys whose words are the server's own message, not a name or a description someone wrote. */
const MESSAGE_KEY = /^(?:error|message|detail|reason|status_?message)$/i;
const OFFLINE_WORDS = /\b(?:device|switch|gateway|access point|ap)\b[^.\n]{0,40}?\b(?:offline|disconnected|unreachable|not connected)\b/i;
const MAX_TEXT = 262_144;
const MAX_WALK = 5_000;

/** True when a tool result says a device is offline: a status of OFFLINE or disconnected, connected: false, or the
 * server's words ("device not connected"). A port that is down is not a device that is offline. */
export function showsDeviceOffline(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const values: unknown[] = raw.structuredContent !== undefined ? [raw.structuredContent] : [];
  for (const block of Array.isArray(raw.content) ? raw.content : []) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string" || block.text.length > MAX_TEXT) continue;
    try { values.push(JSON.parse(block.text)); } catch { values.push(block.text); }
  }
  let budget = MAX_WALK;
  const walk = (value: unknown, key?: string): boolean => {
    if (budget-- <= 0) return false;
    if (typeof value === "string") {
      return (key !== undefined && STATUS_KEY.test(key) && OFFLINE_VALUE.test(value.trim()))
        || ((key === undefined || MESSAGE_KEY.test(key)) && OFFLINE_WORDS.test(value));
    }
    if (value === false) return key !== undefined && FLAG_KEY.test(key);
    if (Array.isArray(value)) return value.some((item) => walk(item));
    return isRecord(value) && Object.entries(value).some(([name, item]) => walk(item, name));
  };
  return values.some((value) => walk(value));
}
