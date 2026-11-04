# 73. A write in an app bundle asks; the AI sets a server's variables and time limit through Casper's box

Date: 2026-11-04. Status: proposed. Extends 71 (the AI changes and removes MCP servers through Casper's box).

## Decision

In a real v0.4.12 session Casper was started in `/Applications/Iris.app`. Hopper analysis through rea-agents needed
about 120 s, but Casper's call limit is 90 s, and nothing could change it: the AI told the person four times to raise a
setting in `~/.casper/mcp.json` it couldn't name or reach. `casper_mcp_add` with `replace` refused a variable
(`HOPPER_LAUNCHER_PATH`), so the AI wrote a wrapper script that exported it, first inside the app (the project, so no
box), which broke the app's code signature.

- **Time limit.** `/mcp update <name> --timeout 5m` writes the server's `callTimeout` (the setting that already
  existed, 1 s to 30 m) and applies it to the next call. A call that runs out of time says how to give it longer.
  `/mcp detail` shows it. MCP has no annotation that says a tool is long-running, so the default stays 90 s for all.
- **Variables and limit for the AI.** `casper_mcp_add` with `replace: true` takes `env` and `timeout`, with or without
  a command. The box shows each as old → new. A secret-looking name takes no value from the AI: the person types it
  hidden after the box, into Casper's private key file.
- **The same command restarts.** A replace with an unchanged command starts the server again, so a server whose code
  changed lists its tools again.
- **App bundles.** The AI's `edit` and `write` inside an app bundle ask, also when the bundle is the project, with a
  line that it breaks the code signature. `/permissions all` doesn't answer that box.

## Guard rails

- The box is the gate, as in decision 71: only the person's key answers it, and its session answer covers only these
  edits.
- Secret values never reach the AI, the screen or `mcp.json`.
- A bundle is a folder built like one (`Contents/` inside it; `Versions/` or `Resources/` for a framework), so a web
  project's folder named `site.app` is not one. Shell commands keep the shell's own question.
