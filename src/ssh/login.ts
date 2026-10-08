import { forgetTypedSecrets, rememberTypedSecret } from "../secrets/typed";
import { terminalText } from "../tui/format";
import type { AskpassHandler } from "./askpass";

/**
 * What Casper does when ssh (one you allowed) asks for something. Only a password or a key passphrase is ever answered,
 * and only by you, in Casper's own hidden box; anything else ssh asks (trust a new host key, a one-time code) gets no
 * answer. What you type goes to ssh and is hidden from the AI from then on; it is never saved.
 */

/** What the person decided in the box. */
export type SshAnswer = "no" | { secret: string; keep: "once" | "session" };

export interface SshLoginHost {
  /** Casper's full terminal is here, so a box that hides what you type can be shown. */
  canTypePrivately(): boolean;
  /** The numbered question (1 No, 2 Yes once, and 3 Yes for this session when `canKeep`), then the hidden box. undefined: nobody answered. */
  ask(ask: { question: string; label: string; canKeep: boolean }, signal: AbortSignal): Promise<SshAnswer | undefined>;
  write(text: string): void;
}

/** A machine the command was allowed to reach (the Reach question named it). */
export interface ApprovedMachine { typed: string; host: string; user?: string }

export type PromptKind = "password" | "passphrase";
export interface SshPrompt { kind: PromptKind; user?: string; host?: string }

/**
 * What ssh is asking, by its exact shapes: `user@host's password:`, `(user@host) Password:` and `Password:` for a password;
 * `Enter passphrase for key '/path':` for a key. Anything else (a host-key question, a code, a PIN, a sentence that
 * merely says "password") is not answered.
 */
export function parsePrompt(prompt: string): SshPrompt | undefined {
  const text = prompt.replace(/\s+$/, "");
  if (/[\r\n]/.test(text)) return undefined;
  const direct = /^([^\s@]+)@(\S+)'s password:$/.exec(text);
  if (direct) return { kind: "password", user: direct[1]!, host: direct[2]! };
  const interactive = /^\(([^\s@)]+)@([^\s)]+)\) Password:$/i.exec(text);
  if (interactive) return { kind: "password", user: interactive[1]!, host: interactive[2]! };
  if (/^Password:$/i.test(text)) return { kind: "password" };
  if (/^Enter passphrase for (?:key )?'[^']+':$/.test(text) || /^Enter passphrase for [^\s'][^:]*:$/.test(text)) return { kind: "passphrase" };
  return undefined;
}

/** The kind of login a prompt asks for, or undefined. */
export function promptKind(prompt: string): PromptKind | undefined {
  return parsePrompt(prompt)?.kind;
}

const bare = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase();

/** The prompt names a user and machine this command was allowed to reach (the user, when the command named one). */
export function namesApproved(prompt: SshPrompt, approved: readonly ApprovedMachine[]): boolean {
  if (!prompt.host) return false;
  const host = bare(prompt.host);
  return approved.some((machine) => (machine.typed.toLowerCase() === host || machine.host.toLowerCase() === host)
    && (!machine.user || machine.user === prompt.user));
}

/** Passwords you chose "Yes, for this session" for, by machine and user. Memory only. */
export class SshSessionMemory {
  private readonly values = new Map<string, string>();
  get(prompt: SshPrompt): string | undefined { return this.values.get(key(prompt)); }
  set(prompt: SshPrompt, secret: string): void { this.values.set(key(prompt), secret); }
  delete(prompt: SshPrompt): void { this.values.delete(key(prompt)); }
  clear(): void { this.values.clear(); }
}

const key = (prompt: SshPrompt) => `${prompt.user ?? ""}@${bare(prompt.host ?? "")}`;

/** The session's: it ends with Casper, a cleared conversation or a workspace change. */
export const sshSessionMemory = new SshSessionMemory();

/** Forget every typed secret (Casper is closing, the conversation was cleared, the workspace changed). */
export function forgetSshSecrets(): void {
  sshSessionMemory.clear();
  forgetTypedSecrets();
}

const MOST_PER_RUN = 4;

export const notSshQuestion = "Casper answers only password and passphrase questions from ssh, not this one. Nothing was typed. A new host key has to be accepted by the user in their own terminal.";

export const sshCantAsk = (machine: string) => `ssh to ${machine} asked for a password, and this run can't ask you (it needs Casper's full terminal, where what you type stays hidden). Nothing was typed. Use a key or ssh-agent for ${machine}, or run it yourself in a Casper session.`;
export const sshDeclined = (machine: string) => `The user chose not to type a password for ${machine}. Don't ask for it in chat and don't try to get it another way; ask the user what to do instead.`;
export const sshUnanswered = (machine: string) => `Nobody answered the password question for ${machine}, so nothing was typed. Don't ask for it in chat.`;
export const sshWrongMachine = (machine: string) => `ssh asked for a password for a machine other than ${machine}, the one the user allowed. Nothing was typed.`;

/** The words of the numbered question. The AI never sees it. */
export function sshQuestion(machine: string, kind: PromptKind): string {
  return `ssh to ${terminalText(machine)} asks for ${kind === "passphrase" ? "a key's passphrase" : "a password"}. Type it in Casper's hidden box? The AI never sees it.`;
}

/**
 * The handler for one ssh command's prompts. `approved` is the machines the Reach question named. A password you gave for
 * the session is used only for a `user@host's password:` prompt naming one of them, and only once per command: if ssh asks
 * again in the same command it was wrong, so it is forgotten and you are asked. A passphrase is always asked.
 */
export function sshLoginHandler(host: SshLoginHost, memory: SshSessionMemory, machine: string, approved: readonly ApprovedMachine[]): AskpassHandler {
  const triedFromMemory = new Set<string>();
  let asked = 0;
  return async (text, signal) => {
    const prompt = parsePrompt(text);
    if (!prompt) return { refuse: notSshQuestion };
    // A prompt that names a machine must name one this command was allowed to reach.
    if (prompt.host && !namesApproved(prompt, approved)) return { refuse: sshWrongMachine(machine) };
    const keepable = prompt.kind === "password" && prompt.host !== undefined;
    if (keepable) {
      const remembered = memory.get(prompt);
      if (remembered !== undefined) {
        if (!triedFromMemory.has(key(prompt))) { triedFromMemory.add(key(prompt)); return { secret: remembered }; }
        memory.delete(prompt);
      }
    }
    if (!host.canTypePrivately()) return { refuse: sshCantAsk(machine) };
    if (++asked > MOST_PER_RUN) return { refuse: sshDeclined(machine) };
    const label = terminalText(text.trim()).slice(0, 200);
    const answer = await host.ask({ question: sshQuestion(machine, prompt.kind), label, canKeep: keepable }, signal).catch(() => undefined);
    if (answer === undefined) return { refuse: sshUnanswered(machine) };
    if (answer === "no") return { refuse: sshDeclined(machine) };
    // Hidden from the AI from this moment, before ssh has even received it.
    const session = keepable && answer.keep === "session";
    rememberTypedSecret(answer.secret, !session);
    if (session) { memory.set(prompt, answer.secret); triedFromMemory.add(key(prompt)); }
    return { secret: answer.secret };
  };
}
