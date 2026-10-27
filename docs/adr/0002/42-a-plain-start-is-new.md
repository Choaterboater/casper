# 42. A plain start is a new conversation, with one row to continue the last

Date: 2026-10-27. Status: proposed.

## Decision

`casper` in a project's main folder starts a new conversation every time. Before, a folder whose `main` session had a
saved record (written by an interactive `/clear`, `/resume`, `/continue`, `--continue`, `--resume` or `/branch`)
reopened that conversation on every plain start, so some folders started fresh and others silently picked up an old
conversation, however long ago and however full.

When the folder has an earlier conversation with replies, the start offers one row:

```text
Next: 1 Continue the Oct 21 conversation (Fix the login bug · 12 messages)
  Anything you type starts a new conversation.
```

It works like the receipt's Next row: a lone `1` on the empty prompt runs `/continue` (the conversation `--continue`
picks), anything typed is the new conversation's first request, and Enter runs nothing.

## Why

Claude Code (`claude`, `claude -c`), Codex (`codex`, `codex resume`), Copilot CLI (`copilot`, `--continue`), Pi and
oh-my-pi (`--continue`) all start fresh and pick up only when asked. A start that sometimes resumes is a surprise, and a
long resumed conversation costs tokens on every request. The row keeps the way back one key away, without a flag to
remember.

## Unchanged

- `--continue`, `--resume`, `/continue` and `/resume`.
- A one-shot run starts its own conversation, as before.
- Starting inside a `/branch` experiment's worktree folder reopens that branch's conversation: the folder exists for it.
- Saved conversations are kept; `/resume` lists them.
