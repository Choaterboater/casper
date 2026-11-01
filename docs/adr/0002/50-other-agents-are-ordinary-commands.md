# 50. Starting another coding agent is an ordinary command in your own session

Date: 2026-11-01. Status: accepted (merged 2026-11-01 in #561). Supersedes the agent part of
[decision 15](15-agent-and-tmux-ownership.md) for the person's own session; its tmux part and its rule for helpers stay.

**What:** in your own session, a shell command that starts another coding agent (`casper`, `claude`, `codex`, `omp`,
`pi`, `aider`, `gemini`, `opencode`, `cursor-agent`, directly or through `npx`, `bunx`, `env`, `sudo`, `timeout`, a
`$(…)` or `bash -c`) is no longer refused for want of the right words in your request. It goes the way every command
goes: the sandbox, the routine-command rules, the judge in a trusted folder, and the approval box where a command would
ask today. No new box or question comes with it. The AI's guidance no longer tells it not to launch coding agents.

Kept:

- **Helpers start no agents.** A builder, reviewer or explorer (any bounded sub-agent) is still refused
  (`Not run: A helper doesn't start another coding agent. Hand back to the main session; it can start one.`), whatever
  the request says, and its guidance says so. Helpers run unattended, many at once, inside your task's budget: an
  agent they start would spend outside it and could start helpers of its own. Looking an agent up (`--help`,
  `--version`, `command -v`) is fine for a helper too.
- **Someone else's tmux.** The tmux rule is unchanged: only a private `tmux -L <name>` server started in this task,
  unless you ask.

**Why:** a real session asked to "compare … between omp building a replacement https://gethomepage.dev/ … use haiku 5.5
on each medium effort", and answered the AI's picker with "Yes, run both". The rule wanted "run", "launch", "start" or
"use" within 60 characters before the agent's name, so every `omp -p …` and `casper -p …` was refused, keep going
stopped again, and it worked only after the owner typed "launch omp and Casper for the comparison". Asked what should
happen when the request isn't word-perfect, the owner chose: "Drop the special rule: starting another agent is just a
normal command (box or judge as usual)", and that he "should be able to do that with[out] me having to ask", "as long
as i dont get more and more prompts".

**Guard rails:**

- An agent started from your session asks or is judged exactly as any other command would be: never fewer boxes than
  that command's shape gets today, and never an extra one.
- A helper can't start a coding agent, through any wrapper the guard reads.
- Commands in a tmux server or session this task didn't start are still refused unless you ask.

**A finding:** a helper's command starts a coding agent, an agent command from your session skips the box or judge
that the same command shape would get, or the agent rule adds a question of its own.
