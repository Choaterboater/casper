# 71. The AI changes and removes MCP servers through Casper's box

Date: 2026-11-03. Status: proposed. Extends 29 (the AI adds an MCP server after a yes nothing else gives).

## Decision

In a real session the AI couldn't move a server to a new version: `casper_mcp_add` refused the taken name and
`~/.casper/mcp.json` is private, so it added a duplicate. Told "u have permision to move it", it still couldn't remove
either, and `/mcp remove rea` only forgot a consent. The owner: "even claude will let me remove it with extra
permission."

- **The person:** `/mcp update <name> <command…|url>` changes what a server runs in the file that defines it, keeping
  its settings; `/mcp remove <name>` takes it out and stops it. `/mcp forget` stays the consent-only command.
- **The AI:** `casper_mcp_remove` and `casper_mcp_add` with `replace: true`. The person's typed permission is what the
  AI needs to call them; Casper's box is the gate. It shows the name, the file, what it ran and runs now, and the
  settings by name only, then asks `1 No · 2 Yes, this once · 3 Yes, for this session`.
- `Yes, for this session` covers the AI's later removes and changes until the session ends.

## Guard rails

- Only the person's key answers the box: not "Yes to everything", `/permissions all` or the AI's ask tool. A run that
  can't ask changes nothing and says the `/mcp update` or `/mcp remove` line.
- The session answer never adds a server: `casper_mcp_add` without `replace` keeps decision 29's box every time.
- The AI changes only Casper's own `~/.casper/mcp.json` and the profile's file. A project's file or another tool's
  (Claude Code, VS Code) is never changed by the AI; it is told where the server is and what to tell the person.
- Settings values (env, headers) are never shown or returned, and stay as they are; what a server runs is shown with
  anything that looks like a secret hidden. Reads of `~/.casper/mcp.json` stay refused.
- A removed server's consent and key are forgotten, so a later server of that name asks again.
