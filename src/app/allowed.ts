import type { AllowedEntry, SandboxStore } from "../sandbox/store";
import { shownCommand } from "./sandbox";

/** /allowed: the shell commands you said yes to for this project (saved, and for this session), taking them back, and
 * keeping a session yes for the project (/allowed keep <n>, the Next row's "Always allow …"). */

const USAGE = "Usage: /allowed | /allowed forget <number, command or all> | /allowed keep <number>";
const words = (text: string) => text.trim().split(/\s+/).join(" ");
const keyOf = (entry: AllowedEntry) => `${entry.kind}\u0000${entry.value}\u0000${entry.session}`;

/** The list as it was last shown for each store: a number only means something against that list. */
const shown = new WeakMap<SandboxStore, string[]>();

function describe(entry: AllowedEntry): string {
  if (entry.kind === "checks") return entry.value;
  if (entry.kind === "github") return `${entry.value} commands, outside the sandbox with your GitHub login${entry.session ? " (this session)" : ""}`;
  return `${shownCommand(entry.value)} (${entry.kind === "prefix" ? "this exact command, kept by an older Casper" : "this exact command"})${entry.session ? " (this session)" : ""}`;
}

function listText(entries: readonly AllowedEntry[]): string {
  if (!entries.length) return "Nothing is allowed yet. When Casper asks before a shell command, 3 allows it for this session, and the Next row after the task offers to keep it for this project; they show up here. /permissions details shows everything Casper may do here.\n";
  return [
    "Shell commands you said yes to, for this project:",
    ...entries.map((entry, index) => `  ${index + 1}. ${describe(entry)}`),
    "Forget one with /allowed forget 3 or /allowed forget git log; forget them all with /allowed forget all.",
    "/permissions details shows everything Casper may do here, and how to be asked less.",
  ].join("\n") + "\n";
}

async function remove(store: SandboxStore, entry: AllowedEntry): Promise<void> {
  if (entry.kind === "checks") { await store.setChecksOutside(false); return; }
  if (entry.kind === "github") { await store.removeGithub(entry.value); return; }
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
  const keep = /^keep\s+(\d+)$/.exec(rest);
  if (keep) {
    const number = Number(keep[1]);
    const offer = store.keepable[number - 1];
    if (!offer) { write(`There is no ${number} to keep (${store.keepable.length ? `1 to ${store.keepable.length}` : "nothing was allowed for this session yet"}).\n`); return; }
    if (offer.kept) { write(`${offer.what} is already allowed always in this project. /allowed shows it.\n`); return; }
    try { await offer.keep(); }
    catch (error) { write(`Not kept (${error instanceof Error ? error.message : String(error)}); ${offer.what} stays allowed until you quit.\n`); return; }
    offer.kept = true;
    shown.delete(store);
    write(`✓ allowed always in this project: ${offer.what} (kept in ~/.casper, never in the repo; /allowed forget takes it back)\n`);
    return;
  }
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
