/** A step that waits before it looks (`sleep 90; ssh host tail -5 build.log`), said as what it waits for while it runs:
 * "Waiting 90 s, then checking the build log". What comes after the wait is the step's own words: its title, else the
 * AI's line before it. */

import { redactPreview } from "../tui/format";
import { ingForm } from "../tui/step-view";

const UNIT: Readonly<Record<string, number>> = { "": 1, s: 1, m: 60, h: 3600 };

/** The seconds a command waits first (`sleep 90; …`, 10 s or more), else undefined. */
export function waitSeconds(command: unknown): number | undefined {
  if (typeof command !== "string") return undefined;
  const wait = /^\s*sleep\s+(\d+(?:\.\d+)?)([smh]?)\s*(?:$|[;&|\n])/.exec(command);
  const seconds = wait ? Math.round(Number(wait[1]) * UNIT[wait[2]!]!) : 0;
  return seconds >= 10 ? seconds : undefined;
}

/** "Waiting 90 s", "Waiting 5 min", with what comes after: "Waiting 90 s, then checking the build log". */
export function waitWords(seconds: number, purpose?: string): string {
  const time = seconds >= 120 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
  return `Waiting ${time}${purpose ? `, then ${purpose}` : ""}`;
}

/** " in 2 minutes", " after a few minutes": when, already said by the wait itself. */
const WHEN = /\s+(?:again\s+)?(?:in|after|for)\s+(?:about\s+|another\s+)?(?:a few|a couple of|\d+|an?|one|two|three|five|ten)\s*(?:more\s+)?(?:s|secs?|seconds?|mins?|minutes?|hours?)\b.*$/i;
const PURPOSE_CHARS = 60;

function purposeOf(text: string, title: boolean): string | undefined {
  const plain = redactPreview(text).replace(/\s+/g, " ").trim().replace(/[\s.:;!…]+$/, "");
  let clause = /\bthen\s+(.+)$/i.exec(plain)?.[1];
  if (clause === undefined) clause = title ? plain : /\b(?:I'?ll|I will|let me|I'm going to|going to)\s+(.+)$/i.exec(plain)?.[1];
  if (!clause) return undefined;
  // "wait 2 minutes and check again": what comes after the wait.
  if (/^(?:wait|sleep|pause|hold)\b/i.test(clause)) clause = /(?:\band|,)\s+(?:then\s+)?(.+)$/i.exec(clause)?.[1];
  if (!clause) return undefined;
  const again = clause.replace(WHEN, (when) => /^\s+again\b/i.test(when) ? " again" : "");
  const said = ingForm(again.replace(/^and\s+/i, ""));
  if (!said) return undefined;
  const chars = Array.from(said);
  if (chars.length <= PURPOSE_CHARS) return said;
  const cut = chars.slice(0, PURPOSE_CHARS - 1).join("");
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), PURPOSE_CHARS / 2))}…`;
}

/** What comes after the wait, from the step's title or else the AI's line before it; undefined when neither says. */
export function waitPurpose(title?: string, intent?: string): string | undefined {
  return (title ? purposeOf(title, true) : undefined) ?? (intent ? purposeOf(intent, false) : undefined);
}
