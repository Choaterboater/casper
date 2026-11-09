# 97. An ACP app forks a Casper conversation

Date: 2026-11-09. Status: proposed. Extends 76 (Casper speaks ACP), 77, 89 and 91. An app that wants to try another
direction from an earlier point (edit a past message, branch a chat) had no way to do it over ACP: `session/load`
goes on with the same conversation, and `/branch` and `/rewind` are refused in the app (decision 80). The app also
could not name a point in the conversation, because Casper never said where a prompt ended.

## Decision

- **The mark.** Each `session/prompt` reply carries `_meta.casper.mark`: where the conversation ends after that
  prompt, the same point `/rewind` and undo use. A runtime with no marks, an empty conversation and a refused `/`
  command (it ran nothing) send none. It is Casper's own `_meta`: the reply is otherwise unchanged.
- **`session/fork`** (ACP's unstable fork, with `sessionCapabilities: { fork: {} }` in `initialize`) takes
  `{sessionId, cwd, mcpServers, _meta?}` and starts a new Casper process, as `session/new` does. That process copies
  the saved conversation `sessionId` into a new one and goes on with the copy: all of it, or, with
  `_meta.casper.at` set to a mark from a prompt reply, only up to that prompt. The reply is
  `{sessionId, configOptions, modes}` with the new ID; nothing is replayed, since the app already shows the
  conversation. The router sends the new ID's prompts, option changes, cancels, steers and idle checks to the new
  process, and the source keeps its own process if it has one.
- **The copy is the source's.** The fork goes on with the source's model and effort, over the app's start
  `--model`, for that session only, as a load does (decision 89). Hidden old tool output stays hidden in the copy,
  as for a resume (decision 12). Its name is the app's chat title, sent once after the reply, as a load sends it
  (decision 96).
- **The app's servers connect to the fork**, as for `session/new` and `session/load`: the app's own server, the ones
  it forwards and their `_meta` (decisions 77 and 89).
- **Errors.** An unknown conversation is -32002 with the load's words `No saved conversation <id> in <folder>`. A mark
  the conversation does not have is -32602, and no new conversation file is left. A runtime that can't fork answers
  -32601, so the app can fall back to `session/load` or `session/new`.

## Guard rails

- The source conversation is only read: the fork never resumes it, so the app's `--model` and the fork's later
  prompts never write into it. Its file is the same before and after.
- A fork while the source's own process is still answering copies the source's whole lines as they are then: a
  line still being written is left out, so the copy is a start of the source and loads. The fork reads that copy of
  the lines, never the source file itself, so the line being written is never cut.
- A fork's process starts as a new session's does: Ask first with no "Yes, for this session" answers, whatever the
  source's process had allowed (decision 91). A fork never widens what Casper may do.
- No new box, block or setting: forking is the app's own action, as opening a new chat is.
- A fork leaves one new conversation file, its copy, and a refused fork leaves none. The new conversation its process
  starts on, which the app's `--model` writes to disk, is removed either way.
- The mark is an entry ID of the conversation and never holds words, a path or a secret.

## A finding

A fork that changes the source's file, leaves any new file besides its copy, starts with the source process's session
answers or access, or opens without the app's servers.
