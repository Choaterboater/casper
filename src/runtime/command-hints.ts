/** Short hints added to a bash command's own result (never the fixed prompt) when it works around something the bash
 * tool already does: its own time limit (`timeout`), or a job in the background whose latest line the person sees. */

import { splitShell } from "../sandbox/remote";
import { detachesItself } from "./background-commands";

/** Added to a command wrapped in its own time limit. */
export const TIME_LIMIT_NOTE = "[The bash tool's timeout (seconds) limits one command: pass it instead of wrapping the command in perl alarm or timeout.]";

/** `perl -e 'alarm N; exec …'`, `timeout N …` or `gtimeout N …` around a command. */
export function wrapsTimeLimit(command: string): boolean {
  for (const { words } of splitShell(command).segments) {
    const at = words.findIndex(word => !/^(?:then|do|else|sudo|command|exec)$/.test(word));
    const program = words[at] ?? "";
    if (program === "perl" && words.some((word, index) => index > at && /\balarm\s*\(?\s*\d/.test(word))) return true;
    if (!/^g?timeout$/.test(program)) continue;
    // Options, then the limit ("30", "5s", "1.5m"), then the command it limits.
    let next = at + 1;
    while (words[next]?.startsWith("-")) next += /^-[sk]$/.test(words[next]!) ? 2 : 1;
    if (/^\d+(?:\.\d+)?[smhd]?$/.test(words[next] ?? "") && words[next + 1]) return true;
  }
  return false;
}

/** Another machine and a log a job there writes to (or that the command waits on and reads). */
export interface RemoteLog { host: string; log: string }

/** ssh options that take a value. */
const SSH_VALUE = /^-[BbcDEeFIiJLlmOopQRSWw]$/;
const READS = /^(?:tail|cat|head|less)$/;

/** The file a command's output goes to (`> f`, `>> f`, `&> f`, `| tee f`), never /dev/null. */
function logTarget(text: string): string | undefined {
  for (const match of text.matchAll(/(?:&>>?|\d*>>?|\btee\s+(?:-a\s+)?)\s*([^\s;&|'"()<>]+)/g)) {
    if (match[1] !== "/dev/null") return match[1];
  }
  return undefined;
}

/** A job started over ssh that writes its progress to a log there (detached, or a docker build), or a wait of 10 s or more
 * that then reads a log there (`sleep 90; ssh host tail -5 log`): the log to follow instead. */
export function remoteLog(command: string): RemoteLog | undefined {
  const waits = [...command.matchAll(/\bsleep\s+(\d+)/g)].some(match => Number(match[1]) >= 10);
  for (const { words } of splitShell(command).segments) {
    const ssh = words.indexOf("ssh");
    if (ssh < 0) continue;
    let at = ssh + 1;
    while (words[at]?.startsWith("-")) at += SSH_VALUE.test(words[at]!) ? 2 : 1;
    const host = words[at];
    const remote = words.slice(at + 1).join(" ");
    if (!host || !remote) continue;
    const log = logTarget(remote);
    if (log && (detachesItself(remote) || /\bdocker(?:-compose|\s+compose)\b[^;&|]*\b(?:build|up)\b|\bdocker\s+build\b/.test(remote))) return { host, log };
    if (!waits) continue;
    for (const inner of splitShell(remote).segments) {
      if (!READS.test(inner.words[0] ?? "")) continue;
      const file = inner.words.slice(1).filter(word => !word.startsWith("-") && !/^\d+$/.test(word)).at(-1);
      if (file) return { host, log: file };
    }
  }
  return undefined;
}

/** One line: follow the log as a job in the background, so its latest line shows on the person's status row. */
export function followLogHint({ host, log }: RemoteLog): string {
  return `[To show how it goes, follow ${log} as a background job: \`ssh ${host} tail -f ${log}\` with background: true. Its latest line shows on the person's status row. Don't loop sleep then cat or tail.]`;
}
