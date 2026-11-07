# 88. An ACP app shows Casper's usage, its notes and the receipt's fields

Date: 2026-11-07. Status: proposed. Extends 76 (Casper speaks ACP), 78 and 79. In the terminal the footer shows how
full the context is and what the session cost, and Casper's own lines (the skills it picked, memory it could not read,
the spend note) sit in the transcript. Over `casper acp` an app saw none of them: its context ring stayed empty, and
those lines went only to stderr.

## Decision

- **`usage_update`** (standard ACP), once after each response of the main conversation:
  - `used` is the context the response left: its prompt (input, cache reads and cache writes) plus its output. When
    the provider did not split its count, it is the runtime's own context count.
  - `size` is the model's context window.
  - `cost` is `{amount, currency: "USD"}`: the session's catalog cost, as `/usage` shows it, this response included.
  - `_meta.casper` carries `response` (this response's `input`, `cacheRead`, `cacheWrite`, `output` and `tokens`,
    null when the provider left one out, and `toolUse`: the response ended in a tool call), `model` (`provider`,
    `model`) and `cost`: `charged` (OpenRouter's own figure), `estimate` (a catalog price), `subscription` or null.
  - It goes after the response's words and before its first step.
- **Notes are marked.** Casper's own lines in the chat (`[image]` and `[plan]` lines, an error, a refused command, and
  the ones below) carry `_meta.casper.note: true`. The model's words, its held planning words and command output do
  not.
- **More lines reach the app as notes**: the skills selected for a request, both `[memory]` lines, the "tool call as
  text" line, "Changed while planning", the checklist's "not made" and "kept" lines, a flow file's warnings, the spend
  note and the `[skills]` warnings line. One written while no prompt runs waits for the next prompt (at most 20).
- **A refused app server is said in the app.** The note for an app server Casper did not connect is the first update
  of the next prompt. A server that connects is said on stderr only.
- **The receipt's data** (`_meta.casper.receipt`) adds `usage` (the task's model use, as `--json`'s receipt has it),
  `cost` (the same kinds as above) and `root` (the folder the changed files are in).
- No `PromptResponse.usage`: it is unstable in the schema, and nothing reads it.

## Guard rails

- Everything goes through the session's hiding: the `--json` redaction, your own secrets and the client's server
  values. A skill name holding one is hidden.
- No cost under a subscription: there is no per-token price to show. A free model has none either.
- No `usage_update` for a model with no known context window, for a response that reported no usage, or for one that
  was cancelled or failed: its usage is a stream's start, the footer skips it too, and a held error's cost is already
  the session's. The app keeps the last figures.
- A helper's usage (an explorer, a reviewer, a builder) and the checklist call are not sent: the update is the main
  conversation's.
- Progress lines stay out: `• Casper checking`, `↻` rounds, the test-data line, Big job and "stopped, nothing changed"
  (the receipt says it). `[suggestions]` and `[project]` lines are already command output.
- A line that is a command's output before its model speaks is sent once, in the command's block.
- Casper's transcript on stderr, the terminal, `--json` and saved receipts are unchanged.
- An older app drops `usage_update` and the new `_meta` keys and shows notes as text.

## A finding

A cost under a subscription, an update without a window, a helper's usage, a progress line as a note, a note sent
twice, or a secret in any of them.
