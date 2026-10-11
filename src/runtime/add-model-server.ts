import { addModelServer, KIND_NAMES, removeModelServer, serverNameProblem, type ModelServer } from "../config/model-servers";
import { NOTHING_ANSWERED_CHOICES } from "../app/safe-choices";
import type { LoginDisplay } from "../tui/login";
import { SERVER_SIDE_TIP, wantsServerTip, type LocalModel } from "./local-models";
import { alreadyAt, autoName, detectServer, readableOnTheWire, readAddress, serverLabel, type Detected } from "./model-servers";

/** The add-a-model-server screens, the same from `/model` (`+ Add server`) and `/login`: the address, what answered
 * there, a name for each server found, then saved. No key is asked for or kept: a server that asks for one is skipped,
 * with where to set it up instead. Nothing is written before the last step, and Esc at any step writes nothing more. */

export interface AddServerDeps {
  home: string;
  /** Names already in use: the catalog's providers, saved sign-ins, your servers. */
  taken: () => Iterable<string>;
  /** Servers you or Casper already have, by address (no /v1). */
  known: () => ReadonlyArray<{ name: string; root: string }>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface AddedServer { server: ModelServer; models: LocalModel[] }
export interface AddResult {
  added: AddedServer[];
  /** Plain lines to print after the screens close (what was added, what was skipped and why). */
  lines: string[];
}

const cancelled = (error: unknown) => error instanceof Error && /cancelled/i.test(error.message);
const plural = (count: number) => `${count} model${count === 1 ? "" : "s"}`;

/** A server that asks for a key is not added here: where to set it up instead. */
export function keyLine(root: string): string {
  return `The server at ${new URL(root).host} asks for a key. Casper adds servers that need none; set this one up in ~/.casper/agent/models.json (Local models in docs/CONFIGURATION.md).`;
}

export async function addModelServers(display: LoginDisplay, deps: AddServerDeps): Promise<AddResult> {
  const lines: string[] = [];
  const added: AddedServer[] = [];
  const note = "The address is kept in ~/.casper/config.yaml, which the AI can read. No key is asked for or sent.";
  const look = (root: string) => detectServer(root, { signal: display.signal,
    ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) });
  display.setNote(note);
  try {
    let typed = "";
    let found: Detected[] = [];
    for (;;) {
      typed = await display.textInput("Where is the server? Type its address.", display.signal, {
        title: "Add a model server",
        hint: "Like 192.0.2.10, myserver:11434 or http://myserver:8000.\nNo port? Casper tries the usual ones: 11434 Ollama, 1234 LM Studio, 8080 llama.cpp, 8000 vLLM.",
        initial: typed, editable: true,
        check: (text) => { const read = readAddress(text); return "problem" in read ? read.problem : undefined; },
      });
      const read = readAddress(typed);
      if ("problem" in read) continue;
      const ports = read.roots.map((root) => new URL(root).port || (root.startsWith("https:") ? "443" : "80"));
      display.wait("Add a model server", `Checking ${read.host} on port${ports.length > 1 ? "s" : ""} ${ports.join(", ")}… (up to ${Math.round((deps.timeoutMs ?? 10_000) / 1000)} seconds)`);
      found = await Promise.all(read.roots.map((root) => look(root)));
      if (found.some((entry) => entry.state !== "none")) break;
      // No model server: each port's reason (one line when they all say the same), and what to set on that computer
      // when it didn't answer at all.
      const reasons = found.flatMap((entry) => entry.state === "none" ? [entry] : []);
      const same = reasons.every((reason) => reason.words === reasons[0]!.words);
      const why = same ? [`Casper found no model server there: it ${reasons[0]!.words}.`]
        : reasons.map((reason) => `Port ${new URL(reason.root).port || (reason.root.startsWith("https:") ? "443" : "80")}: it ${reason.words}.`);
      const tip = reasons.some((reason) => reason.cause !== "login" && wantsServerTip({ root: reason.root, cause: reason.cause }));
      display.setNote([...why, ...tip ? [SERVER_SIDE_TIP] : []].join("\n"));
      const next = await display.choose(`No model server at ${read.host}`, NOTHING_ANSWERED_CHOICES.map((label, index) => ({ id: String(index), label })));
      display.setNote(note);
      if (next !== "1") return { added, lines: ["No model server was added."] };
    }
    const taken = new Set([...deps.taken()].map((name) => name.toLowerCase()));
    // Servers that need no key first, then one line for each that asks for a key: Casper adds servers that need none.
    const order = [...found.filter((entry) => entry.state === "found"), ...found.filter((entry) => entry.state === "key")];
    for (const entry of order) {
      display.setNote(note);
      if (entry.state === "key") { lines.push(keyLine(entry.root)); continue; }
      if (entry.state !== "found") continue;
      const label = serverLabel(entry.kind, entry.root);
      const existing = alreadyAt(entry.root, deps.known());
      if (existing) { lines.push(`You already have ${label} as ${existing}.`); continue; }
      const wire = readableOnTheWire(entry.root);
      const name = await display.textInput(`Name it. The name goes before its models, like ${autoName(entry.kind, entry.root, taken)}/${entry.models[0]?.id ?? "qwen3:8b"}.`, display.signal, {
        title: `Found ${label} · ${plural(entry.models.length)}`,
        hint: wire === "yes" ? "This link isn't encrypted: others on the same network could read what you send."
          : wire === "maybe" ? "This link isn't encrypted, unless this is your Tailscale address." : undefined,
        initial: autoName(entry.kind, entry.root, taken),
        check: (text) => serverNameProblem(text, taken),
      });
      const server: ModelServer = { name, address: entry.root, kind: entry.kind };
      try { await addModelServer(deps.home, server); }
      catch (error) {
        lines.push(`${name} wasn't added: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      taken.add(name);
      added.push({ server, models: entry.models });
      lines.push(entry.models.length
        ? `Added ${name}: ${plural(entry.models.length)} (${serverLabel(entry.kind, entry.root)}).`
        : `Added ${name}, but it has no models yet. On that computer ${entry.kind === "ollama" ? "run ollama pull qwen3" : entry.kind === "lm-studio" ? "download a model in LM Studio" : `load a model in ${KIND_NAMES[entry.kind]}`}.`);
    }
  } catch (error) {
    // Whatever stops the screens, what was already added is kept and said.
    if (cancelled(error) || display.signal.aborted) lines.push(added.length ? "Stopped; nothing more was added." : "No model server was added.");
    else lines.push(`${added.length ? "Stopped" : "No model server was added"}: ${error instanceof Error ? error.message : String(error)}`);
  } finally { display.setNote(""); }
  return { added, lines };
}

/** Forget one of your servers: its config entry. */
export async function forgetModelServer(name: string, deps: Pick<AddServerDeps, "home">): Promise<void> {
  await removeModelServer(deps.home, name);
}
