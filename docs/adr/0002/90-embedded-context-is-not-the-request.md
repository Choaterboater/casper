# 90. Embedded context is not the request

Date: 2026-11-07. Status: proposed. Extends 78 (An ACP prompt carries pictures and files) and 76. An app can send text
with a request that is not a file: another chat the person mentions, an editor's buffer. Under 78 that text went with
the request whole, which is right for the model, but Casper also read it as what was asked. A mentioned chat that said
"fix the failing test and add tests" gave a question a checklist, and `/plan add a flag` with a mention planned the
mentioned chat's words as well as the typed goal.

## Decision

- **Context is marked.** Each embedded `resource` with `text` and no local file behind it (no `file:` address, or a
  Windows share link to a file that is not a picture) is context: the `${uri}\n${text}` piece 78 sends, or its cut. A
  `file:` embed, a `resource_link`, a picture and a blob are unchanged.
- **The model still reads it.** The request keeps the piece in its place, as 78 says.
- **It is not what was asked.** What Casper reads to choose a checklist or an offer before the work, and the
  checklist's cases, is the request without its context pieces, as it is without a pasted screen transcript today. A
  prompt that is only context asks for nothing, so it gets no checklist. With no context and no transcript the request
  is read whole, as before.
- **A `/` command takes only the person's words.** When the request without its context starts with `/` (and is not a
  picture file's path), that is the command line; the context is not passed to it. `/plan add a flag` with a mentioned
  chat plans only "add a flag", and a bare `/plan` with one reopens a plan as a bare `/plan` does. One note says the
  text did not go with the command and to send it without the `/` command for the AI to read it, as 78 says what
  was not sent. Pictures and files sent with a command still go as they did.

## Guard rails

- Nothing new reaches the model. A request that is no command keeps its context for the model; only what Casper
  reads to classify it leaves the context out. A `/` command leaves it out too, and never without its note.
- A `file:` embed stays part of what was asked, as an attached file is in the terminal.
- No new switch: what the app sends as context is the person's own act in the app, as a paste is in the terminal.

## Not done yet

A command does not get the context sent with it: `/plan` with a mentioned chat does not plan from that chat.
