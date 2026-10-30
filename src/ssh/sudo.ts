import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { rememberTypedSecret } from "../secrets/typed";
import { commandSegments, commandStart } from "../sandbox/remote";
import { terminalText } from "../tui/format";
import type { AskpassHandler, AskpassReply } from "./askpass";
import type { SshLoginHost } from "./login";

/**
 * sudo on this computer asks for your password in Casper's own hidden box, the way ssh does (src/ssh/login.ts). For one
 * command you allowed that uses sudo, a two-line `sudo` in the askpass's private folder comes first on that command's
 * PATH and runs the real sudo with -A; SUDO_ASKPASS is Casper itself, over the same private socket ssh's box uses. So the
 * box shows only when sudo really asks: a sudo that is still signed in, or a NOPASSWD rule, never calls the program and
 * nothing is shown. What you type goes to sudo alone and is hidden from the AI from then on; it is never saved.
 */

/** The askpass host is ssh's: the numbered question (No · Yes, this once · Yes, for this session), then the hidden box. */
export type SudoLoginHost = SshLoginHost;

/** The password you chose "Yes, for this session" for. Memory only. */
export class SudoSessionMemory {
  private value?: string;
  get(): string | undefined { return this.value; }
  set(secret: string): void { this.value = secret; }
  clear(): void { this.value = undefined; }
}
export const sudoSessionMemory = new SudoSessionMemory();

/** Whether a command runs sudo on this machine: sudo leads one of its commands (also after env, VAR=, nohup …). */
export function usesLocalSudo(command: string): boolean {
  return commandSegments(command).some((segment) => segment.words.slice(0, Math.max(1, commandStart(segment.words))).some((word) => path.basename(word) === "sudo"));
}

/** The program sudo finds first on this command's PATH: the real sudo, after it, with -A (ask through SUDO_ASKPASS), unless
 * the command chose another way (-S reads standard input, -n never asks). */
export async function sudoShim(dir: string): Promise<string> {
  const bin = path.join(dir, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const shim = path.join(bin, "sudo");
  await writeFile(shim, [
    "#!/bin/sh",
    // This folder leaves PATH wherever the command put it, so `sudo` below is the next one, never this file again.
    `b='${bin.replaceAll("'", "'\\''")}'`,
    'set -f; p=; IFS=:; for d in $PATH; do [ "$d" = "$b" ] || p=${p:+$p:}$d; done; unset IFS; set +f; PATH=$p; export PATH',
    // -S, -n or -A anywhere in sudo's own options (bundled too, after an option's value): the command chose; left alone.
    "skip=",
    'for a in "$@"; do',
    '  if [ -n "$skip" ]; then skip=; continue; fi',
    '  case "$a" in',
    '    --) break;;',
    '    --stdin|--non-interactive|--askpass) exec sudo "$@";;',
    '    --user|--group|--prompt|--close-from|--chdir|--host|--role|--type|--command-timeout|--other-user|--chroot) skip=1;;',
    '    --*) ;;',
    '    -?*) f=${a#-}; while [ -n "$f" ]; do c=${f%"${f#?}"}; f=${f#?}; case "$c" in S|n|A) exec sudo "$@";; u|g|p|C|h|D|r|R|t|T|U) [ -z "$f" ] && skip=1; break;; esac; done;;',
    '    *) break;;',
    '  esac',
    "done",
    'exec sudo -A "$@"',
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(shim, 0o700);
  return bin;
}

const MOST_PER_RUN = 3;

export const SUDO_QUESTION = "sudo on this computer asks for your password. Type it in Casper's hidden box? The AI never sees it.";
export const SUDO_CANT_ASK = "sudo asked for a password, and this run can't ask the person (it needs Casper's full terminal, where what they type stays hidden). Nothing was typed. Tell the user it runs in an interactive Casper session, which asks for the password in its own box.";
export const SUDO_DECLINED = "The user chose not to type the sudo password. Don't ask for it in chat and don't try to get it another way; ask the user what to do instead.";
export const SUDO_UNANSWERED = "Nobody answered the sudo password question, so nothing was typed. Don't ask for it in chat.";

/**
 * The handler for one sudo command's password prompts. A password kept for the session is given once per command: if
 * sudo asks again in the same command it was wrong, so it is forgotten and you are asked.
 */
export function sudoLoginHandler(host: SudoLoginHost, memory: SudoSessionMemory): AskpassHandler {
  let triedFromMemory = false;
  let asked = 0;
  let declined: AskpassReply | undefined;
  return async (text, signal) => {
    const remembered = memory.get();
    if (remembered !== undefined) {
      if (!triedFromMemory) { triedFromMemory = true; return { secret: remembered }; }
      memory.clear();
    }
    if (declined) return declined;
    if (!host.canTypePrivately()) return declined = { refuse: SUDO_CANT_ASK };
    if (++asked > MOST_PER_RUN) return { refuse: SUDO_DECLINED };
    const label = terminalText(text.trim()).replace(/\s+/g, " ").slice(0, 200) || "Password:";
    const answer = await host.ask({ question: SUDO_QUESTION, label, canKeep: true }, signal).catch(() => undefined);
    if (answer === undefined) return declined = { refuse: SUDO_UNANSWERED };
    if (answer === "no") return declined = { refuse: SUDO_DECLINED };
    const session = answer.keep === "session";
    // Hidden from the AI from this moment, before sudo has even received it.
    rememberTypedSecret(answer.secret, !session);
    if (session) { memory.set(answer.secret); triedFromMemory = true; }
    return { secret: answer.secret };
  };
}
