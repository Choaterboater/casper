import type { AllowedEntry, SandboxStore } from "../sandbox/store";
import { shownCommand } from "./sandbox";

/** /allowed: the shell commands you said yes to for this project (saved, and for this session), and taking them back. */

const USAGE = "Use /allowed or /allowed forget <number, command or all>.";
const words = (text: string) => text.trim().split(/\s+/).join(" ");
const keyOf = (entry: AllowedEntry) => `${entry.kind}\u0000${entry.value}\u0000${entry.session}`;

/** The list as it was last shown for each store: a number only means something against that list. */
const shown = new WeakMap<SandboxStore, string[]>();

function describe(entry: AllowedEntry): string {
  return `${shownCommand(entry.value)} (${entry.kind === "prefix" ? "and anything after it" : "this exact command"})${entry.session ? " (this session)" : ""}`;
}

function listText(entries: readonly AllowedEntry[]): string {
  if (!entries.length) return "Nothing is allowed yet. When Casper asks before a shell command, 3 allows it for this session and 4 for this project; they show up here.\n";
  return [
    "Shell commands you said yes to, for this project:",
    ...entries.map((entry, index) => `  ${index + 1}. ${describe(entry)}`),
    "Forget one with /allowed forget 3 or /allowed forget git log; forget them all with /allowed forget all.",
  ].join("\n") + "\n";
}

async function remove(store: SandboxStore, entry: AllowedEntry): Promise<void> {
  await (entry.kind === "prefix" ? store.removePrefix(entry.value) : store.removeCommand(entry.value));
}

export async function allowedCommand(prompt: string, store: SandboxStore, write: (text: string) => void): Promise<void> {
  const rest = prompt.replace(/^\/allowed/, "").trim();
  const show = async (before = "") => {
    const entries = await store.allowed();
    shown.set(store, entries.map(keyOf));
    write(`${before}${listText(entries)}`);
  };
  if (!rest) return show();
  const forget = /^forget(?:\s+(.+))?$/.exec(rest);
  if (!forget?.[1]) throw new Error(USAGE);
  const what = words(forget[1]);
  if (what === "all") {
    const count = await store.forgetAll();
    shown.delete(store);
    write(count ? `Forgot all ${count}: Casper asks before running any of them again.\n` : "Nothing is allowed, so nothing was forgotten.\n");
    return;
  }
  const entries = await store.allowed();
  if (/^\d+$/.test(what)) {
    const listed = shown.get(store);
    if (!listed) return show("Nothing was forgotten: look at the list first, then pick a number from it.\n");
    if (listed.length !== entries.length || listed.some((key, index) => key !== keyOf(entries[index]!))) {
      return show("The list changed since it was shown. Nothing was forgotten; here it is now:\n");
    }
    const number = Number(what);
    const entry = entries[number - 1];
    if (!entry) { write(`There is no ${what} in the list (${entries.length ? `1 to ${entries.length}` : "it is empty"}). /allowed shows it.\n`); return; }
    await remove(store, entry);
    shown.delete(store);
    write(`Forgot ${number}: ${describe(entry)}. Casper asks before running it again.\n`);
    return;
  }
  // By the words: what you typed, or what the list showed (a secret in it hidden).
  const matches = entries.filter((entry) => words(entry.value) === what || words(shownCommand(entry.value)) === what);
  if (!matches.length) { write(`${shownCommand(what)} is not in your allowed list. /allowed shows it.\n`); return; }
  for (const entry of matches) await remove(store, entry);
  shown.delete(store);
  write(`Forgot ${shownCommand(what)}: Casper asks before running it again.\n`);
}
