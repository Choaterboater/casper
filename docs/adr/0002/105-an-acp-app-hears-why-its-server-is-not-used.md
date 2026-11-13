# 105. An ACP app hears why its server is not used

Date: 2026-11-13. Status: proposed. Extends 100 (an app's server for a product Casper already has) and 88 (an ACP app
shows Casper's notes), and changes where 100's note goes. Under 100 the app's server that Casper leaves out still
connects and shows as ready. Its note went only to stderr in `casper acp`, so the app's transcript never said why its
tools were missing. And `casper_session` listed the server as connected with nothing more, so the AI told the person
the app's network tools were there to use.

## Decision

- **The note is the person's.** `[acp] The app's MCP server acp-network is not used: Casper has its own Network
  server.` is a person note (decision 88): still written once per app server and session, and on stderr as before,
  and the app also gets it as a note. Written before a prompt, it is held and sent first in the next one, as a
  refused app server's note is.
- **`casper_session` says why.** In its `mcp` part a connected server carries `tools` (its tool count), or, for an
  app's server Casper leaves out, `notUsed` with the same reason `/mcp` shows (`Casper has its own Network server`)
  and no tool count. A server that isn't connected keeps its `state` and carries neither.

## Guard rails

- No other manager line changes where it goes: declined server questions and login notes stay where they were.
- The reason is Casper's own words, never the server's output, cut to 120 characters like the other text in
  `casper_session`.
- `tests/acp-notes.integration.test.ts` checks, against a real `casper acp`, that the note is the first update of the
  first prompt and is not sent again; `tests/casper-session-tool.test.ts` checks the `tools` and `notUsed` fields.
