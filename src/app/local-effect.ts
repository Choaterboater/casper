import { runsAlone, segmentTargets, splitShell } from "../sandbox/remote";

/**
 * Whether a finished tool call could have changed files on this computer. Casper compares the folder before and after
 * a task, and counted every difference as the AI's: on a PC whose AI only ran `ssh nas '...'`, files another program
 * changed meanwhile were checked as its work and offered as "The work is in ...". Reads, searches and one plain ssh
 * (nothing else runs here: no pipe, redirect or local-effect option, as `runsAlone` decides) leave files alone; any
 * other tool, or a shell command of any other shape, may change them.
 */
const READS = new Set(["read", "grep", "find", "ls", "web_search", "web_fetch", "ask", "find_capability", "casper_session"]);

export function leavesFilesHere(toolName: string, input: object | undefined, root: string): boolean {
  if (READS.has(toolName)) return true;
  if (toolName !== "bash" && toolName !== "powershell") return false;
  const raw = (input as { command?: unknown } | undefined)?.command;
  const command = typeof raw === "string" ? raw : undefined;
  if (!command || !runsAlone(command, root)) return false;
  // runsAlone takes scp too; an scp may copy a file here.
  return segmentTargets(splitShell(command).segments[0]?.words ?? []).tool === "ssh";
}
