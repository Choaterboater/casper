# 29. The AI can add an MCP server, after a yes nothing else gives

Date: 2026-10-22. Status: accepted (merged 2026-10-22 in #470). The box's strictness is the safe default
chosen while the owner was away; it can be changed at review.

## Decision

Asked for an MCP server in chat ("install the MCP server at github.com/owner/repo"), the AI works out the command that
starts it, reading the repository's README through `casper_read_untrusted` (untrusted text), and calls
`casper_mcp_add`. Casper shows the exact name, command, words and version in a box:

```text
The AI wants to add an MCP server and start it now:
  name     example
  runs     npx -y github:example/example-mcp#1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b
  version  commit 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b (pinned)
It goes in ~/.casper/mcp.json, so it starts again each session, outside the sandbox, with your permissions.
Add example and start it?
  1 No
  2 Yes, add it and start it
```

Nothing is written or started before 2. A yes writes the server to `~/.casper/mcp.json` the way `/mcp add` does and
starts it.

## Guard rails

- Nothing answers the box for you: not "Yes to everything" or `/permissions all` (they answer the shell's own
  questions only), not a remembered answer (it offers none), not the AI's ask tool. Enter and Esc are No.
- A run that can't ask (one-shot, `--json`) writes nothing and tells you the `/mcp add` line to type.
- Same writer and rules as `/mcp add`: never over a name a server already has in any file Casper reads, the file
  created 0600, a GitHub page refused as an address.
- The box says the version: a pinned version, commit or image digest; a tag or branch, which can be moved; or that the
  runner fetches the newest each time it starts. Only a pinned server can be remembered, as before.
- Package runners only (npm through `npx`, Python through `uvx`, docker images), preferably pinned. A repository that
  needs a clone and a build is out of scope: the AI tells you the steps instead of calling the tool.
- Offered only from the first request that names MCP, so other requests pay nothing for it; once offered it stays for
  the session, like Casper's other tools.

## Why

The owner asked to install servers from other GitHub repositories from chat, as well as with `/mcp add`. A server runs
outside the sandbox, with your permissions, every time Casper starts it, so the box is one only a fresh key answers.
