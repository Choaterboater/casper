# 114. An ACP app lists, resumes and closes Casper sessions

Date: 2026-11-17. Status: proposed. Extends 76 (Casper speaks ACP), 89, 91, 96 and 97. An app that runs `casper acp`
could open a conversation it already knew the ID of, but it could not ask which ones a folder has, so a chat history
made outside the app (in the terminal, or before the app was reinstalled) stayed out of its sidebar. Reopening one
always replayed every request, even when the app still showed them. And the only way to end a session was to end
`casper acp` with every other session in it, or wait for `_casper/idle`. ACP has a request for each of these:
`session/list`, `session/resume` and `session/close`, each advertised under `sessionCapabilities`. T3 Code, for one,
calls all three when an agent advertises them.

## Decision

- **`session/list`** (`sessionCapabilities.list`) takes `{cwd?, cursor?}` and is answered by the router from the
  saved conversation files: no session process starts, no model is called, nothing is written. The list is the
  conversations `/resume` lists for that folder (its project's top folder, where a session opened there keeps them),
  newest first, as `{sessionId, cwd, title, updatedAt}`: `cwd` is the folder asked about, where `session/load` or
  `session/resume` opens it; `title` is the conversation's name, or its first request, as `/resume` shows it, or
  null; `updatedAt` is when it was last saved. A conversation with no messages (a session the app opened and never
  used) is left out. No `cwd` is the folder `casper acp` started in; a folder that is not there lists nothing.
- **Pages of 50.** A longer list ends with `nextCursor`, an opaque value that holds only the last conversation's time
  and ID. The next page starts after that place in time, so a conversation saved between pages never repeats one the
  app has. A cursor that is not one Casper gave is -32602.
- **`session/resume`** (`sessionCapabilities.resume`) is `session/load` without the replay: the same new process, the
  conversation's own model and effort (decision 89), the app's servers, the chat title sent once after the reply
  (decision 96), and the reply `{configOptions, modes}`. A conversation that is already open is -32600, and one Casper
  does not have is -32002, as for a load.
- **`session/close`** (`sessionCapabilities.close`) takes `{sessionId}`. From that moment the session is unknown to
  the router: a later prompt, steer or idle check gets -32002. Its running prompt stops as `session/cancel` stops it,
  and its `cancelled` reply goes to the app before the close's `{}`. Then its process ends as Casper closes (its
  checks, services and the app's MCP servers stop): the router ends its input, waits up to 10 seconds for it to exit
  and then stops it, as it does for every session when `casper acp` ends. The reply comes once the process has gone,
  and the conversation can be opened again with `session/load` or `session/resume`; one the app sends before that
  reply (or a `session/fork` of it) waits until the old process has gone, so two processes never write one
  conversation. An unknown session is -32002.
- **No setting.** Listing, resuming and closing are the app's own actions, as opening a chat is. `acp_idle_exit`
  is about the app closing a Casper that sits idle; a close the app asks for is the app closing it, as ending its
  input already was (decision 91's finding).

## Guard rails

- What a session allowed for itself ends with its process (decision 91): "Yes, for this session" answers and the
  access mode the app or a typed `/permissions all` picked. A conversation reopened after a close starts at Ask first
  with no session yeses. A close never widens what Casper may do.
- A title in the list is hidden as the session's own chat title is: Casper's own secret values (its logins, typed
  secrets, secret-named environment values) and key-shaped values become `<secret hidden>`, also where the title's
  cut falls inside one. The list reads only the names and first requests Pi's own listing reads, never a whole
  conversation for the reply, and the cursor holds no words or path.
- The list is read only: a folder with nothing saved gets no session folder, as for `/resume`.
- A close waits at most 10 seconds for the stopped prompt's reply and 10 more for the process: an app's close never
  hangs `casper acp`.

## A finding

A `session/list` that starts a session process, calls a model, writes a file or shows a secret in a title; a list
that repeats a conversation across pages; a close that leaves the session's process running, answers before the
stopped prompt's reply, or lets the conversation reopen with the closed session's yeses or access, or in a second
process while the closed one still runs; a resume that replays the conversation.
