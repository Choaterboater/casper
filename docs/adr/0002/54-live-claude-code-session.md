# 54. One live Claude Code session per conversation

Date: 2026-11-02. Status: proposed. Reverses the per-request replay in `subscriptionPrompt` (`claude-subscription`).

## Decision

- With the `claude-subscription` provider, a conversation's requests go to one live Claude Code session, not one new
  Claude Code query per request. Claude Code keeps the turns, its thinking included.
- Casper still runs every tool. Claude Code sees Casper's tools only as declarations on an in-process MCP server. When
  the model calls one, the turn's proposals go back to Pi, which runs them through Casper's normal approval, sandbox
  and checks, and Claude Code's waiting call is answered with the result Casper's tool gave. Claude Code's own tools
  stay off (`tools: []`), and `canUseTool` refuses anything that is not a declared Casper tool.
- A request goes on in the open session only when it continues it exactly: the session's messages first, then either
  the results of exactly the calls it proposed, or one new user message. Anything else starts a new session seeded
  with the visible conversation as labelled text, as every request was before:
  - **Compaction** replaces old messages with a summary, so the next request no longer starts with the session's
    messages; the new session is seeded from the compacted conversation.
  - **A fork or `--continue`/resume** is a new conversation or a new Casper process with no open session; the first
    request seeds one from the saved conversation.
  - **A steering message or a retry** after the session's last turn closes that session, and the request seeds a new
    one. **An edited history, or other tools, instructions, model or effort** don't continue it either: the request
    seeds a new session, and the old one closes after 15 idle minutes or when a fifth is opened.
  - **Claude Code ending between turns** (a crash, its own limit) before the request's turn starts: the session is
    closed and the same request seeds a new one.
- Sessions are not saved by Claude Code (`persistSession: false`); Casper's saved conversation stays the only record.
  Each Casper runtime holds at most four, closes one after 15 idle minutes, and closes all when it ends; a process
  exit closes any left.

## Why

The replay design ("Replaying a labelled transcript avoids editing Claude Code's private session files and works
after compaction, forks and restarts") sent the whole conversation as one user message on every request, with one
model turn each. In the owner's comparison against omp (Haiku 5.5, medium effort, the same prompt), Casper used
166–250k output tokens against omp's 86k. Most of it was hidden thinking: each replayed request is a fresh look at the
whole transcript, so the model reviewed and planned the task again before every write, 40–85k output tokens for a
single write turn against omp's 11k. Leaving written file contents out of the replay (#569) cut some of it; leaving
reads out made the model read the same files again and again. In a live session the model goes on from its own turn
and thinking: in an 8-turn smoke run of the same build, every turn ran in one session, with 157 to 6,550 output tokens
per turn and about 20k in all.

The reasons for replay still hold, and this keeps them: Claude Code's private session files are never edited, read
or resumed, and compaction, forks and restarts work because a request that doesn't continue a session seeds a new
one from Casper's transcript.

## Guard rails

- No credentials are copied into Casper, and none of Casper's are given to Claude Code. The child's environment still
  has API keys, endpoint overrides and cloud-provider switches removed; user and project Claude settings and inherited
  MCP servers are not loaded.
- No API-key fallback: every new session checks Claude Code's reported account before the first message is sent,
  and an API-key, gateway or unknown plan is refused, as before.
- Claude Code never runs a tool. Its tool list is empty, the proposal server only answers with results Casper's tools
  gave, and a call beyond the ones the model's turn proposed is answered with an error.
- Each call gets its own proposal's result: Claude Code names the tool_use each call is for, so parallel calls, and
  calls made before Casper has read the turn, are never answered with another call's result.
- An aborted request, a failed turn or a side request with no tools leaves no session open, and Claude Code's process
  never keeps Casper running after it ends.
- Windows: the same native `claude.exe` and the same SDK transport as before.

A finding: Claude Code running a tool itself; a call answered with another call's result; a session continuing after the conversation went another way
(compaction, a fork, an edit); a request sent to Claude Code before its account was checked; Claude Code's process
outliving Casper; Claude Code's session files written or resumed.
