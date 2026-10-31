# 31. Casper keeps an MCP server's key you type

Date: 2026-10-22. Status: accepted (merged 2026-10-22 in #474).

## Decision

A server added with `/mcp add`, or by asking in chat (`casper_mcp_add`), can need a key: a bearer token or an API key
header for a server at an address, or a secret environment variable for a program. Most servers need none, so the key
is optional:

```text
/mcp add docs --bearer https://mcp.example.com/mcp
/mcp add docs --api-key[=X-Token] https://mcp.example.com/mcp
/mcp add docs --key-env=DOCS_KEY npx -y @example/docs-mcp@1.2.0
```

Casper asks you for the value in its hidden prompt and saves it in `~/.casper/mcp-secrets.json`. When that server
connects, the value goes into its header or start environment. Before, the only way was a `${VAR}` in a hand-edited
`~/.casper/mcp.json` and a variable set in every shell that starts Casper.

This changes "Casper does not write credentials" (docs/MCP.md): it now saves a key you typed for a server you added,
as it already does for network logins.

## Guard rails

- The AI names only the kind of key (`bearer`, `api-key[:Header]`, `env:NAME`). The box after its call says
  `key … you type it next, hidden; the AI never sees it`, and only your typing in the hidden prompt fills it. Nothing
  is added when you type nothing; a run that can't ask writes nothing and gives the `/mcp add` line with the flag.
- The file is 0600, never a link or someone else's, and is on the private-places list, so the AI's tools and shell
  can't read it. Its values are hidden in everything the AI reads, as network logins are.
- `~/.casper/mcp.json` never holds the key, so the server's definition, its hash and its remembered approval don't
  change with it.
- The key goes only to the server of that name in your own `~/.casper/mcp.json`: never to a project file's, a
  profile's or an imported server of the same name, which could otherwise claim it by name.
- A key variable can't be one that changes how a program starts (`PATH`, `NODE_OPTIONS`, `LD_*`, `DYLD_*` and the
  like). An API key header can't be one the connection sets (`Host`, `Content-*`, `Mcp-*`, `Cookie`…) or
  `Authorization`, which `--bearer` sets.
- Over plain `http://` (this computer, or your own network after decision 32) Casper says before you type that the
  key crosses the network unencrypted.
- A server added again without a key forgets the old key of that name.
