# 79. An ACP step carries its output

Date: 2026-11-06. Status: proposed. Extends 76 (Casper speaks ACP), 77 and 78. Over `casper acp` a tool step was its
name and target, then `completed` or `failed`; an app had nothing to draw a diff, a command's output or a search's
results from.

## Decision

Over ACP only, each of the AI's tool steps carries what it did, built from the runtime's own events
(`onRuntimeEvent`, right before the same event becomes a `--json` event), so the two keep their order.

- **Its start** (`tool_call`): `rawInput` is the model's own arguments (each string cut at a line past 64 KB, a shell
  command as Casper keeps it, its typed secrets hidden). `_meta.casper` names the tool and its target, a shell step's
  title, the MCP server and tool a call reaches (`call_capability` by its id), and a helper's role, goal and part.
  `locations` names the file an edit, a write or a read works on, by its absolute path. An edit starts with one diff
  per replacement.
- **Its end** (`tool_call_update`, `completed` or `failed`):
  - an edit: one diff per hunk of the patch the runtime applied, each with its first new line in `locations`, and
    `rawOutput: { path, added, removed }`;
  - a write: a diff from the old text (`null` for a new file) to the new, and `rawOutput: { path, added, removed,
    created }`;
  - bash and PowerShell: the output in a fence (64 KB, head and tail) and `rawOutput: { exitCode, truncated }`; the
    exit code is kept from the shell's report even when a later step replaces the output;
  - read: the text in a fence and `rawOutput: { path, offset, lines, totalLines, truncated, image }`;
  - grep: `rawOutput: { shape: "matches", files: [{ path, matches: [{ lineNumber, line }] }], total, truncated }`;
  - find and ls: `rawOutput: { shape: "paths", paths, total, truncated }`;
  - web_search its sources, web_fetch its address, status, title and text;
  - any other tool its text, when there is some. A failed step always carries its error text.
- No `terminal` content (the app says `terminal: false`), and no running output yet: a running command's card fills
  in when it ends.

## Guard rails

- Everything goes through the session's hiding (the `--json` redaction and your own secrets' exact values), names in
  the arguments included. Text is cut at whole lines before it is hidden, so a secret is never half shown.
- A file's text (a write's old and new text, an edit's sides, a read's preview, file text in the arguments) is not
  shown when it holds a secret by the rules a read of that file gets (`fileTextHoldsSecret`: the device-config pass for
  a config file, the always-on pass with the file's own kind), when the scrubber changed what the model read, or when
  the write adds a secret. A note says `Changed <file> (+a −r): not shown, it holds a secret` or `… it adds a secret
  at <where>`, and the arguments say `<not shown: …>`. That check runs at once with Casper's own rules. netconan can't
  run at once and may find a secret they miss, so while it is in use no device config's text is shown (`… not shown,
  netconan checks this device config only as the AI reads it`); a read's preview is the text netconan already checked.
- A diff side over 256 KB, a patch the runtime cut, and a write whose old file was too big or unreadable are a note
  (`… too large to show here`), never a diff that calls an existing file new.
- The redaction may change `name = value` lines inside a diff; safety wins over a faithful diff.
- `--json`, the screen and receipts are unchanged: the arguments and the display never reach them.
- An app built for decision 76 reads a step's tool from `rawInput.tool`, which is now the model's arguments; it shows
  generic cards until it reads `_meta.casper.tool` (the tool and target stay there).
