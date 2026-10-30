/**
 * A secret in what the person pasted into a request: a token in a copied terminal screen (docker run … --token eyJ…), a
 * key in a pasted config. Casper finds it before the request goes to the AI, with the same rules that hide secrets in
 * tool output, plus one for a long random-looking run that no rule names (a token the paste broke across lines). Only
 * pasted text is read: what the person typed is theirs to send.
 */

import { terminalText } from "../tui/format";
import { scrubPlainSecrets } from "./files";
import { SECRET_MARKER } from "./scrub";

export interface PastedSecrets {
  /** The line with each secret replaced by <secret hidden>. */
  text: string;
  /** The pasted pieces, the same way. */
  pasted: string[];
  /** How many were found. */
  hidden: number;
  /** The pasted pieces that held one, as pasted. */
  from: string[];
  /** Up to three of the changed lines, as they would go with the secrets removed. */
  preview: string[];
}

const RUN = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g;

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) { const share = count / text.length; bits -= share * Math.log2(share); }
  return bits;
}

/** A run that reads as random: upper case, lower case and several digits mixed in one long part with no path, hash,
 * public key or name shape (a commit or digest is hex, an ssh public key starts AAAA, an npm integrity is sha512-…, a
 * long camelCase name has a digit or two at most). */
export function looksRandom(run: string): boolean {
  if (/^[0-9a-f]+$/i.test(run) || run.startsWith("AAAA") || /^sha\d+-/i.test(run)) return false;
  return run.replace(/=+$/, "").split("/").some((part) => part.length >= 32 && /[A-Z]/.test(part) && /[a-z]/.test(part)
    && (part.match(/\d/g)?.length ?? 0) >= Math.max(3, part.length * 0.06) && entropy(part) >= 4.2);
}

/** One pasted piece with its secrets hidden, and how many. */
export function cleanPaste(piece: string): { text: string; hidden: number } {
  const scrubbed = scrubPlainSecrets(piece);
  let hidden = scrubbed.hidden;
  const text = scrubbed.text.replace(RUN, (run) => looksRandom(run) ? (hidden++, SECRET_MARKER) : run);
  return { text, hidden };
}

/** The secrets in what was pasted into `line`, or undefined when there are none. */
export function pastedSecrets(line: string, pasted: readonly string[]): PastedSecrets | undefined {
  let text = line, hidden = 0;
  const preview: string[] = [], from: string[] = [];
  const cleaned = pasted.map((piece) => {
    const found = cleanPaste(piece);
    if (!found.hidden) return piece;
    hidden += found.hidden;
    from.push(piece);
    text = text.split(piece).join(found.text);
    for (const entry of found.text.split(/\r?\n/)) {
      if (preview.length < 3 && entry.includes(SECRET_MARKER)) preview.push(terminalText(entry.trim()).slice(0, 120));
    }
    return found.text;
  });
  return hidden ? { text, pasted: cleaned, hidden, from, preview } : undefined;
}
