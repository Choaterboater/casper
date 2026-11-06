# 78. An ACP prompt carries pictures and files

Date: 2026-11-06. Status: proposed. Extends 76 (Casper speaks ACP) and 77. It replaces 76's "Not done yet" item
"images in prompts".

## Decision

- **`initialize` says `promptCapabilities: { image: true, audio: false, embeddedContext: true }`**, from the router and
  from each session.
- **A picture is a Ctrl+V picture.** An `image` block becomes `[image N]` in the request, in the order the blocks came,
  and goes to the run as a picture pasted in the terminal does: saved in the session's private folder (0700, files
  0600, deleted when the session closes) so the model has a path, and sent to the model when it can see pictures. Its
  type comes from its bytes. A prompt with only a picture is a request.
- **A file goes as its path.** A `resource_link` to a `file:` address becomes `Attached file <name> (<size>):
  "<path>"`, and Casper reads it with its own file tools, so the read tool's rules (private places included) hold. A
  path that ends in a picture extension is then attached by the terminal's quoted-path rule. On Windows a link to a
  picture on a share (`file://host/share/x.png`) becomes `\\host\share\x.png`, so the share box asks before it is
  opened. A link to any other file on a share (no box guards a read of one), and any other link, goes as its name and
  address.
- **Embedded text** (`resource` with `text`) goes with its address, up to 256 KB. Past that a `file:` one goes as its
  path, and any other is cut at a line with a note. A `blob` that is a picture is a picture; a `file:` blob goes as its
  path; anything else gets a note.
- **The picture question reaches the app.** When the model can't see pictures and a model you set up can, the
  terminal's question (`Send without it` · `Switch to <model> for this request`) goes to the client as
  `session/request_permission`, because a person answers there (`someoneAnswers`). Only a pick of the switch sends the
  picture; anything else, no answer included, sends the request without it. A one-shot or `--json` run still says so
  in one line.
- **Notes for the person.** A picture that was not sent (past the eighth, over 20 MB, not PNG, JPEG, GIF or WebP),
  audio and blocks Casper can't read each get one `[image] …` line, sent to the client as a message chunk after the
  model's text so far. They are Casper's own lines (`app.onOutput`), never the model's words. A prompt with no words
  and no picture is refused (-32602) with its notes.

## Guard rails

- At most 8 pictures and 20 MB each, the terminal's limits; a picture over the size is turned away before it is
  decoded. At most 256 KB of embedded text.
- No new switch: attaching a picture or a file is the person's own act in the app, as a paste is in the terminal.
- The picture question is the terminal's box with its words and its safe first choice. It is one box: the app adds
  none of its own for it.
- Every note goes through the session's hiding, a whole line at a time, like every other update.
- The Windows share box is kept for a picture on a share. Any other file on a share, and every share link on other
  systems, stays an address: the model is never handed a share path it could open with no box.

## Not done yet

The app's own model (its picker) does not decide here; Casper's model and its picture question do. Audio is not taken.
