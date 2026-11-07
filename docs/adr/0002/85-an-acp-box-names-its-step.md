# 85. An ACP box names its step and carries its diff

Date: 2026-11-07. Status: proposed. Extends 76 (Casper speaks ACP) and 79. Over `casper acp` a box was a step of its
own (`casper-approval-N`) with the box's words and nothing else. An app could not tell which of the AI's steps raised
it, and an edit outside the project asked "Allow it?" without the edit it would allow.

## Decision

- **The box names the step that raised it.** When a running tool step raises a box (an edit or a write outside the
  project or inside an app bundle, a command's "Run this command?" or "Reach <host>?", an MCP change), the box's
  pending `tool_call` and `session/request_permission.toolCall` carry `_meta.casper.step`: that step's ACP id
  (`casper-tool-N`). It is merged with the plan's labels (decision 84), never in their place.
- **It repeats the step's diffs and file.** `content` is the box's own text, if any, followed by the step's diffs as
  its start showed them (an edit's replacements, decision 79), and `locations` is the step's files.
- **A box outside any tool names none.** The plan's Build box, a check's box and the questions before the work keep
  the shape they had: their text only.
- **How the step is found.** The model's id of the running tool call is carried through its awaits (as MCP calls to
  an app's server already name their step, decision 77). The hooks that ask about an edit or a write, and the AI's
  bash, now run inside it as Casper's other tools do.
- Options, their kinds and order, the answers, the 30-minute wait, Read only's withdrawal and its No without a request
  are unchanged.

## Guard rails

- Only the start's diffs are copied, after the session's hiding (the `--json` redaction and your own secrets'
  values). An edit whose text holds a secret, or one only netconan may see, started with no diff, so its box gets none.
- A write gets no diff: its start shows none, and its old text is read only when it ends.
- A host the sandbox's proxy asks about ("A shell command wants to reach <host>") names no step: the proxy can't
  tell whose command reached out. It starts, and asks, outside any tool call, so it never keeps the id of the call
  whose command started it.
- A box several calls share (the sandbox's one write question for the same places) names the step that raised it
  first.
- The wait stays 30 minutes, and nothing in Casper answers the box.
- The terminal, `--json` and receipts are unchanged: only ACP reads the step.
