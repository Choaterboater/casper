# 96. An ACP app gets Casper's chat title

Date: 2026-11-09. Status: proposed. Extends 76 (Casper speaks ACP) and 80. An app that runs `casper acp` names each
chat itself, and some name it by asking the app's own default model, which may not be one you picked for Casper. That
call costs tokens and time on every new chat. Casper already names each conversation from its first request, in plain
words and with no model call (the window title and `/resume` show it), but the app never heard that name.

## Decision

- **`session_info_update`**, from ACP's stable schema, with `title` and `updatedAt` (an ISO time). Casper sends it:
  - when the first request names the conversation, as its work starts, so the chat has its title while Casper
    works;
  - after the `session/new` or `session/load` reply (after the commands), when the conversation already has a name: a
    loaded one, or one `--continue` or `--resume` picked. The router holds it, as it holds the commands, until its own
    reply is out;
  - before the receipt, when a typed `/rename` gave it a new name.
- **Once per name.** A name the app was already told is never sent again, so a prompt that changes nothing sends
  nothing.
- **`_meta.casper.title: true`** in the initialize reply says Casper sends the title, so an app can skip its own
  naming call.
- **No model call and no setting.** The title is Casper's own plain-words rule (`src/tui/session-title.ts`). Whether
  to show it is the app's choice, with its own switch.
- `rename` stays out of the `/` menu (the app renames its chats); typed, it still runs and sends the new name.

## Guard rails

- The title goes through the session's hiding, as every other word does: a secret in the first request never
  reaches the app's chat list, also when the title cut it at 40 characters or took its last `!` or `.` off.
- Casper names nothing new for the app: the title is the conversation's stored name, the same one `/resume` lists.
  A name the app gives its chat stays the app's; Casper does not read it.
- `--json`, the terminal and receipts are unchanged.

## A finding

A title sent unhidden, sent again for a name the app already has, or made by a model call.
