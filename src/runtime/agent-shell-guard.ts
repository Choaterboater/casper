import { existsSync } from "node:fs";
import path from "node:path";
import { commandSegments, commandStart, splitShell } from "../sandbox/remote";

const AGENTS = /^(?:casper|claude|codex|pi|omp|cursor-agent|aider|gemini|opencode)(?:\.(?:exe|cmd|bat))?$/i;
/** The person's own session (decision 0002/50): starting another coding agent is an ordinary command, judged and boxed
 * like any other. Only someone else's tmux is left alone. */
export const AGENT_SHELL_GUIDANCE = "Don't touch unrelated tmux unless the person asks; task-created tmux -L only.";
/** A helper (builder, reviewer, explorer) starts no coding agents: the person's session decides that, so helpers never
 * start agents that start agents. */
export const HELPER_SHELL_GUIDANCE = "No starting other coding agents (casper, claude, codex, omp…) and no unrelated tmux; task-created tmux -L only.";
/** An agent's own flags that only print something and exit: its version or its help. */
const LOOKUP_FLAGS = new Set(["--version", "-V", "-v", "version", "--help", "-h", "help"]);
const HELPER_AGENT_NOTE = "Not run: A helper doesn't start another coding agent. Hand back to the main session; it can start one.";
const TMUX_NOTE = "Not run: use a private tmux -L server created in this task, not someone else's server or session. The person can explicitly ask otherwise.";

/** A text guard, not shell isolation. State belongs to one runtime and resets with the person's task request. In a helper
 * (`builder`: any bounded sub-agent) it refuses starting another coding agent, whatever the request says; in the person's
 * own session that is an ordinary command (the sandbox, the judge and the usual box decide). Both keep to their own tmux. */
export class AgentShellGuard {
  private request = "";
  private taskKey: unknown;
  private readonly servers = new Set<string>();
  constructor(private readonly builder = false, private readonly serverExists = (name: string) =>
    existsSync(path.join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? "unknown"}`, name))) {}

  task(request: string, key: unknown = request): void {
    if (key === this.taskKey) return;
    this.taskKey = key;
    this.request = request;
    this.servers.clear();
  }

  private explicit(tool: string): boolean {
    if (this.builder) return false;
    const pattern = new RegExp(`\\b(?:run|launch|start|use|invoke|stop|kill|inspect|attach|capture)\\b[^.\\n]{0,60}\\b${tool}\\b`, "gi");
    return [...this.request.matchAll(pattern)].some(match => !/\b(?:not|never|don't|no need to)\s*$/i.test(this.request.slice(0, match.index)));
  }

  reason(command: string): string | undefined {
    for (const words of this.programs(command)) {
      const tool = path.basename(words[0] ?? "");
      if (this.builder && AGENTS.test(tool) && !words.slice(1).some((word) => LOOKUP_FLAGS.has(word))) return HELPER_AGENT_NOTE;
      if (tool !== "tmux" || this.explicit("tmux")) continue;
      const name = words[1] === "-L" ? words[2] : undefined;
      if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) return TMUX_NOTE;
      let at = 3;
      while (words[at]?.startsWith("-")) {
        if (words[at]?.startsWith("-S") || words[at]?.startsWith("-L")) return TMUX_NOTE;
        at += words[at] === "-f" || words[at] === "-T" ? 2 : 1;
      }
      if (this.servers.has(name)) continue;
      const action = words[at];
      if (!["new-session", "new", "start-server"].includes(action ?? "") || this.serverExists(name)) return TMUX_NOTE;
    }
    return undefined;
  }

  finished(command: string, exit: number | null): void {
    if (exit !== 0 || splitShell(command).segments.length !== 1) return;
    for (const words of this.programs(command)) {
      if (path.basename(words[0] ?? "") !== "tmux" || words[1] !== "-L") continue;
      const name = words[2]!;
      if (words.includes("kill-server")) this.servers.delete(name);
      else if (words.slice(3).some(word => ["new-session", "new", "start-server"].includes(word))) this.servers.add(name);
    }
  }

  private programs(command: string, depth = 0): string[][] {
    if (depth > 8) return [];
    return commandSegments(command).flatMap(segment => {
      // `command -v casper` (or -V) looks the program up and runs nothing.
      if (path.basename(segment.words[0] ?? "") === "command" && ["-v", "-V"].includes(segment.words[1] ?? "")) return [];
      const words = segment.words.slice(commandStart(segment.words));
      const name = path.basename(words[0] ?? "");
      const runner = ["npx", "bunx"].includes(name) || name === "bun" && words[1] === "x" || name === "npm" && words[1] === "exec";
      if (runner) {
        words.splice(0, ["npx", "bunx"].includes(name) ? 1 : 2);
        while (words[0]?.startsWith("-")) {
          const flag = words.shift();
          if (flag === "--") break;
          if (flag === "-c" || flag === "--call") return this.programs(words[0] ?? "", depth + 1);
          if (flag === "-p" || flag === "--package") words.shift();
        }
      }
      return [words];
    });
  }
}
